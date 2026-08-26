// Servidor del POS: API REST + tiempo real (Socket.IO) + archivos de la app web.
// Corre en el PC del restaurante; los teléfonos entran por la LAN a http://<ip-del-pc>:3000
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const { db, ahora, jornadaHoy, horaLocal, getConfig, setConfig, getConfigAll, registrarHistorial, jornadaCerrada } = require('./db');
const { ticketCocina, ticketNomina, ticketFactura, ticketAccesoQR } = require('./escpos');
const impresion = require('./printing');
const reportes = require('./reports');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
impresion.setIO(io);

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- Sesiones y autenticación por PIN ----------
const sesiones = new Map(); // token -> { usuarioId, nombre, rol }
const intentosFallidos = new Map(); // ip -> { n, bloqueadoHasta }
const NIVEL = { cocinera: 0, mesero: 1, cajero: 2, admin: 3 };

function usuarioDeToken(token) { return token ? sesiones.get(token) : null; }

function requiere(nivelMinimo) {
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const u = usuarioDeToken(token);
    if (!u) return res.status(401).json({ error: 'Sesión no válida. Inicie sesión de nuevo.' });
    if (NIVEL[u.rol] < nivelMinimo) return res.status(403).json({ error: 'Su rol no tiene permiso para esta operación.' });
    req.usuario = u;
    next();
  };
}

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const bloqueo = intentosFallidos.get(ip);
  if (bloqueo && bloqueo.bloqueadoHasta > Date.now()) {
    const seg = Math.ceil((bloqueo.bloqueadoHasta - Date.now()) / 1000);
    return res.status(429).json({ error: `Demasiados intentos. Espere ${seg} segundos.` });
  }
  const pin = String(req.body.pin || '');
  const u = db.prepare('SELECT * FROM usuarios WHERE pin = ? AND activo = 1').get(pin);
  // La cocinera existe solo para nómina: no tiene acceso a la app
  if (!u || u.rol === 'cocinera') {
    const reg = intentosFallidos.get(ip) || { n: 0, bloqueadoHasta: 0 };
    reg.n++;
    if (reg.n >= 5) { reg.bloqueadoHasta = Date.now() + 30000; reg.n = 0; }
    intentosFallidos.set(ip, reg);
    return res.status(401).json({ error: 'PIN incorrecto' });
  }
  intentosFallidos.delete(ip);
  const token = crypto.randomBytes(24).toString('hex');
  sesiones.set(token, { usuarioId: u.id, nombre: u.nombre, rol: u.rol });
  res.json({ token, usuario: { id: u.id, nombre: u.nombre, rol: u.rol } });
});

app.post('/api/logout', requiere(1), (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  sesiones.delete(token);
  res.json({ ok: true });
});

// ---------- Datos en vivo compartidos ----------
function platosActivos() {
  return db.prepare('SELECT * FROM platos WHERE activo = 1 ORDER BY categoria, nombre').all();
}
function pedidosDeJornada(jornada) {
  const pedidos = db.prepare(
    `SELECT p.*, u.nombre AS vendedor,
            (SELECT COUNT(*) FROM pagos WHERE pedido_id = p.id) AS pagado
     FROM pedidos p JOIN usuarios u ON u.id = p.vendedor_id
     WHERE p.jornada = ? ORDER BY p.numero_comanda DESC`).all(jornada);
  const itemsStmt = db.prepare('SELECT * FROM pedido_items WHERE pedido_id = ?');
  for (const p of pedidos) p.items = itemsStmt.all(p.id);
  return pedidos;
}
function emitirMenu() { io.emit('menu:actualizado', platosActivos()); }
function emitirPedidos() { io.emit('pedidos:actualizado', pedidosDeJornada(jornadaHoy())); }

app.get('/api/estado', requiere(1), (req, res) => {
  res.json({
    usuario: req.usuario,
    jornada: jornadaHoy(),
    jornadaCerrada: jornadaCerrada(jornadaHoy()),
    platos: platosActivos(),
    pedidos: pedidosDeJornada(jornadaHoy()),
    impresion: impresion.estadoCola(),
    nominaPendienteMia: pendientesNominaDe(req.usuario.usuarioId),
    configPublica: {
      nombre_restaurante: getConfig('nombre_restaurante'),
      recargo_empaque: Number(getConfig('recargo_empaque')),
      chips_notas: chipsActuales(),
      recargo_tarjeta_fijo: Number(getConfig('recargo_tarjeta_fijo')),
      recargo_tarjeta_umbral: Number(getConfig('recargo_tarjeta_umbral')),
      recargo_tarjeta_pct: Number(getConfig('recargo_tarjeta_pct'))
    }
  });
});

// ---------- Menú ----------
app.get('/api/platos', requiere(1), (_req, res) => res.json(platosActivos()));

const TIPOS_PLATO = ['entrada', 'proteina_dia', 'proteina_especial', 'bebida', 'extra'];

// Pre-renderiza los nombres del menú como imagen x3 para que la comanda salga sin espera
function precalentarMenu() {
  setTimeout(() => {
    try {
      const nombres = platosActivos().map(p => (p.acronimo || p.nombre).toUpperCase());
      const alto = Math.round(24 * Number(getConfig('tamano_platos') || 3));
      if (alto > 24) require('./texto-bitmap').precalentar(nombres, alto, { centrar: false });
    } catch (e) { console.error('[raster] precalentamiento falló:', e.message); }
  }, 1500);
}

app.post('/api/platos', requiere(1), (req, res) => {
  const { nombre, precio, categoria, tipo } = req.body;
  // Las entradas van incluidas en el precio del almuerzo: se permiten en $0
  const precioMin = (tipo === 'entrada' || tipo === 'bebida') ? 0 : 1;
  if (!nombre || !(Number(precio) >= precioMin)) return res.status(400).json({ error: 'Nombre y precio válido son obligatorios' });
  if (!TIPOS_PLATO.includes(tipo)) return res.status(400).json({ error: 'Tipo de plato no válido' });
  const precioSolo = req.body.precio_solo !== undefined && String(req.body.precio_solo).trim() !== ''
    ? Math.round(Number(req.body.precio_solo)) || null : null;
  const acronimo = String(req.body.acronimo || '').trim().slice(0, 14).toUpperCase() || null;
  const r = db.prepare('INSERT INTO platos (nombre, precio, categoria, tipo, precio_solo, acronimo) VALUES (?, ?, ?, ?, ?, ?)')
    .run(String(nombre).trim(), Math.round(Number(precio)), categoria || 'General', tipo, precioSolo, acronimo);
  emitirMenu();
  precalentarMenu();
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/platos/:id', requiere(1), (req, res) => {
  const plato = db.prepare('SELECT * FROM platos WHERE id = ? AND activo = 1').get(req.params.id);
  if (!plato) return res.status(404).json({ error: 'Plato no encontrado' });
  const nombre = req.body.nombre !== undefined ? String(req.body.nombre).trim() : plato.nombre;
  const precio = req.body.precio !== undefined ? Math.round(Number(req.body.precio)) : plato.precio;
  const categoria = req.body.categoria !== undefined ? req.body.categoria : plato.categoria;
  const tipo = req.body.tipo !== undefined ? req.body.tipo : plato.tipo;
  const disponible = req.body.disponible !== undefined ? (req.body.disponible ? 1 : 0) : plato.disponible;
  if (!TIPOS_PLATO.includes(tipo)) return res.status(400).json({ error: 'Tipo de plato no válido' });
  if (!nombre || !(precio >= ((tipo === 'entrada' || tipo === 'bebida') ? 0 : 1))) return res.status(400).json({ error: 'Datos de plato no válidos' });
  let precioSolo = plato.precio_solo;
  if (req.body.precio_solo !== undefined) {
    precioSolo = String(req.body.precio_solo).trim() === '' ? null : (Math.round(Number(req.body.precio_solo)) || null);
  }
  let acronimo = plato.acronimo;
  if (req.body.acronimo !== undefined) {
    acronimo = String(req.body.acronimo).trim().slice(0, 14).toUpperCase() || null;
  }
  db.prepare('UPDATE platos SET nombre = ?, precio = ?, categoria = ?, tipo = ?, disponible = ?, precio_solo = ?, acronimo = ? WHERE id = ?')
    .run(nombre, precio, categoria, tipo, disponible, precioSolo, acronimo, plato.id);
  emitirMenu();
  precalentarMenu();
  res.json({ ok: true });
});

app.delete('/api/platos/:id', requiere(1), (req, res) => {
  db.prepare('UPDATE platos SET activo = 0 WHERE id = ?').run(req.params.id);
  emitirMenu();
  res.json({ ok: true });
});

// ---------- Pedidos ----------
function validarJornadaAbierta(res) {
  if (jornadaCerrada(jornadaHoy())) {
    res.status(409).json({ error: 'La jornada ya tiene cierre de caja: no se admiten más operaciones hoy.' });
    return false;
  }
  return true;
}

function armarItems(itemsBody) {
  const buscarPlato = db.prepare('SELECT * FROM platos WHERE id = ? AND activo = 1');
  const items = [];
  for (const it of itemsBody || []) {
    const plato = buscarPlato.get(it.plato_id);
    if (!plato) throw new Error('Uno de los platos ya no existe en el menú');
    if (!plato.disponible) throw new Error(`El plato "${plato.nombre}" no está visible en el menú de hoy`);
    const cantidad = Math.max(1, Math.round(Number(it.cantidad) || 1));
    // La nota puede traer "chips\nobservaciones": el \n inicial es significativo,
    // así que solo se descarta si no tiene ningún contenido real.
    const nota = (it.nota || '').trim() ? it.nota.replace(/\s+$/, '') : null;
    const bloque = Number.isInteger(it.bloque) ? it.bloque : null;
    // "solo": plato del día vendido por fuera del almuerzo completo, a su precio propio
    const solo = it.solo ? 1 : 0;
    if (solo && !(plato.precio_solo > 0)) throw new Error(`"${plato.nombre}" no tiene precio para venderse solo`);
    items.push({ plato_nombre: plato.nombre, precio: solo ? plato.precio_solo : plato.precio, cantidad, nota, bloque, solo });
  }
  if (!items.length) throw new Error('El pedido no tiene platos');
  return items;
}

function opcionesTicket() {
  return {
    ancho: getConfig('ancho_ticket'), hora: horaLocal(),
    tamPlatos: getConfig('tamano_platos'), tamObs: getConfig('tamano_obs')
  };
}

function imprimirPedido(pedidoId, tipo) {
  const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(pedidoId);
  // El tipo del plato viaja al ticket para ordenar: entradas, proteínas, bebidas, extras
  const items = db.prepare(
    `SELECT pi.*,
            (SELECT pl.tipo FROM platos pl WHERE pl.nombre = pi.plato_nombre ORDER BY pl.activo DESC, pl.id DESC LIMIT 1) AS tipo,
            (SELECT pl.acronimo FROM platos pl WHERE pl.nombre = pi.plato_nombre ORDER BY pl.activo DESC, pl.id DESC LIMIT 1) AS acronimo
     FROM pedido_items pi WHERE pi.pedido_id = ?`).all(pedidoId);
  const ticket = ticketCocina(pedido, items, tipo, opcionesTicket());
  impresion.encolar(pedidoId, tipo, ticket);
}

// Recargo por pago con tarjeta: fijo bajo el umbral, porcentaje desde el umbral
function recargoTarjetaDe(metodo, monto) {
  if (metodo !== 'tarjeta') return 0;
  const fijo = Number(getConfig('recargo_tarjeta_fijo')) || 0;
  const umbral = Number(getConfig('recargo_tarjeta_umbral')) || 0;
  const pct = Number(getConfig('recargo_tarjeta_pct')) || 0;
  return monto < umbral ? fijo : Math.round(monto * pct / 100);
}

// El valor del domicilio lo define el mesero por pedido (depende de la distancia);
// si no manda nada, se usa el valor por defecto configurado
function calcRecargoDomicilio(tipoEntrega, valor) {
  if (tipoEntrega !== 'llevar') return 0;
  const v = Number(valor);
  return Number.isFinite(v) && String(valor).trim() !== '' ? Math.max(0, Math.round(v)) : Number(getConfig('recargo_empaque'));
}

function chipsActuales() {
  try { return JSON.parse(getConfig('chips_notas') || '[]'); } catch { return []; }
}

function pendientesNominaDe(usuarioId) {
  return db.prepare(
    `SELECT n.*, u.nombre AS empleado FROM nomina n JOIN usuarios u ON u.id = n.empleado_id
     WHERE n.empleado_id = ? AND n.estado = 'pendiente' ORDER BY n.id`).all(usuarioId);
}

app.post('/api/pedidos', requiere(1), (req, res) => {
  if (!validarJornadaAbierta(res)) return;
  const { uuid, comensal, tipo_entrega, items: itemsBody, imprimir, recargo_domicilio } = req.body;
  // Idempotencia: si el WiFi se cayó y la app reintenta, no se duplica la comanda
  if (uuid) {
    const existente = db.prepare('SELECT id, numero_comanda FROM pedidos WHERE uuid = ?').get(uuid);
    if (existente) return res.json({ id: existente.id, numero_comanda: existente.numero_comanda, duplicado: true });
  }
  if (!comensal || !String(comensal).trim()) return res.status(400).json({ error: 'El nombre del comensal es obligatorio' });
  let items;
  try { items = armarItems(itemsBody); } catch (e) { return res.status(400).json({ error: e.message }); }

  // Pago express: método elegido al tomar el pedido (flujo de plazoleta: se paga al ordenar).
  // Lo puede registrar cualquier rol porque es parte de la toma del pedido.
  const pagoExpress = req.body.pago_express && req.body.pago_express.metodo ? req.body.pago_express : null;
  if (pagoExpress && !['efectivo', 'tarjeta', 'nequi', 'daviplata', 'qr_bancolombia', 'billetera'].includes(pagoExpress.metodo)) {
    return res.status(400).json({ error: 'Método de pago express no válido' });
  }

  const jornada = jornadaHoy();
  const recargo = calcRecargoDomicilio(tipo_entrega, recargo_domicilio);
  const total = items.reduce((s, i) => s + i.precio * i.cantidad, 0) + recargo;
  const recTarjeta = pagoExpress ? recargoTarjetaDe(pagoExpress.metodo, total) : 0;
  const totalCobrar = total + recTarjeta;
  if (pagoExpress && pagoExpress.metodo === 'efectivo' && pagoExpress.recibido &&
      Math.round(Number(pagoExpress.recibido)) < totalCobrar) {
    return res.status(400).json({ error: 'El monto recibido es menor al total' });
  }

  const uuidFinal = uuid || crypto.randomUUID();
  const crear = db.transaction(() => {
    const num = db.prepare('SELECT COALESCE(MAX(numero_comanda), 0) + 1 AS n FROM pedidos WHERE jornada = ?').get(jornada).n;
    const r = db.prepare(
      `INSERT INTO pedidos (uuid, numero_comanda, jornada, comensal, tipo_entrega, vendedor_id, recargo, total, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(uuidFinal, num, jornada, String(comensal).trim(), tipo_entrega === 'llevar' ? 'llevar' : 'mesa',
           req.usuario.usuarioId, recargo, total, ahora());
    const insItem = db.prepare('INSERT INTO pedido_items (pedido_id, plato_nombre, precio, cantidad, nota, bloque, solo) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const it of items) insItem.run(r.lastInsertRowid, it.plato_nombre, it.precio, it.cantidad, it.nota, it.bloque, it.solo);
    return { id: r.lastInsertRowid, numero_comanda: num };
  });
  const creado = crear();
  // (sin nombre del cliente en el historial, por privacidad)
  registrarHistorial(creado.id, req.usuario.usuarioId, 'crear', `Comanda ${creado.numero_comanda}`);

  let vueltas = null;
  if (pagoExpress) {
    let recibido = null;
    if (pagoExpress.metodo === 'efectivo') {
      recibido = pagoExpress.recibido ? Math.round(Number(pagoExpress.recibido)) : totalCobrar;
      vueltas = recibido - totalCobrar;
    }
    db.prepare('INSERT INTO pagos (pedido_id, metodo, monto, recibido, vueltas, recargo_tarjeta, cajero_id, jornada, creado_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(creado.id, pagoExpress.metodo, totalCobrar, recibido, vueltas, recTarjeta, req.usuario.usuarioId, jornada, ahora());
    registrarHistorial(creado.id, req.usuario.usuarioId, 'pago', `${pagoExpress.metodo} por ${totalCobrar} (express)`);
    const pedidoCompleto = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(creado.id);
    reportes.encolarVentaSheets(pedidoCompleto, items.map(i => ({ cantidad: i.cantidad, plato_nombre: i.plato_nombre })),
      { metodo: pagoExpress.metodo, creado_en: ahora(), recargo_tarjeta: recTarjeta }, req.usuario.nombre);
    reportes.drenarSheets().catch(() => {});
  }

  // Los pedidos de solo extras (una gaseosa, un postre) pueden no necesitar comanda en cocina
  if (imprimir !== false) imprimirPedido(creado.id, 'comanda');
  emitirPedidos();
  // Aviso a todos los dispositivos conectados de que el PC recibió y guardó el pedido
  io.emit('pedido:guardado', {
    uuid: uuidFinal,
    numero_comanda: creado.numero_comanda,
    comensal: String(comensal).trim(),
    vendedor: req.usuario.nombre,
    pagado: !!pagoExpress
  });
  res.json({ ...creado, vueltas, recargo_tarjeta: recTarjeta, total_cobrado: pagoExpress ? totalCobrar : null, impreso: imprimir !== false });
});

app.put('/api/pedidos/:id', requiere(1), (req, res) => {
  if (!validarJornadaAbierta(res)) return;
  const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (pedido.estado !== 'en_proceso') return res.status(409).json({ error: 'Solo se pueden editar pedidos en proceso' });
  if (db.prepare('SELECT id FROM pagos WHERE pedido_id = ?').get(pedido.id)) {
    return res.status(409).json({ error: 'El pedido ya está pagado; no se puede editar' });
  }
  const { comensal, tipo_entrega, items: itemsBody, recargo_domicilio } = req.body;
  let items;
  try { items = armarItems(itemsBody); } catch (e) { return res.status(400).json({ error: e.message }); }
  const tipo = tipo_entrega === 'llevar' ? 'llevar' : 'mesa';
  const recargo = calcRecargoDomicilio(tipo, recargo_domicilio);
  const total = items.reduce((s, i) => s + i.precio * i.cantidad, 0) + recargo;

  const actualizar = db.transaction(() => {
    // La venta conserva la atribución al vendedor original (vendedor_id no se toca)
    db.prepare('UPDATE pedidos SET comensal = ?, tipo_entrega = ?, recargo = ?, total = ?, actualizado_en = ? WHERE id = ?')
      .run(String(comensal || pedido.comensal).trim(), tipo, recargo, total, ahora(), pedido.id);
    db.prepare('DELETE FROM pedido_items WHERE pedido_id = ?').run(pedido.id);
    const insItem = db.prepare('INSERT INTO pedido_items (pedido_id, plato_nombre, precio, cantidad, nota, bloque, solo) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const it of items) insItem.run(pedido.id, it.plato_nombre, it.precio, it.cantidad, it.nota, it.bloque, it.solo);
  });
  actualizar();
  registrarHistorial(pedido.id, req.usuario.usuarioId, 'editar', `Comanda ${pedido.numero_comanda} modificada por ${req.usuario.nombre}`);
  imprimirPedido(pedido.id, 'actualizacion');
  emitirPedidos();
  res.json({ ok: true });
});

app.post('/api/pedidos/:id/cancelar', requiere(1), (req, res) => {
  if (!validarJornadaAbierta(res)) return;
  const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (pedido.estado === 'cancelado') return res.status(409).json({ error: 'El pedido ya está cancelado' });
  const pago = db.prepare('SELECT * FROM pagos WHERE pedido_id = ?').get(pedido.id);
  if (pago) {
    // Anular una comanda ya pagada implica devolver la plata: solo cajero o admin
    if (NIVEL[req.usuario.rol] < 2) {
      return res.status(403).json({ error: 'La comanda ya está pagada: solo el cajero o el administrador pueden anularla' });
    }
    db.prepare('DELETE FROM pagos WHERE pedido_id = ?').run(pedido.id);
    registrarHistorial(pedido.id, req.usuario.usuarioId, 'pago_devuelto', `${pago.metodo} por ${pago.monto}`);
  }
  db.prepare("UPDATE pedidos SET estado = 'cancelado', cancelado_en = ? WHERE id = ?").run(ahora(), pedido.id);
  registrarHistorial(pedido.id, req.usuario.usuarioId, 'cancelar', `Comanda ${pedido.numero_comanda} cancelada por ${req.usuario.nombre}`);
  imprimirPedido(pedido.id, 'anulacion'); // cocina trabaja con papel: aviso impreso de anulación
  emitirPedidos();
  res.json({ ok: true });
});

app.post('/api/pedidos/:id/entregar', requiere(1), (req, res) => {
  const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (pedido.estado !== 'en_proceso') return res.status(409).json({ error: 'El pedido no está en proceso' });
  db.prepare("UPDATE pedidos SET estado = 'entregado', entregado_en = ? WHERE id = ?").run(ahora(), pedido.id);
  registrarHistorial(pedido.id, req.usuario.usuarioId, 'entregar', `Comanda ${pedido.numero_comanda} entregada`);
  emitirPedidos();
  res.json({ ok: true });
});

app.post('/api/pedidos/:id/reimprimir', requiere(1), (req, res) => {
  const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  imprimirPedido(pedido.id, 'reimpresion');
  registrarHistorial(pedido.id, req.usuario.usuarioId, 'reimprimir', `Comanda ${pedido.numero_comanda}`);
  res.json({ ok: true });
});

// ---------- Pagos (cajero o admin) ----------
app.post('/api/pedidos/:id/pago', requiere(2), (req, res) => {
  if (!validarJornadaAbierta(res)) return;
  const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (pedido.estado === 'cancelado') return res.status(409).json({ error: 'No se puede cobrar un pedido cancelado' });
  if (db.prepare('SELECT id FROM pagos WHERE pedido_id = ?').get(pedido.id)) {
    return res.status(409).json({ error: 'El pedido ya tiene un pago registrado' });
  }
  const metodo = req.body.metodo;
  if (!['efectivo', 'tarjeta', 'nequi', 'daviplata', 'qr_bancolombia', 'tarjeta_debito', 'tarjeta_credito', 'billetera'].includes(metodo)) {
    return res.status(400).json({ error: 'Método de pago no válido' });
  }
  const recTarjeta = recargoTarjetaDe(metodo, pedido.total);
  const totalCobrar = pedido.total + recTarjeta;
  let recibido = null, vueltas = null;
  if (metodo === 'efectivo') {
    recibido = Math.round(Number(req.body.recibido));
    if (!(recibido >= totalCobrar)) return res.status(400).json({ error: 'El monto recibido es menor al total' });
    vueltas = recibido - totalCobrar;
  }
  db.prepare('INSERT INTO pagos (pedido_id, metodo, monto, recibido, vueltas, recargo_tarjeta, cajero_id, jornada, creado_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(pedido.id, metodo, totalCobrar, recibido, vueltas, recTarjeta, req.usuario.usuarioId, pedido.jornada, ahora());
  registrarHistorial(pedido.id, req.usuario.usuarioId, 'pago', `${metodo} por ${totalCobrar}`);
  const items = db.prepare('SELECT * FROM pedido_items WHERE pedido_id = ?').all(pedido.id);
  const vendedor = db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(pedido.vendedor_id).nombre;
  reportes.encolarVentaSheets(pedido, items, { metodo, creado_en: ahora(), recargo_tarjeta: recTarjeta }, vendedor);
  reportes.drenarSheets().catch(() => {}); // intento inmediato; si no hay internet queda en búfer
  emitirPedidos();
  res.json({ ok: true, vueltas, recargo_tarjeta: recTarjeta, total_cobrado: totalCobrar });
});

// ---------- Reportes y cierre (cajero o admin) ----------
app.get('/api/reportes/dia', requiere(2), (req, res) => {
  res.json(reportes.resumenJornada(req.query.jornada || jornadaHoy()));
});

// Excel (.xlsx) con todas las comandas del día: columnas separadas por tipo
// (Entrada/Proteína/Bebida/Extras) para poder filtrar, método de pago para
// cuadrar contra Nequi/Daviplata/datáfono, y totales por método en otra hoja.
const ETIQUETAS_METODO = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', nequi: 'Nequi', daviplata: 'Daviplata',
  qr_bancolombia: 'QR Bancolombia', tarjeta_debito: 'Tarjeta débito', tarjeta_credito: 'Tarjeta crédito', billetera: 'Billetera' };
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

function enviarXlsx(res, libro, nombre) {
  const XLSX = require('xlsx');
  const buf = XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=${nombre}`);
  res.send(buf);
}

function hojaConFiltro(XLSX, filas, anchos) {
  const ws = XLSX.utils.aoa_to_sheet(filas);
  if (filas.length > 1) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: filas.length - 1, c: filas[0].length - 1 } }) };
  if (anchos) ws['!cols'] = anchos.map(w => ({ wch: w }));
  return ws;
}

app.get('/api/reportes/excel', requiere(1), (req, res) => {
  const XLSX = require('xlsx');
  const jornada = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.jornada || '')) ? req.query.jornada : jornadaHoy();
  const resumen = reportes.resumenJornada(jornada);
  const fmtCop = (n) => Number(n || 0);

  // --- Hoja 1: Resumen del día (ingresos y egresos, para todos los empleados) ---
  const filasResumen = [
    ['RESUMEN DEL DIA', jornada],
    [],
    ['INGRESOS', ''],
    ['Almuerzos completos (cantidad)', resumen.numAlmuerzos],
    ['Almuerzos completos ($)', fmtCop(resumen.totalAlmuerzos)],
    ['Sueltos y extras ($)', fmtCop(resumen.totalExtras)],
    ['Domicilios cobrados', fmtCop(resumen.totalRecargos)],
    ['TOTAL GENERAL VENDIDO', fmtCop(resumen.totalVentas)],
    ['Recargos por tarjeta', fmtCop(resumen.totalRecargoTarjeta)],
    ['Total cobrado', fmtCop(resumen.totalCobrado)],
    [],
    ['POR METODO DE PAGO', '']
  ];
  for (const [m, v] of Object.entries(resumen.porMetodo)) {
    filasResumen.push([ETIQUETAS_METODO[m] || m, fmtCop(v)]);
  }
  filasResumen.push([]);
  filasResumen.push(['EGRESOS', '']);
  filasResumen.push(['Gastos del local', fmtCop(resumen.totalGastos)]);
  filasResumen.push(['Nomina pagada', fmtCop(resumen.totalNomina)]);
  filasResumen.push([]);
  filasResumen.push(['EFECTIVO ESPERADO EN CAJA', fmtCop(resumen.efectivoEsperado)]);
  filasResumen.push(['(ventas en efectivo menos gastos y nomina)', '']);

  // --- Hoja 2: Ventas en detalle ---
  const pedidos = db.prepare(
    `SELECT p.*, u.nombre AS vendedor, pg.metodo, pg.monto AS cobrado, pg.recargo_tarjeta, pg.creado_en AS pagado_en
     FROM pedidos p JOIN usuarios u ON u.id = p.vendedor_id
     LEFT JOIN pagos pg ON pg.pedido_id = p.id
     WHERE p.jornada = ? ORDER BY p.numero_comanda`).all(jornada);
  const itemsDe = db.prepare(
    `SELECT pi.*, (SELECT pl.tipo FROM platos pl WHERE pl.nombre = pi.plato_nombre ORDER BY pl.activo DESC, pl.id DESC LIMIT 1) AS tipo
     FROM pedido_items pi WHERE pi.pedido_id = ?`);
  const filasVentas = [['Comanda', 'Hora', 'Vendedor', 'Entrega', 'Entrada', 'Proteína', 'Bebida', 'Extras',
    'Método de pago', 'Domicilio', 'Recargo tarjeta', 'Estado', 'Total']];
  for (const p of pedidos) {
    const porTipo = { entrada: [], proteina: [], bebida: [], extra: [] };
    for (const it of itemsDe.all(p.id)) {
      const clave = it.tipo === 'entrada' ? 'entrada'
        : (it.tipo === 'proteina_dia' || it.tipo === 'proteina_especial') ? 'proteina'
        : it.tipo === 'bebida' ? 'bebida' : 'extra';
      porTipo[clave].push(`${it.cantidad > 1 ? it.cantidad + 'x ' : ''}${it.plato_nombre}${it.solo ? ' (solo)' : ''}`);
    }
    const estado = p.estado === 'cancelado' ? 'ANULADA' : (p.metodo ? 'PAGADA' : 'POR COBRAR');
    const hora = ((p.pagado_en || p.creado_en) || '').slice(11, 16);
    filasVentas.push([p.numero_comanda, hora, p.vendedor, p.tipo_entrega === 'llevar' ? 'Domicilio' : 'Mesa',
      porTipo.entrada.join(' | '), porTipo.proteina.join(' | '), porTipo.bebida.join(' | '), porTipo.extra.join(' | '),
      p.metodo ? (ETIQUETAS_METODO[p.metodo] || p.metodo) : '', p.recargo, p.recargo_tarjeta || 0,
      estado, p.estado === 'cancelado' ? 0 : (p.cobrado ?? p.total)]);
  }

  // --- Hoja 3: Gastos del día ---
  const filasGastos = [['Concepto', 'Valor', 'Registró']];
  for (const g of resumen.gastos) filasGastos.push([g.concepto, g.valor, g.usuario]);
  filasGastos.push([]);
  filasGastos.push(['TOTAL GASTOS', resumen.totalGastos, '']);

  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hojaConFiltro(XLSX, filasResumen, [34, 14]), 'Resumen del día');
  XLSX.utils.book_append_sheet(libro, hojaConFiltro(XLSX, filasVentas, [9, 6, 12, 10, 18, 20, 14, 18, 14, 9, 9, 11, 10]), 'Ventas');
  XLSX.utils.book_append_sheet(libro, hojaConFiltro(XLSX, filasGastos, [46, 12, 14]), 'Gastos del día');
  enviarXlsx(res, libro, `resumen-${jornada}.xlsx`);
});

// Excel de nómina del año: una hoja por empleado (como la tarjeta Kardex que
// llevan a mano) + hoja RESUMEN con el total por empleado y mes.
app.get('/api/nomina/excel', requiere(2), (req, res) => {
  const XLSX = require('xlsx');
  const anio = /^\d{4}$/.test(String(req.query.anio || '')) ? req.query.anio : jornadaHoy().slice(0, 4);
  const pagosAnio = db.prepare(
    `SELECT n.*, u.nombre AS empleado FROM nomina n JOIN usuarios u ON u.id = n.empleado_id
     WHERE n.estado = 'confirmado' AND n.jornada LIKE ? ORDER BY u.nombre, n.jornada, n.id`).all(anio + '-%');
  if (!pagosAnio.length) return res.status(404).json({ error: `No hay pagos de nómina confirmados en ${anio}` });

  const libro = XLSX.utils.book_new();

  // Hoja RESUMEN: empleados x meses
  const empleados = [...new Set(pagosAnio.map(p => p.empleado))];
  const filasResumen = [['Empleado', ...MESES, 'TOTAL ' + anio]];
  for (const emp of empleados) {
    const fila = [emp];
    let totalAnio = 0;
    for (let m = 1; m <= 12; m++) {
      const suma = pagosAnio.filter(p => p.empleado === emp && Number(p.jornada.slice(5, 7)) === m)
        .reduce((s, p) => s + p.total, 0);
      fila.push(suma || 0);
      totalAnio += suma;
    }
    fila.push(totalAnio);
    filasResumen.push(fila);
  }
  XLSX.utils.book_append_sheet(libro, hojaConFiltro(XLSX, filasResumen, [16, ...MESES.map(() => 11), 13]), 'RESUMEN');

  // Una hoja por empleado, estilo tarjeta Kardex
  const usados = new Set(['RESUMEN']);
  for (const emp of empleados) {
    const filas = [['Fecha', 'Mes', 'Día', 'Turno', 'Descuento', 'Bono', 'Concepto', 'Total', 'Confirmado']];
    let total = 0;
    for (const p of pagosAnio.filter(x => x.empleado === emp)) {
      filas.push([p.jornada, MESES[Number(p.jornada.slice(5, 7)) - 1], Number(p.jornada.slice(8, 10)),
        p.valor_turno, p.descuento, p.bono, p.concepto || '', p.total, (p.confirmado_en || '').slice(0, 16)]);
      total += p.total;
    }
    filas.push([]);
    filas.push(['', '', '', '', '', '', 'TOTAL ' + anio, total, '']);
    // nombre de hoja: máximo 31 caracteres, sin caracteres prohibidos, único
    let nombre = emp.replace(/[\\\/\?\*\[\]:]/g, ' ').trim().slice(0, 28) || 'Empleado';
    let n = 2;
    while (usados.has(nombre)) nombre = nombre.slice(0, 25) + ' ' + (n++);
    usados.add(nombre);
    XLSX.utils.book_append_sheet(libro, hojaConFiltro(XLSX, filas, [11, 11, 5, 10, 10, 10, 26, 10, 16]), nombre);
  }
  enviarXlsx(res, libro, `nomina-${anio}.xlsx`);
});

// Cuenta de venta para el cliente (documento informativo con los datos del negocio)
app.post('/api/pedidos/:id/factura', requiere(1), (req, res) => {
  const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (pedido.estado === 'cancelado') return res.status(409).json({ error: 'La comanda está anulada' });
  const items = db.prepare('SELECT * FROM pedido_items WHERE pedido_id = ?').all(pedido.id);
  const pago = db.prepare('SELECT * FROM pagos WHERE pedido_id = ?').get(pedido.id);

  // Agrupar items iguales (mismo plato, precio y condición solo/almuerzo)
  const grupos = new Map();
  for (const it of items) {
    const clave = `${it.plato_nombre}|${it.precio}|${it.solo}`;
    if (!grupos.has(clave)) grupos.set(clave, { nombre: it.plato_nombre, precio: it.precio, solo: it.solo, cantidad: 0 });
    grupos.get(clave).cantidad += it.cantidad;
  }

  const consecutivo = Number(getConfig('factura_consecutivo') || 0) + 1;
  setConfig('factura_consecutivo', String(consecutivo));

  const recargoTarjeta = pago ? (pago.recargo_tarjeta || 0) : 0;
  const ticket = ticketFactura({
    titulo: getConfig('factura_titulo'),
    razon: getConfig('factura_razon_social'),
    nit: getConfig('factura_nit'),
    direccion: getConfig('factura_direccion'),
    telefono: getConfig('factura_telefono'),
    leyenda: getConfig('factura_leyenda'),
    consecutivo,
    numero_comanda: pedido.numero_comanda,
    fecha: pedido.jornada,
    hora: horaLocal(),
    items: [...grupos.values()].map(g => ({ cantidad: g.cantidad, nombre: g.nombre, solo: g.solo, subtotal: g.precio * g.cantidad })),
    recargoDomicilio: pedido.recargo,
    recargoTarjeta,
    total: pedido.total + recargoTarjeta,
    metodo: pago ? (ETIQUETAS_METODO[pago.metodo] || pago.metodo) : null
  }, { ancho: getConfig('ancho_ticket') });
  impresion.encolar(pedido.id, 'factura', ticket);
  registrarHistorial(pedido.id, req.usuario.usuarioId, 'factura', `Factura No. ${consecutivo}`);
  res.json({ ok: true, consecutivo });
});

// Rectificación de métodos de pago: lista por día/método y corrección
app.get('/api/pagos', requiere(2), (req, res) => {
  const jornada = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.jornada || '')) ? req.query.jornada : jornadaHoy();
  let filtro = '';
  const params = [jornada];
  if (req.query.metodo) { filtro = ' AND pg.metodo = ?'; params.push(req.query.metodo); }
  const pagos = db.prepare(
    `SELECT pg.*, p.numero_comanda, p.total AS total_pedido, p.estado
     FROM pagos pg JOIN pedidos p ON p.id = pg.pedido_id
     WHERE pg.jornada = ?${filtro} ORDER BY pg.creado_en`).all(...params);
  res.json({ jornada, cerrada: jornadaCerrada(jornada), pagos });
});

app.put('/api/pagos/:pedidoId/metodo', requiere(2), (req, res) => {
  const pago = db.prepare('SELECT * FROM pagos WHERE pedido_id = ?').get(req.params.pedidoId);
  if (!pago) return res.status(404).json({ error: 'Ese pedido no tiene pago registrado' });
  // Rectificar un día con cierre dañaría el arqueo ya registrado
  if (jornadaCerrada(pago.jornada)) {
    return res.status(409).json({ error: 'Ese día ya tiene cierre de caja: no se puede rectificar' });
  }
  const metodo = req.body.metodo;
  if (!['efectivo', 'tarjeta', 'nequi', 'daviplata', 'qr_bancolombia'].includes(metodo)) {
    return res.status(400).json({ error: 'Método de pago no válido' });
  }
  if (metodo === pago.metodo) return res.json({ ok: true, sinCambio: true });
  const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(pago.pedido_id);
  // El recargo de tarjeta se recalcula según el método nuevo
  const rec = recargoTarjetaDe(metodo, pedido.total);
  const monto = pedido.total + rec;
  const recibido = metodo === 'efectivo' ? monto : null;
  db.prepare('UPDATE pagos SET metodo = ?, monto = ?, recargo_tarjeta = ?, recibido = ?, vueltas = ? WHERE pedido_id = ?')
    .run(metodo, monto, rec, recibido, metodo === 'efectivo' ? 0 : null, pago.pedido_id);
  registrarHistorial(pago.pedido_id, req.usuario.usuarioId, 'rectificar_pago', `${pago.metodo} -> ${metodo} (${monto})`);
  emitirPedidos();
  io.emit('caja:actualizada');
  res.json({ ok: true, monto, recargo_tarjeta: rec });
});

// Reabrir el día: deshace un cierre de caja hecho por error (solo admin, solo hoy)
app.post('/api/cierre/reabrir', requiere(3), (req, res) => {
  const hoy = jornadaHoy();
  if (!db.prepare('SELECT id FROM cierres WHERE jornada = ?').get(hoy)) {
    return res.status(409).json({ error: 'La jornada de hoy no tiene cierre' });
  }
  db.prepare('DELETE FROM cierres WHERE jornada = ?').run(hoy);
  // El reporte por correo que quedó en cola sin enviar se descarta (el cierre nuevo genera otro)
  db.prepare("DELETE FROM cola_correos WHERE jornada = ? AND estado = 'pendiente'").run(hoy);
  registrarHistorial(null, req.usuario.usuarioId, 'reabrir_dia', hoy);
  io.emit('jornada:reabierta', { jornada: hoy });
  res.json({ ok: true });
});

app.post('/api/cierre', requiere(2), async (req, res) => {
  try {
    const efectivo = req.body.efectivo_contado === null || req.body.efectivo_contado === undefined
      ? null : Math.round(Number(req.body.efectivo_contado));
    const resultado = reportes.ejecutarCierre(jornadaHoy(), efectivo, req.usuario.usuarioId);
    io.emit('jornada:cerrada', { jornada: jornadaHoy() });
    // El cierre dispara el reporte por correo al dueño (con el arqueo incluido)
    reportes.encolarReporteDiario(jornadaHoy());
    const envio = await reportes.drenarCorreos();
    // También empuja lo que quede pendiente hacia Google Sheets
    reportes.drenarSheets().catch(() => {});
    res.json({
      ...resultado,
      reporteCorreo: envio.ok && envio.enviados > 0 ? 'enviado' : 'en_cola',
      reporteError: envio.error || null
    });
  } catch (e) { res.status(409).json({ error: e.message }); }
});

// Prueba de la conexión con Google Sheets: encola una fila de prueba y la envía ya
app.post('/api/sheets/prueba', requiere(3), async (req, res) => {
  reportes.encolarVentaSheets(
    { jornada: jornadaHoy(), numero_comanda: 0, comensal: 'FILA DE PRUEBA', tipo_entrega: 'mesa', recargo: 0, total: 0 },
    [{ cantidad: 1, plato_nombre: 'Conexión verificada desde el POS' }],
    { metodo: 'efectivo', creado_en: ahora() },
    req.usuario.nombre
  );
  const r = await reportes.drenarSheets();
  if (r.ok) res.json({ ok: true, enviados: r.enviados });
  else res.status(502).json({ error: r.error, pendientes: r.pendientes });
});

app.get('/api/sync/estado', requiere(3), (_req, res) => res.json(reportes.estadoSync()));

// Dirección actual del servidor en la red (público: quien pregunta ya está en la LAN).
// Útil cuando la IP cambia, p. ej. al usar el hotspot de un teléfono.
app.get('/api/red', (_req, res) => {
  res.json({
    url: urlLan(),
    candidatas: candidatasLan().filter(c => c.prioridad < 10).map(c => ({ url: `http://${c.ip}:${PORT}`, red: c.nombre }))
  });
});

app.post('/api/reportes/enviar-ahora', requiere(3), (req, res) => {
  reportes.encolarReporteDiario(jornadaHoy());
  reportes.drenarCorreos().catch(() => {});
  res.json({ ok: true });
});

// ---------- Usuarios (solo admin) ----------
app.get('/api/usuarios', requiere(3), (_req, res) => {
  res.json(db.prepare('SELECT id, nombre, rol, valor_turno, activo FROM usuarios ORDER BY nombre').all());
});

app.post('/api/usuarios', requiere(3), (req, res) => {
  const { nombre, rol } = req.body;
  let pin = String(req.body.pin || '');
  if (!['admin', 'cajero', 'mesero', 'cocinera'].includes(rol)) return res.status(400).json({ error: 'Rol no válido' });
  if (rol === 'cocinera' && !pin) {
    // La cocinera no usa la app: se le asigna un PIN interno libre automáticamente
    do { pin = String(Math.floor(1000 + Math.random() * 9000)); }
    while (db.prepare('SELECT id FROM usuarios WHERE pin = ?').get(pin));
  }
  if (!nombre || !/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'Nombre y PIN de 4 dígitos son obligatorios' });
  if (db.prepare('SELECT id FROM usuarios WHERE pin = ?').get(pin)) {
    return res.status(409).json({ error: 'Ese PIN ya está asignado a otro usuario' });
  }
  const r = db.prepare('INSERT INTO usuarios (nombre, pin, rol) VALUES (?, ?, ?)').run(String(nombre).trim(), pin, rol);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/usuarios/:id', requiere(3), (req, res) => {
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  const nombre = req.body.nombre !== undefined ? String(req.body.nombre).trim() : u.nombre;
  const rol = req.body.rol !== undefined ? req.body.rol : u.rol;
  const activo = req.body.activo !== undefined ? (req.body.activo ? 1 : 0) : u.activo;
  let pin = u.pin;
  if (req.body.pin) {
    if (!/^\d{4}$/.test(String(req.body.pin))) return res.status(400).json({ error: 'El PIN debe ser de 4 dígitos' });
    const otro = db.prepare('SELECT id FROM usuarios WHERE pin = ? AND id != ?').get(String(req.body.pin), u.id);
    if (otro) return res.status(409).json({ error: 'Ese PIN ya está asignado a otro usuario' });
    pin = String(req.body.pin);
  }
  // El valor del turno solo lo cambia el admin (este endpoint ya exige admin)
  const valorTurno = req.body.valor_turno !== undefined ? Math.max(0, Math.round(Number(req.body.valor_turno) || 0)) : u.valor_turno;
  // Desactivar no borra: sus ventas históricas quedan intactas
  db.prepare('UPDATE usuarios SET nombre = ?, rol = ?, activo = ?, pin = ?, valor_turno = ? WHERE id = ?').run(nombre, rol, activo, pin, valorTurno, u.id);
  res.json({ ok: true });
});

// ---------- Configuración (solo admin) ----------
app.get('/api/config', requiere(3), (_req, res) => {
  const cfg = getConfigAll();
  cfg.gmail_app_password = cfg.gmail_app_password ? '(guardada)' : '';
  res.json(cfg);
});

app.put('/api/config', requiere(3), (req, res) => {
  const permitidas = ['nombre_restaurante', 'recargo_empaque', 'hora_reporte', 'correo_dueno', 'gmail_usuario',
    'gmail_app_password', 'sheets_webhook_url', 'modo_impresion', 'impresora_share', 'puerto_com', 'ancho_ticket', 'tamano_platos', 'tamano_obs',
    'recargo_tarjeta_fijo', 'recargo_tarjeta_umbral', 'recargo_tarjeta_pct',
    'factura_titulo', 'factura_razon_social', 'factura_nit', 'factura_direccion', 'factura_telefono', 'factura_leyenda'];
  for (const [clave, valor] of Object.entries(req.body || {})) {
    if (!permitidas.includes(clave)) continue;
    if (clave === 'gmail_app_password' && valor === '(guardada)') continue;
    setConfig(clave, valor);
  }
  impresion.procesarCola(); // por si el cambio de modo destraba trabajos pendientes
  impresion.notificarEstado();
  res.json({ ok: true });
});

// ---------- Cambios rápidos (chips de notas): los editan meseros y cajeros ----------
app.get('/api/chips', requiere(1), (_req, res) => res.json(chipsActuales()));

app.put('/api/chips', requiere(1), (req, res) => {
  const chips = Array.isArray(req.body.chips) ? req.body.chips : null;
  if (!chips) return res.status(400).json({ error: 'Formato no válido' });
  const limpios = [...new Set(chips.map(c => String(c).trim()).filter(c => c && c.length <= 30))].slice(0, 12);
  setConfig('chips_notas', JSON.stringify(limpios));
  io.emit('chips:actualizados', limpios);
  res.json({ ok: true, chips: limpios });
});

// ---------- Gastos del local (cajero o admin) ----------
app.get('/api/gastos', requiere(2), (_req, res) => {
  res.json(db.prepare(
    `SELECT g.*, u.nombre AS usuario FROM gastos g JOIN usuarios u ON u.id = g.usuario_id
     WHERE g.jornada = ? ORDER BY g.id DESC`).all(jornadaHoy()));
});

app.post('/api/gastos', requiere(2), (req, res) => {
  if (!validarJornadaAbierta(res)) return;
  const concepto = String(req.body.concepto || '').trim();
  const valor = Math.round(Number(req.body.valor));
  if (!concepto || !(valor > 0)) return res.status(400).json({ error: 'Concepto y valor son obligatorios' });
  db.prepare('INSERT INTO gastos (jornada, concepto, valor, usuario_id, creado_en) VALUES (?, ?, ?, ?, ?)')
    .run(jornadaHoy(), concepto, valor, req.usuario.usuarioId, ahora());
  io.emit('caja:actualizada');
  res.json({ ok: true });
});

app.delete('/api/gastos/:id', requiere(2), (req, res) => {
  db.prepare('DELETE FROM gastos WHERE id = ? AND jornada = ?').run(req.params.id, jornadaHoy());
  io.emit('caja:actualizada');
  res.json({ ok: true });
});

// ---------- Nómina ----------
function inicioSemana() {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // lunes de esta semana
  return d.toLocaleDateString('sv-SE');
}
function inicioQuincena() {
  const hoy = jornadaHoy();
  return hoy.slice(0, 8) + (Number(hoy.slice(8)) <= 15 ? '01' : '16');
}
function inicioMes() { return jornadaHoy().slice(0, 8) + '01'; }

// El cajero registra el pago; el empleado lo confirma desde su propia sesión
app.post('/api/nomina', requiere(2), (req, res) => {
  if (!validarJornadaAbierta(res)) return;
  const empleado = db.prepare('SELECT * FROM usuarios WHERE id = ? AND activo = 1').get(req.body.empleado_id);
  if (!empleado) return res.status(404).json({ error: 'Empleado no encontrado' });
  const jornada = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.jornada || '')) ? req.body.jornada : jornadaHoy();
  // El valor del turno es FIJO para el cajero (el que configuró el admin);
  // solo el admin puede pagar un turno con un valor distinto
  const turno = (req.usuario.rol === 'admin' && String(req.body.valor_turno ?? '').trim() !== '')
    ? Math.max(0, Math.round(Number(req.body.valor_turno) || 0))
    : empleado.valor_turno;
  const descuento = Math.max(0, Math.round(Number(req.body.descuento) || 0));
  const bono = Math.max(0, Math.round(Number(req.body.bono) || 0));
  const concepto = String(req.body.concepto || '').trim().slice(0, 80) || null;
  const total = turno - descuento + bono;
  if (total <= 0) return res.status(400).json({ error: 'El total del pago debe ser mayor a cero' });
  const r = db.prepare(
    `INSERT INTO nomina (empleado_id, jornada, valor_turno, descuento, bono, total, concepto, estado, registrado_por, creado_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?)`)
    .run(empleado.id, jornada, turno, descuento, bono, total, concepto, req.usuario.usuarioId, ahora());
  // Aviso directo al teléfono del empleado para que confirme
  io.to(`usuario:${empleado.id}`).emit('nomina:pendiente', {
    id: r.lastInsertRowid, empleado: empleado.nombre, jornada, valor_turno: turno, descuento, bono, total, concepto
  });
  io.emit('nomina:actualizada');
  res.json({ id: r.lastInsertRowid });
});

// Confirma el propio empleado (desde su sesión) o el admin (para quien no usa la app)
app.post('/api/nomina/:id/confirmar', requiere(1), (req, res) => {
  const n = db.prepare('SELECT n.*, u.nombre AS empleado, u.rol AS empleado_rol FROM nomina n JOIN usuarios u ON u.id = n.empleado_id WHERE n.id = ?').get(req.params.id);
  if (!n) return res.status(404).json({ error: 'Pago no encontrado' });
  if (n.estado !== 'pendiente') return res.status(409).json({ error: 'El pago ya no está pendiente' });
  const esElMismo = req.usuario.usuarioId === n.empleado_id;
  const esAdmin = req.usuario.rol === 'admin';
  // La cocinera no usa la app: el cajero está autorizado a confirmar sus pagos
  const cajeroPorCocinera = NIVEL[req.usuario.rol] >= 2 && n.empleado_rol === 'cocinera';
  if (!esElMismo && !esAdmin && !cajeroPorCocinera) {
    return res.status(403).json({ error: 'Solo el empleado (o el administrador) puede confirmar este pago' });
  }
  db.prepare("UPDATE nomina SET estado = 'confirmado', confirmado_en = ? WHERE id = ?").run(ahora(), n.id);
  io.emit('nomina:actualizada');
  io.emit('caja:actualizada');
  res.json({ ok: true });
});

app.post('/api/nomina/:id/anular', requiere(3), (req, res) => {
  db.prepare("UPDATE nomina SET estado = 'anulado' WHERE id = ?").run(req.params.id);
  io.emit('nomina:actualizada');
  io.emit('caja:actualizada');
  res.json({ ok: true });
});

// Totales por empleado: hoy, semana (desde el lunes), quincena y mes
app.get('/api/nomina/resumen', requiere(2), (_req, res) => {
  const hoy = jornadaHoy();
  const sumaDesde = db.prepare(
    "SELECT COALESCE(SUM(total), 0) AS t FROM nomina WHERE empleado_id = ? AND estado = 'confirmado' AND jornada >= ? AND jornada <= ?");
  const empleados = db.prepare('SELECT id, nombre, rol, valor_turno FROM usuarios WHERE activo = 1 ORDER BY nombre').all()
    .map(u => ({
      ...u,
      dia: sumaDesde.get(u.id, hoy, hoy).t,
      semana: sumaDesde.get(u.id, inicioSemana(), hoy).t,
      quincena: sumaDesde.get(u.id, inicioQuincena(), hoy).t,
      mes: sumaDesde.get(u.id, inicioMes(), hoy).t
    }));
  const pendientes = db.prepare(
    `SELECT n.*, u.nombre AS empleado, u.rol AS empleado_rol FROM nomina n JOIN usuarios u ON u.id = n.empleado_id
     WHERE n.estado = 'pendiente' ORDER BY n.id DESC`).all();
  res.json({ empleados, pendientes });
});

// ---------- Impresión ----------
app.get('/api/impresion/cola', requiere(1), (_req, res) => res.json(impresion.estadoCola()));

app.post('/api/impresion/:id/reintentar', requiere(1), (req, res) => {
  impresion.reintentarTrabajo(req.params.id);
  res.json({ ok: true });
});

app.post('/api/impresion/prueba', requiere(3), (req, res) => {
  const ticket = ticketCocina(
    { numero_comanda: 0, comensal: 'PRUEBA', tipo_entrega: 'mesa' },
    [{ plato_nombre: 'Sopa', cantidad: 1, nota: '', bloque: 0 },
     { plato_nombre: 'Pollo', cantidad: 1, nota: 'Sin arroz\nasi se ven las observaciones escritas', bloque: 0 }],
    'comanda', opcionesTicket());
  impresion.encolar(null, 'comanda', ticket);
  res.json({ ok: true });
});

app.post('/api/impresion/qr-acceso', requiere(3), (req, res) => {
  const ticket = ticketAccesoQR(urlLan(), getConfig('nombre_restaurante'), Number(getConfig('ancho_ticket')));
  impresion.encolar(null, 'comanda', ticket);
  res.json({ ok: true, url: urlLan() });
});

app.get('/api/historial/:pedidoId', requiere(1), (req, res) => {
  res.json(db.prepare(
    `SELECT h.*, u.nombre AS usuario FROM historial h LEFT JOIN usuarios u ON u.id = h.usuario_id
     WHERE h.pedido_id = ? ORDER BY h.id`).all(req.params.pedidoId));
});

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const u = usuarioDeToken(token);
  if (u) socket.join(`usuario:${u.usuarioId}`);
  socket.on('impresora:registrar', () => {
    if (!u) return socket.emit('error:auth', 'Inicie sesión antes de registrar la estación de impresión');
    impresion.registrarPuente(socket);
  });
});

// ---------- Arranque ----------
function candidatasLan() {
  // Preferir la IP de la red local real del restaurante sobre adaptadores virtuales:
  // - VPN/Tailscale usan 100.64-127.x (los teléfonos del local no la alcanzan)
  // - VirtualBox/VMware crean redes donde el PC es el ".1"; en una LAN normal
  //   con router, al PC le toca .2-.254 por DHCP, así que ".1" se penaliza
  // - 169.254.x es un adaptador sin red asignada
  const candidatas = [];
  for (const [nombre, redes] of Object.entries(os.networkInterfaces())) {
    for (const red of redes || []) {
      if (red.family !== 'IPv4' || red.internal) continue;
      const ip = red.address;
      let prioridad = 3;
      if (ip.startsWith('192.168.')) prioridad = 0;
      else if (ip.startsWith('10.')) prioridad = 1;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) prioridad = 2;
      if (ip.endsWith('.1')) prioridad += 5;
      if (ip.startsWith('169.254.')) prioridad = 20;
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) prioridad = 30;
      if (/tailscale|vmware|virtualbox|vethernet|bluetooth|loopback/i.test(nombre)) prioridad += 10;
      candidatas.push({ ip, nombre, prioridad });
    }
  }
  return candidatas.sort((a, b) => a.prioridad - b.prioridad);
}

function urlLan() {
  const c = candidatasLan();
  return c.length ? `http://${c[0].ip}:${PORT}` : `http://localhost:${PORT}`;
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('==============================================');
    console.log('El POS YA está corriendo en este PC.');
    console.log(`Abra la app en: http://localhost:${PORT}`);
    console.log('Esta ventana se cerrará sola.');
    console.log('==============================================');
    setTimeout(() => process.exit(0), 8000);
  } else {
    console.error('Error del servidor:', err);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('==============================================');
  console.log(`POS listo. En este PC:  http://localhost:${PORT}`);
  console.log(`Desde los teléfonos:   ${urlLan()}`);
  const otras = candidatasLan().slice(1).filter(c => c.prioridad < 10);
  if (otras.length) {
    console.log('Si esa dirección no abre en el teléfono, pruebe:');
    for (const c of otras) console.log(`  http://${c.ip}:${PORT}  (${c.nombre})`);
  }
  console.log('==============================================');
  reportes.iniciarPlanificador();
  impresion.procesarCola(); // retomar comandas que quedaron pendientes tras un reinicio
  precalentarMenu(); // pre-render de los nombres del menú en imagen x3
});

// Servidor del POS: API REST + tiempo real (Socket.IO) + archivos de la app web.
// Corre en el PC del restaurante; los teléfonos entran por la LAN a http://<ip-del-pc>:3000
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const { db, ahora, jornadaHoy, horaLocal, getConfig, setConfig, getConfigAll, registrarHistorial, jornadaCerrada } = require('./db');
const { ticketCocina, ticketAccesoQR } = require('./escpos');
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
const NIVEL = { mesero: 1, cajero: 2, admin: 3 };

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
  if (!u) {
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
    configPublica: {
      nombre_restaurante: getConfig('nombre_restaurante'),
      recargo_empaque: Number(getConfig('recargo_empaque'))
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
      const nombres = platosActivos().map(p => p.nombre.toUpperCase());
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
  const r = db.prepare('INSERT INTO platos (nombre, precio, categoria, tipo) VALUES (?, ?, ?, ?)')
    .run(String(nombre).trim(), Math.round(Number(precio)), categoria || 'General', tipo);
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
  db.prepare('UPDATE platos SET nombre = ?, precio = ?, categoria = ?, tipo = ?, disponible = ? WHERE id = ?')
    .run(nombre, precio, categoria, tipo, disponible, plato.id);
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
    items.push({ plato_nombre: plato.nombre, precio: plato.precio, cantidad, nota, bloque });
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
  const items = db.prepare('SELECT * FROM pedido_items WHERE pedido_id = ?').all(pedidoId);
  const ticket = ticketCocina(pedido, items, tipo, opcionesTicket());
  impresion.encolar(pedidoId, tipo, ticket);
}

app.post('/api/pedidos', requiere(1), (req, res) => {
  if (!validarJornadaAbierta(res)) return;
  const { uuid, comensal, tipo_entrega, items: itemsBody } = req.body;
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
  const recargoPre = tipo_entrega === 'llevar' ? Number(getConfig('recargo_empaque')) : 0;
  const totalPre = items.reduce((s, i) => s + i.precio * i.cantidad, 0) + recargoPre;
  if (pagoExpress && pagoExpress.metodo === 'efectivo' && pagoExpress.recibido &&
      Math.round(Number(pagoExpress.recibido)) < totalPre) {
    return res.status(400).json({ error: 'El monto recibido es menor al total' });
  }
  const recargo = tipo_entrega === 'llevar' ? Number(getConfig('recargo_empaque')) : 0;
  const total = items.reduce((s, i) => s + i.precio * i.cantidad, 0) + recargo;

  const uuidFinal = uuid || crypto.randomUUID();
  const crear = db.transaction(() => {
    const num = db.prepare('SELECT COALESCE(MAX(numero_comanda), 0) + 1 AS n FROM pedidos WHERE jornada = ?').get(jornada).n;
    const r = db.prepare(
      `INSERT INTO pedidos (uuid, numero_comanda, jornada, comensal, tipo_entrega, vendedor_id, recargo, total, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(uuidFinal, num, jornada, String(comensal).trim(), tipo_entrega === 'llevar' ? 'llevar' : 'mesa',
           req.usuario.usuarioId, recargo, total, ahora());
    const insItem = db.prepare('INSERT INTO pedido_items (pedido_id, plato_nombre, precio, cantidad, nota, bloque) VALUES (?, ?, ?, ?, ?, ?)');
    for (const it of items) insItem.run(r.lastInsertRowid, it.plato_nombre, it.precio, it.cantidad, it.nota, it.bloque);
    return { id: r.lastInsertRowid, numero_comanda: num };
  });
  const creado = crear();
  registrarHistorial(creado.id, req.usuario.usuarioId, 'crear', `Comanda ${creado.numero_comanda} para ${comensal}`);

  let vueltas = null;
  if (pagoExpress) {
    let recibido = null;
    if (pagoExpress.metodo === 'efectivo') {
      recibido = pagoExpress.recibido ? Math.round(Number(pagoExpress.recibido)) : total;
      vueltas = recibido - total;
    }
    db.prepare('INSERT INTO pagos (pedido_id, metodo, monto, recibido, vueltas, cajero_id, jornada, creado_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(creado.id, pagoExpress.metodo, total, recibido, vueltas, req.usuario.usuarioId, jornada, ahora());
    registrarHistorial(creado.id, req.usuario.usuarioId, 'pago', `${pagoExpress.metodo} por ${total} (express)`);
    const pedidoCompleto = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(creado.id);
    const vendedor = req.usuario.nombre;
    reportes.encolarVentaSheets(pedidoCompleto, items.map(i => ({ cantidad: i.cantidad, plato_nombre: i.plato_nombre })), { metodo: pagoExpress.metodo, creado_en: ahora() }, vendedor);
    reportes.drenarSheets().catch(() => {});
  }

  imprimirPedido(creado.id, 'comanda');
  emitirPedidos();
  // Aviso a todos los dispositivos conectados de que el PC recibió y guardó el pedido
  io.emit('pedido:guardado', {
    uuid: uuidFinal,
    numero_comanda: creado.numero_comanda,
    comensal: String(comensal).trim(),
    vendedor: req.usuario.nombre,
    pagado: !!pagoExpress
  });
  res.json({ ...creado, vueltas });
});

app.put('/api/pedidos/:id', requiere(1), (req, res) => {
  if (!validarJornadaAbierta(res)) return;
  const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (pedido.estado !== 'en_proceso') return res.status(409).json({ error: 'Solo se pueden editar pedidos en proceso' });
  if (db.prepare('SELECT id FROM pagos WHERE pedido_id = ?').get(pedido.id)) {
    return res.status(409).json({ error: 'El pedido ya está pagado; no se puede editar' });
  }
  const { comensal, tipo_entrega, items: itemsBody } = req.body;
  let items;
  try { items = armarItems(itemsBody); } catch (e) { return res.status(400).json({ error: e.message }); }
  const tipo = tipo_entrega === 'llevar' ? 'llevar' : 'mesa';
  const recargo = tipo === 'llevar' ? Number(getConfig('recargo_empaque')) : 0;
  const total = items.reduce((s, i) => s + i.precio * i.cantidad, 0) + recargo;

  const actualizar = db.transaction(() => {
    // La venta conserva la atribución al vendedor original (vendedor_id no se toca)
    db.prepare('UPDATE pedidos SET comensal = ?, tipo_entrega = ?, recargo = ?, total = ?, actualizado_en = ? WHERE id = ?')
      .run(String(comensal || pedido.comensal).trim(), tipo, recargo, total, ahora(), pedido.id);
    db.prepare('DELETE FROM pedido_items WHERE pedido_id = ?').run(pedido.id);
    const insItem = db.prepare('INSERT INTO pedido_items (pedido_id, plato_nombre, precio, cantidad, nota, bloque) VALUES (?, ?, ?, ?, ?, ?)');
    for (const it of items) insItem.run(pedido.id, it.plato_nombre, it.precio, it.cantidad, it.nota, it.bloque);
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
  if (db.prepare('SELECT id FROM pagos WHERE pedido_id = ?').get(pedido.id)) {
    return res.status(409).json({ error: 'El pedido ya está pagado; para anularlo hable con el administrador' });
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
  let recibido = null, vueltas = null;
  if (metodo === 'efectivo') {
    recibido = Math.round(Number(req.body.recibido));
    if (!(recibido >= pedido.total)) return res.status(400).json({ error: 'El monto recibido es menor al total' });
    vueltas = recibido - pedido.total;
  }
  db.prepare('INSERT INTO pagos (pedido_id, metodo, monto, recibido, vueltas, cajero_id, jornada, creado_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(pedido.id, metodo, pedido.total, recibido, vueltas, req.usuario.usuarioId, pedido.jornada, ahora());
  registrarHistorial(pedido.id, req.usuario.usuarioId, 'pago', `${metodo} por ${pedido.total}`);
  const items = db.prepare('SELECT * FROM pedido_items WHERE pedido_id = ?').all(pedido.id);
  const vendedor = db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(pedido.vendedor_id).nombre;
  reportes.encolarVentaSheets(pedido, items, { metodo, creado_en: ahora() }, vendedor);
  reportes.drenarSheets().catch(() => {}); // intento inmediato; si no hay internet queda en búfer
  emitirPedidos();
  res.json({ ok: true, vueltas });
});

// ---------- Reportes y cierre (cajero o admin) ----------
app.get('/api/reportes/dia', requiere(2), (req, res) => {
  res.json(reportes.resumenJornada(req.query.jornada || jornadaHoy()));
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
  res.json(db.prepare('SELECT id, nombre, rol, activo FROM usuarios ORDER BY nombre').all());
});

app.post('/api/usuarios', requiere(3), (req, res) => {
  const { nombre, pin, rol } = req.body;
  if (!nombre || !/^\d{4}$/.test(String(pin))) return res.status(400).json({ error: 'Nombre y PIN de 4 dígitos son obligatorios' });
  if (!['admin', 'cajero', 'mesero'].includes(rol)) return res.status(400).json({ error: 'Rol no válido' });
  if (db.prepare('SELECT id FROM usuarios WHERE pin = ?').get(String(pin))) {
    return res.status(409).json({ error: 'Ese PIN ya está asignado a otro usuario' });
  }
  const r = db.prepare('INSERT INTO usuarios (nombre, pin, rol) VALUES (?, ?, ?)').run(String(nombre).trim(), String(pin), rol);
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
  // Desactivar no borra: sus ventas históricas quedan intactas
  db.prepare('UPDATE usuarios SET nombre = ?, rol = ?, activo = ?, pin = ? WHERE id = ?').run(nombre, rol, activo, pin, u.id);
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
    'gmail_app_password', 'sheets_webhook_url', 'modo_impresion', 'impresora_share', 'puerto_com', 'ancho_ticket', 'tamano_platos', 'tamano_obs'];
  for (const [clave, valor] of Object.entries(req.body || {})) {
    if (!permitidas.includes(clave)) continue;
    if (clave === 'gmail_app_password' && valor === '(guardada)') continue;
    setConfig(clave, valor);
  }
  impresion.procesarCola(); // por si el cambio de modo destraba trabajos pendientes
  impresion.notificarEstado();
  res.json({ ok: true });
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

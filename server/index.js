// Servidor del POS: API REST + tiempo real (Socket.IO) + archivos de la app web.
// Corre en el PC del restaurante; los teléfonos entran por la LAN a http://<ip-del-pc>:3000
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const { exec } = require('child_process');
const { Server } = require('socket.io');

const { db, ahora, jornadaHoy, horaLocal, getConfig, setConfig, getConfigAll, registrarHistorial, jornadaCerrada, DATA_DIR } = require('./db');
const { ticketCocina, ticketNomina, ticketFactura, ticketAccesoQR } = require('./escpos');
const impresion = require('./printing');
const reportes = require('./reports');
const informes = require('./informes');
const { registrar } = require('./registro');

const PORT = process.env.PORT || 3000;

// Salir a internet por IPv4 primero: colgado del hotspot de un teléfono (redes
// de celular con IPv6 a medias) Node se quedaba esperando por IPv6 y Google
// "no respondía", aunque WhatsApp Web en el mismo PC sí funcionara.
try { dns.setDefaultResultOrder('ipv4first'); } catch { /* Node viejo */ }
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
impresion.setIO(io);
// El aviso del Excel en tiempo real que ven las pantallas de caja
reportes.setAvisoSheets(estado => io.emit('sheets:estado', estado));

app.use(express.json());

// El PC puede tener varias redes al tiempo (cable, hotspot del teléfono,
// adaptadores virtuales) y adivinar cuál alcanza a los meseros falla: se
// anunciaba la del cable y ningún teléfono del hotspot podía entrar.
// Aquí se aprende de la realidad: cada vez que un dispositivo de la red habla
// con el servidor, queda anotada la dirección del PC por la que lo alcanzó.
let ipQueFunciona = getConfig('ip_lan_ok') || null;
function esClienteDeLaRed(req) {
  const remoto = (req.socket.remoteAddress || '').replace('::ffff:', '');
  return !!remoto && !remoto.startsWith('127.') && remoto !== '::1';
}
app.use((req, _res, next) => {
  const local = (req.socket.localAddress || '').replace('::ffff:', '');
  if (local && local !== ipQueFunciona && esClienteDeLaRed(req)) {
    ipQueFunciona = local;
    setConfig('ip_lan_ok', local); // sobrevive reinicios del PC
    registrar('red', `Los teléfonos entran por ${local}: esa es la dirección que se anuncia`);
  }
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- Sesiones y autenticación por PIN ----------
const sesiones = new Map(); // token -> { usuarioId, nombre, rol }
const intentosFallidos = new Map(); // ip -> { n, bloqueadoHasta }
const NIVEL = { cocinera: 0, mesero: 1, cajero: 2, admin: 3 };

function usuarioDeToken(token) { return token ? sesiones.get(token) : null; }

// Cerrar por la fuerza las sesiones abiertas de un usuario. Sin esto, el
// teléfono de un empleado eliminado o desactivado seguía tomando pedidos y
// viendo las ventas del día: el token queda guardado en el teléfono y la sesión
// vive en memoria hasta reiniciar el PC.
function cerrarSesionesDe(usuarioId) {
  for (const [token, s] of sesiones) if (s.usuarioId === usuarioId) sesiones.delete(token);
  try { io.in(`usuario:${usuarioId}`).disconnectSockets(true); } catch { /* sin sockets abiertos */ }
}

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
// Precio por defecto: casi todas las proteínas del día valen lo mismo (y ese
// valor cambia cada año), así que el plato marcado con usa_default toma el
// precio configurado en el Menú en vez del suyo propio.
function preciosPorDefecto() {
  const n = (c) => Math.max(0, Math.round(Number(getConfig(c)) || 0));
  return {
    proteina_dia: { precio: n('precio_dia_entrada'), solo: n('precio_dia_solo') },
    proteina_especial: { precio: n('precio_especial_entrada'), solo: n('precio_especial_solo') },
    // La entrada va incluida en el almuerzo (precio 0); lo que se configura es
    // cuánto vale vendida sola, para cuando piden solo una sopa
    entrada: { precio: 0, solo: n('precio_entrada_sola') }
  };
}

function conPrecioEfectivo(plato, defs) {
  if (!plato || !plato.usa_default) return plato;
  const d = (defs || preciosPorDefecto())[plato.tipo];
  if (!d) return plato;
  return { ...plato, precio: d.precio, precio_solo: d.solo || null };
}

function platosActivos() {
  const defs = preciosPorDefecto();
  return db.prepare('SELECT * FROM platos WHERE activo = 1 ORDER BY categoria, nombre').all()
    .map(p => conPrecioEfectivo(p, defs));
}

function gruposActuales() {
  try { return JSON.parse(getConfig('grupos_plato') || '[]'); } catch { return []; }
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
    // Estado del Excel en tiempo real (aviso de arriba), solo para caja y admin
    sheets: NIVEL[req.usuario.rol] >= 2 ? reportes.estadoSheets() : null,
    configPublica: {
      nombre_restaurante: getConfig('nombre_restaurante'),
      recargo_empaque: Number(getConfig('recargo_empaque')),
      chips_notas: chipsActuales(),
      grupos_plato: gruposActuales(),
      precios_default: preciosPorDefecto(),
      recargo_tarjeta_fijo: Number(getConfig('recargo_tarjeta_fijo')),
      recargo_tarjeta_umbral: Number(getConfig('recargo_tarjeta_umbral')),
      recargo_tarjeta_pct: Number(getConfig('recargo_tarjeta_pct'))
    }
  });
});

// ---------- Menú ----------
app.get('/api/platos', requiere(1), (_req, res) => res.json(platosActivos()));

const TIPOS_PLATO = ['entrada', 'proteina_dia', 'proteina_especial', 'bebida', 'extra'];

// Pre-renderiza los nombres del menú como imagen para que la primera comanda
// del día no espere. Con el dibujo en JavaScript esto cuesta ~1 ms por plato,
// pero se agrupa igual para no repetirlo en cada cambio del menú.
let temporizadorPrecalentar = null;
function precalentarMenu() {
  clearTimeout(temporizadorPrecalentar);
  temporizadorPrecalentar = setTimeout(() => {
    try {
      const nombres = platosActivos().map(p => (p.acronimo || p.nombre).toUpperCase());
      const alto = Math.round(24 * Number(getConfig('tamano_platos') || 3));
      if (alto > 24) require('./texto-bitmap').precalentar(nombres, alto, { centrar: false });
    } catch (e) { registrar('raster', `precalentamiento falló: ${e.message}`); }
  }, 2000);
}

// El "tipo" que ve el usuario en el Menú (pollo, carne, cerdo...) se guarda en
// la columna `grupo`; sirve para el reporte de qué comprar más.
function grupoValido(valor) {
  const g = String(valor || '').trim().slice(0, 24);
  return g || null;
}

app.post('/api/platos', requiere(1), (req, res) => {
  const { nombre, precio, categoria, tipo } = req.body;
  if (!TIPOS_PLATO.includes(tipo)) return res.status(400).json({ error: 'Tipo de plato no válido' });
  // Con precio por defecto no hace falta escribir el precio en cada plato
  const usaDefault = req.body.usa_default && preciosPorDefecto()[tipo] ? 1 : 0;
  // Las entradas van incluidas en el precio del almuerzo: se permiten en $0
  const precioMin = (tipo === 'entrada' || tipo === 'bebida') ? 0 : 1;
  if (!nombre) return res.status(400).json({ error: 'El nombre del plato es obligatorio' });
  if (!usaDefault && !(Number(precio) >= precioMin)) return res.status(400).json({ error: 'Escriba el precio o marque "Usar el precio por defecto"' });
  const precioSolo = req.body.precio_solo !== undefined && String(req.body.precio_solo).trim() !== ''
    ? Math.round(Number(req.body.precio_solo)) || null : null;
  const acronimo = String(req.body.acronimo || '').trim().slice(0, 14).toUpperCase() || null;
  const r = db.prepare(
    'INSERT INTO platos (nombre, precio, categoria, tipo, precio_solo, acronimo, grupo, usa_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(String(nombre).trim(), Math.round(Number(precio) || 0), categoria || 'General', tipo,
         precioSolo, acronimo, grupoValido(req.body.grupo), usaDefault);
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
  const usaDefault = (req.body.usa_default !== undefined ? (req.body.usa_default ? 1 : 0) : plato.usa_default)
    && preciosPorDefecto()[tipo] ? 1 : 0;
  if (!nombre) return res.status(400).json({ error: 'El nombre del plato es obligatorio' });
  if (!usaDefault && !(precio >= ((tipo === 'entrada' || tipo === 'bebida') ? 0 : 1))) {
    return res.status(400).json({ error: 'Datos de plato no válidos' });
  }
  const grupo = req.body.grupo !== undefined ? grupoValido(req.body.grupo) : plato.grupo;
  let precioSolo = plato.precio_solo;
  if (req.body.precio_solo !== undefined) {
    precioSolo = String(req.body.precio_solo).trim() === '' ? null : (Math.round(Number(req.body.precio_solo)) || null);
  }
  let acronimo = plato.acronimo;
  if (req.body.acronimo !== undefined) {
    acronimo = String(req.body.acronimo).trim().slice(0, 14).toUpperCase() || null;
  }
  db.prepare(`UPDATE platos SET nombre = ?, precio = ?, categoria = ?, tipo = ?, disponible = ?,
              precio_solo = ?, acronimo = ?, grupo = ?, usa_default = ? WHERE id = ?`)
    .run(nombre, Math.round(Number(precio) || 0), categoria, tipo, disponible, precioSolo, acronimo, grupo, usaDefault, plato.id);
  emitirMenu();
  precalentarMenu();
  res.json({ ok: true });
});

// Pone el precio por defecto a TODOS los platos de un tipo de una vez: sin esto,
// marcar 150 proteínas una por una sería inviable.
app.post('/api/platos/aplicar-default', requiere(1), (req, res) => {
  const tipo = req.body.tipo;
  if (!preciosPorDefecto()[tipo]) return res.status(400).json({ error: 'Ese tipo no tiene precio por defecto' });
  const r = db.prepare('UPDATE platos SET usa_default = 1 WHERE tipo = ? AND activo = 1 AND usa_default = 0').run(tipo);
  emitirMenu();
  res.json({ ok: true, cambiados: r.changes });
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
  const defs = preciosPorDefecto();
  const items = [];
  for (const it of itemsBody || []) {
    const plato = conPrecioEfectivo(buscarPlato.get(it.plato_id), defs);
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
  const inicio = Date.now();
  const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(pedidoId);
  // El tipo del plato viaja al ticket para ordenar: entradas, proteínas, bebidas, extras
  const items = db.prepare(
    `SELECT pi.*,
            (SELECT pl.tipo FROM platos pl WHERE pl.nombre = pi.plato_nombre ORDER BY pl.activo DESC, pl.id DESC LIMIT 1) AS tipo,
            (SELECT pl.acronimo FROM platos pl WHERE pl.nombre = pi.plato_nombre ORDER BY pl.activo DESC, pl.id DESC LIMIT 1) AS acronimo
     FROM pedido_items pi WHERE pi.pedido_id = ?`).all(pedidoId);
  // La comanda muestra el total a cobrar (con domicilio y recargo de tarjeta),
  // sin el precio de cada plato: no es una factura
  const pago = db.prepare('SELECT metodo, recargo_tarjeta FROM pagos WHERE pedido_id = ?').get(pedidoId);
  const recargoTarjeta = pago ? (pago.recargo_tarjeta || 0) : 0;
  const ticket = ticketCocina(pedido, items, tipo, {
    ...opcionesTicket(),
    total: pedido.total + recargoTarjeta,
    recargoDomicilio: pedido.recargo,
    recargoTarjeta,
    metodoPago: pago ? (ETIQUETAS_METODO[pago.metodo] || pago.metodo) : null
  });
  impresion.encolar(pedidoId, tipo, ticket);
  // Armar la comanda debe costar milisegundos; si algún día vuelve a demorarse,
  // que quede en el registro para saberlo sin adivinar
  const ms = Date.now() - inicio;
  if (ms > 1500) registrar('impresion', `la comanda ${pedido.numero_comanda} tardó ${ms} ms en armarse`);
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
  // Con sus turnos, para que el empleado vea qué días le están pagando
  return db.prepare(
    `SELECT n.*, u.nombre AS empleado FROM nomina n JOIN usuarios u ON u.id = n.empleado_id
     WHERE n.empleado_id = ? AND n.estado = 'pendiente' ORDER BY n.id`).all(usuarioId)
    .map(n => ({ ...n, turnos: db.prepare('SELECT jornada, cargo, valor FROM turnos WHERE pago_id = ? ORDER BY jornada').all(n.id) }));
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
    reportes.encolarVentaSheets(creado.id);
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
  reportes.encolarVentaSheets(pedido.id);
  reportes.drenarSheets().catch(() => {}); // intento inmediato; si no hay internet queda en búfer
  emitirPedidos();
  res.json({ ok: true, vueltas, recargo_tarjeta: recTarjeta, total_cobrado: totalCobrar });
});

// ---------- Reportes y cierre (cajero o admin) ----------
app.get('/api/reportes/dia', requiere(2), (req, res) => {
  res.json(reportes.resumenJornada(req.query.jornada || jornadaHoy()));
});

// Excel del día para la app: resumen (igual al correo) + ventas una a una
// + platos, tipos y gastos. Lo arma informes.js, la misma fuente del correo.
const ETIQUETAS_METODO = reportes.ETIQUETAS_METODO;

function enviarXlsx(res, buffer, nombre) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=${nombre}`);
  res.send(buffer);
}

app.get('/api/reportes/excel', requiere(1), (req, res) => {
  const jornada = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.jornada || '')) ? req.query.jornada : jornadaHoy();
  enviarXlsx(res, informes.excelResumenDia(jornada, true), `resumen-${jornada}.xlsx`);
});

// Excel del mes: resumen con la tabla día por día + todas las ventas del mes
app.get('/api/reportes/excel-mes', requiere(2), (req, res) => {
  const mes = /^\d{4}-\d{2}$/.test(String(req.query.mes || '')) ? req.query.mes : jornadaHoy().slice(0, 7);
  enviarXlsx(res, informes.excelResumenMes(mes), `resumen-${mes}.xlsx`);
});

// Excel de nómina del año: hoja RESUMEN (empleado × mes) + una hoja por mes
// con los pagos agrupados por empleado (estilo Kardex)
app.get('/api/nomina/excel', requiere(2), (req, res) => {
  const anio = /^\d{4}$/.test(String(req.query.anio || '')) ? req.query.anio : jornadaHoy().slice(0, 4);
  const buffer = informes.excelNomina(anio);
  if (!buffer) return res.status(404).json({ error: `No hay pagos de nómina confirmados en ${anio}` });
  enviarXlsx(res, buffer, `nomina-${anio}.xlsx`);
});

// ---------- Base de caja (dinero con el que arrancó el día) ----------
// Opcional: si no se registra, se asume que lo contado en el cierre anterior
// sigue en la caja. Vacío = volver a ese valor automático.
// Los valores de dinero llegan como los teclea la cajera: "12.000", "$12.000"
// o "12 000". Number('12.000') sería 12, así que se dejan solo los dígitos.
function aEntero(valor) {
  const limpio = String(valor ?? '').replace(/[^\d]/g, '');
  return limpio === '' ? null : Number(limpio);
}

app.put('/api/caja/base', requiere(2), (req, res) => {
  if (!validarJornadaAbierta(res)) return;
  const hoy = jornadaHoy();
  const crudo = String(req.body.valor ?? '').trim();
  if (crudo === '') {
    db.prepare('DELETE FROM base_caja WHERE jornada = ?').run(hoy);
  } else {
    const valor = aEntero(crudo);
    if (valor === null || !Number.isFinite(valor) || valor < 0) return res.status(400).json({ error: 'Valor no válido' });
    db.prepare(`INSERT INTO base_caja (jornada, valor, usuario_id, creado_en) VALUES (?, ?, ?, ?)
                ON CONFLICT(jornada) DO UPDATE SET valor = excluded.valor, usuario_id = excluded.usuario_id, creado_en = excluded.creado_en`)
      .run(hoy, valor, req.usuario.usuarioId, ahora());
    registrarHistorial(null, req.usuario.usuarioId, 'base_caja', `${hoy}: ${valor}`);
  }
  io.emit('caja:actualizada');
  res.json({ ok: true, base: reportes.baseCajaDe(hoy) });
});

// ---------- Corrección del TOTAL del día por método de pago ----------
// Para cuadrar contra el extracto (Nequi, datáfono) sin tocar pago por pago.
// El reporte muestra el total real y los almuerzos de ese método pasan a ser
// un aproximado (total ÷ precio del almuerzo).
// El EFECTIVO no se corrige aquí: no tiene extracto contra el cual cuadrar, y
// permitirlo dejaría a la cajera fijar el efectivo esperado al valor que tenga
// la caja, con lo que el descuadre del cierre siempre daría cero y el dueño
// perdería el control. El efectivo se cuadra contando la caja (base + cierre).
const METODOS_AJUSTABLES = ['tarjeta', 'nequi', 'daviplata', 'qr_bancolombia'];

app.get('/api/pagos/ajustes', requiere(2), (req, res) => {
  const jornada = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.jornada || '')) ? req.query.jornada : jornadaHoy();
  const r = reportes.resumenJornada(jornada);
  res.json({ jornada, cerrada: jornadaCerrada(jornada), ajustables: METODOS_AJUSTABLES,
    registrado: r.porMetodoRegistrado, real: r.porMetodo,
    ajustados: r.ajustados, detalle: r.ajustesDetalle, almuerzos: r.almuerzosPorMetodo });
});

app.put('/api/pagos/ajustes', requiere(2), (req, res) => {
  const jornada = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.jornada || '')) ? req.body.jornada : jornadaHoy();
  if (jornadaCerrada(jornada)) return res.status(409).json({ error: 'Ese día ya tiene cierre de caja: no se puede corregir' });
  const metodo = req.body.metodo;
  if (metodo === 'efectivo') {
    return res.status(400).json({ error: 'El efectivo no se corrige así: se cuadra contando la caja (base del día y cierre)' });
  }
  if (!METODOS_AJUSTABLES.includes(metodo)) return res.status(400).json({ error: 'Método no válido' });
  const registrado = db.prepare('SELECT COALESCE(SUM(monto), 0) AS t FROM pagos WHERE jornada = ? AND metodo = ?').get(jornada, metodo).t;
  const crudo = String(req.body.total_real ?? '').trim();
  const totalReal = crudo === '' ? null : aEntero(crudo);
  if (totalReal !== null && (!Number.isFinite(totalReal) || totalReal < 0)) return res.status(400).json({ error: 'Valor no válido' });
  if (totalReal === null || totalReal === registrado) {
    // Vacío o igual a lo registrado: se quita la corrección y vuelve a ser exacto
    db.prepare('DELETE FROM ajustes_metodo WHERE jornada = ? AND metodo = ?').run(jornada, metodo);
    registrarHistorial(null, req.usuario.usuarioId, 'ajuste_metodo', `${jornada} ${metodo}: sin corrección`);
  } else {
    // Se guarda contra QUÉ se corrigió: la corrección vale como diferencia
    db.prepare(`INSERT INTO ajustes_metodo (jornada, metodo, total_real, registrado, usuario_id, creado_en) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(jornada, metodo) DO UPDATE SET total_real = excluded.total_real, registrado = excluded.registrado, usuario_id = excluded.usuario_id, creado_en = excluded.creado_en`)
      .run(jornada, metodo, totalReal, registrado, req.usuario.usuarioId, ahora());
    registrarHistorial(null, req.usuario.usuarioId, 'ajuste_metodo', `${jornada} ${metodo}: registrado ${registrado} -> real ${totalReal}`);
  }
  io.emit('caja:actualizada');
  const r = reportes.resumenJornada(jornada);
  res.json({ ok: true, registrado, real: r.porMetodo[metodo] || 0, ajustado: !!r.ajustados[metodo], almuerzos: r.almuerzosPorMetodo[metodo] || null });
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
    // y, si es fin de mes, los dos correos mensuales (nómina y resumen)
    reportes.encolarReporteDiario(jornadaHoy());
    try { reportes.encolarReportesMensuales(jornadaHoy()); }
    catch (e) { registrar('reportes', `No se pudieron armar los reportes mensuales: ${e.message}`); }
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
  reportes.encolarFilaPruebaSheets(reportes.nombreReporte(req.usuario.nombre, req.usuario.rol, true));
  const r = await reportes.drenarSheets({ forzar: true });
  if (r.ok) res.json({ ok: true, enviados: r.enviados });
  else res.status(502).json({ error: r.error, pendientes: r.pendientes });
});

app.get('/api/sync/estado', requiere(3), (_req, res) => res.json(reportes.estadoSync()));

// Estado del Excel en tiempo real para el aviso de arriba (caja y admin)
app.get('/api/sheets/estado', requiere(2), (_req, res) => res.json(reportes.estadoSheets()));

// Solucionador de problemas de Google Sheets: revisa paso por paso y dice
// exactamente qué corregir (y en qué hoja y fila quedó la fila de prueba).
app.post('/api/sheets/diagnostico', requiere(3), async (req, res) => {
  try {
    res.json(await reportes.diagnosticoSheets(reportes.nombreReporte(req.usuario.nombre, req.usuario.rol, true)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Dirección actual del servidor en la red (público: quien pregunta ya está en la LAN).
// Útil cuando la IP cambia, p. ej. al usar el hotspot de un teléfono: el QR de
// la pantalla de login se refresca solo con esta respuesta.
app.get('/api/red', async (req, res) => {
  // Si quien pregunta es un teléfono de la red, la respuesta exacta es la
  // dirección por la que ÉL llegó: esa con seguridad funciona
  const local = (req.socket.localAddress || '').replace('::ffff:', '');
  const datos = {
    url: esClienteDeLaRed(req) && local ? `http://${local}:${PORT}` : urlLan(),
    candidatas: candidatasLan().filter(c => c.prioridad < 10).map(c => ({ url: `http://${c.ip}:${PORT}`, red: c.nombre })),
    aprendida: ipQueFunciona || null
  };
  // Diagnóstico opcional: separa "no hay internet" (Sheets y correo esperan,
  // pero la app local funciona) de "los teléfonos no alcanzan al PC" (WiFi)
  if (req.query.diagnostico) {
    datos.internet = await reportes.hayInternet();
    const sync = reportes.estadoSync();
    datos.sheets_pendientes = sync.sheets_pendientes;
    datos.correos_pendientes = sync.correos_pendientes;
  }
  res.json(datos);
});

app.post('/api/reportes/enviar-ahora', requiere(3), (req, res) => {
  reportes.encolarReporteDiario(jornadaHoy());
  reportes.drenarCorreos().catch(() => {});
  res.json({ ok: true });
});

// (Re)enviar los dos correos mensuales de un mes dado (nómina + resumen)
app.post('/api/reportes/enviar-mes', requiere(3), (req, res) => {
  const mes = /^\d{4}-\d{2}$/.test(String(req.body.mes || '')) ? req.body.mes : jornadaHoy().slice(0, 7);
  try {
    reportes.encolarReportesMensuales(jornadaHoy(), mes);
    reportes.drenarCorreos().catch(() => {});
    res.json({ ok: true, mes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Usuarios (solo admin) ----------
// El turno vale distinto según el día (lunes-jueves, sábado, domingo...):
// `turnos` es un arreglo de 7 valores con el índice de getDay() (0=domingo).
// Un día en 0 o vacío usa el valor base (valor_turno).
function turnosDe(u) {
  try {
    const arr = JSON.parse(u.turnos || 'null');
    if (Array.isArray(arr) && arr.length === 7) return arr.map(v => Math.max(0, Math.round(Number(v) || 0)));
  } catch { }
  return null;
}

function valorTurnoPara(u, jornada) {
  const arr = turnosDe(u);
  if (arr) {
    // Mediodía local: 'YYYY-MM-DD' a secas se interpretaría como UTC y en
    // Colombia (UTC-5) el día se correría al anterior
    const dia = new Date(jornada + 'T12:00:00').getDay();
    if (arr[dia] > 0) return arr[dia];
  }
  return u.valor_turno;
}

app.get('/api/usuarios', requiere(3), (_req, res) => {
  res.json(db.prepare('SELECT id, nombre, rol, valor_turno, turnos, cargo_habitual, activo FROM usuarios WHERE eliminado = 0 ORDER BY nombre').all()
    .map(u => ({ ...u, turnos: turnosDe(u) })));
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

// ¿Este usuario es el único admin activo? Desactivarlo o eliminarlo dejaría
// el sistema sin nadie que pueda administrar.
function esUltimoAdmin(u) {
  return u.rol === 'admin' && u.activo &&
    !db.prepare("SELECT id FROM usuarios WHERE rol = 'admin' AND activo = 1 AND eliminado = 0 AND id != ?").get(u.id);
}

app.put('/api/usuarios/:id', requiere(3), (req, res) => {
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ? AND eliminado = 0').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  const nombre = req.body.nombre !== undefined ? String(req.body.nombre).trim() : u.nombre;
  const rol = req.body.rol !== undefined ? req.body.rol : u.rol;
  const activo = req.body.activo !== undefined ? (req.body.activo ? 1 : 0) : u.activo;
  if ((!activo || rol !== 'admin') && esUltimoAdmin(u)) {
    return res.status(409).json({ error: 'Es el único administrador activo: cree o reactive otro admin primero' });
  }
  let pin = u.pin;
  if (req.body.pin) {
    if (!/^\d{4}$/.test(String(req.body.pin))) return res.status(400).json({ error: 'El PIN debe ser de 4 dígitos' });
    const otro = db.prepare('SELECT id FROM usuarios WHERE pin = ? AND id != ?').get(String(req.body.pin), u.id);
    if (otro) return res.status(409).json({ error: 'Ese PIN ya está asignado a otro usuario' });
    pin = String(req.body.pin);
  }
  // El valor del turno solo lo cambia el admin (este endpoint ya exige admin)
  const valorTurno = req.body.valor_turno !== undefined ? Math.max(0, Math.round(Number(req.body.valor_turno) || 0)) : u.valor_turno;
  let turnos = u.turnos;
  if (req.body.turnos !== undefined) {
    if (req.body.turnos === null) turnos = null;
    else {
      const arr = Array.isArray(req.body.turnos) ? req.body.turnos.map(v => Math.max(0, Math.round(Number(v) || 0))) : null;
      if (!arr || arr.length !== 7) return res.status(400).json({ error: 'Los turnos por día deben ser 7 valores (domingo a sábado)' });
      turnos = arr.some(v => v > 0) ? JSON.stringify(arr) : null; // todo en 0 = sin valores por día
    }
  }
  // Desactivar no borra: sus ventas históricas quedan intactas
  const cargoHabitual = req.body.cargo_habitual !== undefined ? (String(req.body.cargo_habitual).trim().slice(0, 30) || null) : u.cargo_habitual;
  db.prepare('UPDATE usuarios SET nombre = ?, rol = ?, activo = ?, pin = ?, valor_turno = ?, turnos = ?, cargo_habitual = ? WHERE id = ?')
    .run(nombre, rol, activo, pin, valorTurno, turnos, cargoHabitual, u.id);
  // Si se desactivó, le cambiaron el PIN o el rol, la sesión que tenga abierta
  // en su teléfono deja de valer en el acto
  if (!activo || pin !== u.pin || rol !== u.rol) cerrarSesionesDe(u.id);
  res.json({ ok: true });
});

// Eliminar un usuario. Si nunca registró nada, se borra de verdad; si tiene
// ventas/nómina/gastos en la historia, se archiva (desaparece de todas las
// listas y su PIN queda libre) para no dañar los reportes viejos.
app.delete('/api/usuarios/:id', requiere(3), (req, res) => {
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ? AND eliminado = 0').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (u.id === req.usuario.usuarioId) return res.status(409).json({ error: 'No puede eliminar su propio usuario' });
  if (esUltimoAdmin(u)) return res.status(409).json({ error: 'Es el único administrador activo: cree otro admin primero' });
  const referencias =
    db.prepare('SELECT COUNT(*) AS n FROM pedidos WHERE vendedor_id = ?').get(u.id).n +
    db.prepare('SELECT COUNT(*) AS n FROM pagos WHERE cajero_id = ?').get(u.id).n +
    db.prepare('SELECT COUNT(*) AS n FROM gastos WHERE usuario_id = ?').get(u.id).n +
    db.prepare('SELECT COUNT(*) AS n FROM nomina WHERE empleado_id = ? OR registrado_por = ?').get(u.id, u.id).n +
    db.prepare('SELECT COUNT(*) AS n FROM historial WHERE usuario_id = ?').get(u.id).n;
  cerrarSesionesDe(u.id); // su teléfono deja de funcionar de inmediato
  if (referencias === 0) {
    db.prepare('DELETE FROM usuarios WHERE id = ?').run(u.id);
    return res.json({ ok: true, borrado: true });
  }
  // El PIN se libera cambiándolo por una marca imposible de teclear (los PIN
  // reales son 4 dígitos), así otro empleado puede recibir ese número
  db.prepare("UPDATE usuarios SET eliminado = 1, activo = 0, pin = 'X' || id WHERE id = ?").run(u.id);
  res.json({ ok: true, borrado: false, archivado: true });
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
    'factura_titulo', 'factura_razon_social', 'factura_nit', 'factura_direccion', 'factura_telefono', 'factura_leyenda',
    'horas_reporte', 'sheets_activo'];
  for (const [clave, valor] of Object.entries(req.body || {})) {
    if (!permitidas.includes(clave)) continue;
    if (clave === 'gmail_app_password' && valor === '(guardada)') continue;
    // Las URL y credenciales llegan de copiar y pegar: fuera espacios y saltos
    let limpio = ['sheets_webhook_url', 'gmail_usuario', 'gmail_app_password', 'correo_dueno'].includes(clave)
      ? String(valor).trim() : valor;
    if (clave === 'sheets_activo') limpio = (valor === true || valor === 1 || valor === '1') ? '1' : '0';
    setConfig(clave, limpio);
  }
  // El aviso del Excel en tiempo real se actualiza en el acto en todas las
  // pantallas; si lo acaban de prender, lo que estaba en espera sale ya
  if ('sheets_activo' in (req.body || {}) || 'sheets_webhook_url' in (req.body || {})) {
    io.emit('sheets:estado', reportes.estadoSheets());
    if (reportes.sheetsActivo()) reportes.drenarSheets({ forzar: true }).catch(() => {});
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

// ---------- Tipos de plato (pollo, carne, cerdo...): los editan meseros y cajeros ----------
app.get('/api/grupos', requiere(1), (_req, res) => res.json(gruposActuales()));

app.put('/api/grupos', requiere(1), (req, res) => {
  const grupos = Array.isArray(req.body.grupos) ? req.body.grupos : null;
  if (!grupos) return res.status(400).json({ error: 'Formato no válido' });
  const limpios = [...new Set(grupos.map(g => String(g).trim()).filter(g => g && g.length <= 24))].slice(0, 30);
  setConfig('grupos_plato', JSON.stringify(limpios));
  io.emit('menu:config', { grupos_plato: limpios });
  res.json({ ok: true, grupos: limpios });
});

// ---------- Precio por defecto de proteínas del día y especiales ----------
// Lo cambian meseros y cajeros porque es el precio del almuerzo del año, y ya
// pueden fijar precios al crear platos; el cambio aplica a todos los platos
// marcados con "precio por defecto" (las ventas ya registradas no se tocan).
app.put('/api/precios-default', requiere(1), (req, res) => {
  const claves = ['precio_dia_entrada', 'precio_dia_solo', 'precio_especial_entrada', 'precio_especial_solo', 'precio_entrada_sola'];
  for (const clave of claves) {
    if (req.body[clave] === undefined) continue;
    const v = Math.max(0, Math.round(Number(req.body[clave])));
    if (!Number.isFinite(v)) return res.status(400).json({ error: 'Precio no válido' });
    setConfig(clave, String(v));
  }
  const precios = preciosPorDefecto();
  emitirMenu(); // los teléfonos ven los precios nuevos de inmediato
  io.emit('menu:config', { precios_default: precios });
  res.json({ ok: true, precios });
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

// ---------- Nómina: turnos (días trabajados) y pagos ----------
// Dos pasos, como el Kardex de papel: primero se registra el TURNO (qué día
// vino y qué hizo: "lunes, auxiliar de caja"), y otro día se le PAGA el
// acumulado. El cargo va en el turno porque un mismo empleado hace cosas
// distintas cada día. El valor lo fija el cargo (Admin → Cargos de nómina);
// solo el admin puede poner otro valor a mano.
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
const fechaValida = (v, alt) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : alt;

// Roles de nómina (cajero, auxiliar de caja, auxiliar de cocina...) con el
// valor del turno por DÍA DE LA SEMANA: dias[getDay()], 0 = domingo. Sin
// valor "por defecto" (confundía): se escribe el de cada día. Los crean,
// cambian y borran el admin y el cajero (Caja → Turnos y pagos → Roles).
const DIAS_PLURAL = ['los domingos', 'los lunes', 'los martes', 'los miércoles', 'los jueves', 'los viernes', 'los sábados'];
function normalizarRol(c) {
  const n = (v) => Math.max(0, Math.round(Number(v) || 0));
  let dias;
  if (Array.isArray(c.dias)) dias = c.dias.map(n);
  else { // forma vieja: valor normal + sábado + domingo
    const v = n(c.valor);
    dias = [n(c.domingo) || v, v, v, v, v, v, n(c.sabado) || v];
  }
  while (dias.length < 7) dias.push(0);
  return { nombre: String(c.nombre || '').trim().slice(0, 30), dias: dias.slice(0, 7) };
}
function cargosNomina() {
  try { return JSON.parse(getConfig('cargos_nomina') || '[]').filter(c => c && c.nombre).map(normalizarRol); }
  catch { return []; }
}
// Valor de un rol en una fecha: cada día de la semana tiene el suyo
function valorCargo(cargo, jornada) {
  const c = cargosNomina().find(x => x.nombre === cargo);
  if (!c) return null;
  return c.dias[new Date(jornada + 'T12:00:00').getDay()] || 0;
}
// Rol con el que sale preseleccionado un empleado: el habitual que le puso el
// admin o, si no tiene, el que corresponde a su acceso en la app
const ROL_POR_ACCESO = { admin: 'Administrador', cajero: 'Cajero', mesero: 'Mesero', cocinera: 'Cocinera' };
function cargoPorDefecto(u, roles) {
  if (u.cargo_habitual && roles.some(r => r.nombre === u.cargo_habitual)) return u.cargo_habitual;
  const porAcceso = ROL_POR_ACCESO[u.rol];
  return roles.some(r => r.nombre === porAcceso) ? porAcceso : null;
}

app.get('/api/cargos', requiere(2), (_req, res) => res.json(cargosNomina()));

app.put('/api/cargos', requiere(2), (req, res) => {
  const lista = Array.isArray(req.body.cargos) ? req.body.cargos : null;
  if (!lista) return res.status(400).json({ error: 'Formato no válido' });
  const limpios = [], vistos = new Set();
  for (const c of lista) {
    const rol = normalizarRol(c || {});
    if (!rol.nombre || vistos.has(rol.nombre.toLowerCase())) continue;
    vistos.add(rol.nombre.toLowerCase());
    limpios.push(rol);
  }
  setConfig('cargos_nomina', JSON.stringify(limpios.slice(0, 30)));
  registrarHistorial(null, req.usuario.usuarioId, 'roles_nomina',
    limpios.map(r => `${r.nombre}: ${r.dias.join('/')}`).join('; ').slice(0, 300));
  io.emit('nomina:actualizada');
  res.json({ ok: true, cargos: limpios });
});

// ---- Turnos ----
const consultaTurnos = db.prepare(
  `SELECT t.*, u.nombre AS empleado, n.estado AS pago_estado, n.jornada AS pagado_en
   FROM turnos t JOIN usuarios u ON u.id = t.empleado_id LEFT JOIN nomina n ON n.id = t.pago_id
   WHERE t.jornada >= ? AND t.jornada <= ? ORDER BY t.jornada, u.nombre, t.id`);

app.get('/api/turnos', requiere(2), (req, res) => {
  const hoy = jornadaHoy();
  const desde = fechaValida(req.query.desde, hoy.slice(0, 8) + '01');
  const hasta = fechaValida(req.query.hasta, hoy);
  let lista = consultaTurnos.all(desde, hasta);
  if (req.query.empleado) lista = lista.filter(t => t.empleado_id === Number(req.query.empleado));
  res.json(lista);
});

app.post('/api/turnos', requiere(2), (req, res) => {
  const empleado = db.prepare('SELECT * FROM usuarios WHERE id = ? AND activo = 1 AND eliminado = 0').get(req.body.empleado_id);
  if (!empleado) return res.status(404).json({ error: 'Empleado no encontrado' });
  const jornada = fechaValida(req.body.jornada, jornadaHoy());
  if (jornada > jornadaHoy()) return res.status(400).json({ error: 'No se puede registrar un turno de una fecha futura' });
  const cargo = String(req.body.cargo || '').trim();
  if (!cargosNomina().some(c => c.nombre === cargo)) return res.status(400).json({ error: 'Elija el rol que hizo ese día (los roles se crean en 👔 Roles, en esta misma pantalla)' });
  // El valor es el del rol ese día de la semana; solo el admin puede poner otro a mano
  let valor = valorCargo(cargo, jornada);
  if (req.usuario.rol === 'admin' && String(req.body.valor ?? '').trim() !== '') valor = aEntero(req.body.valor);
  if (!(valor > 0)) return res.status(400).json({ error: `El rol "${cargo}" no tiene valor para ${DIAS_PLURAL[new Date(jornada + 'T12:00:00').getDay()]}: póngalo en 👔 Roles y valor del turno por día (en esta misma pantalla)` });
  if (!req.body.repetir && db.prepare('SELECT id FROM turnos WHERE empleado_id = ? AND jornada = ? AND cargo = ?').get(empleado.id, jornada, cargo)) {
    return res.status(409).json({ error: `${empleado.nombre} ya tiene un turno de ${cargo} el ${jornada}`, duplicado: true });
  }
  const nota = String(req.body.nota || '').trim().slice(0, 80) || null;
  const r = db.prepare('INSERT INTO turnos (empleado_id, jornada, cargo, valor, nota, registrado_por, creado_en) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(empleado.id, jornada, cargo, valor, nota, req.usuario.usuarioId, ahora());
  registrarHistorial(null, req.usuario.usuarioId, 'turno', `${empleado.nombre} ${jornada} ${cargo} ${valor}`);
  io.emit('nomina:actualizada');
  res.json({ id: r.lastInsertRowid, valor });
});

// Editar o borrar un turno (solo admin, también de días pasados). Si ya está
// pagado, primero hay que borrar ese pago: si no, la suma del pago no cuadraría.
app.put('/api/turnos/:id', requiere(3), (req, res) => {
  const t = db.prepare('SELECT * FROM turnos WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Turno no encontrado' });
  if (t.pago_id) return res.status(409).json({ error: 'Ese turno ya está pagado: borre primero el pago para poder cambiarlo' });
  const jornada = fechaValida(req.body.jornada, t.jornada);
  const cargo = req.body.cargo !== undefined ? String(req.body.cargo).trim() : t.cargo;
  if (!cargosNomina().some(c => c.nombre === cargo)) return res.status(400).json({ error: 'Rol no válido' });
  let valor = t.valor;
  if (String(req.body.valor ?? '').trim() !== '') valor = aEntero(req.body.valor);
  else if (cargo !== t.cargo || jornada !== t.jornada) valor = valorCargo(cargo, jornada) || t.valor;
  if (!(valor > 0)) return res.status(400).json({ error: 'Valor no válido' });
  const nota = req.body.nota !== undefined ? (String(req.body.nota).trim().slice(0, 80) || null) : t.nota;
  db.prepare('UPDATE turnos SET jornada = ?, cargo = ?, valor = ?, nota = ? WHERE id = ?').run(jornada, cargo, valor, nota, t.id);
  registrarHistorial(null, req.usuario.usuarioId, 'turno_editado', `#${t.id}: ${jornada} ${cargo} ${valor}`);
  io.emit('nomina:actualizada');
  res.json({ ok: true, valor });
});

app.delete('/api/turnos/:id', requiere(3), (req, res) => {
  const t = db.prepare('SELECT * FROM turnos WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Turno no encontrado' });
  if (t.pago_id) return res.status(409).json({ error: 'Ese turno ya está pagado: borre primero el pago' });
  db.prepare('DELETE FROM turnos WHERE id = ?').run(t.id);
  registrarHistorial(null, req.usuario.usuarioId, 'turno_borrado', `#${t.id}: ${t.jornada} ${t.cargo} ${t.valor}`);
  io.emit('nomina:actualizada');
  res.json({ ok: true });
});

// ---- Pagos ----
const turnosDelPago = db.prepare('SELECT id, jornada, cargo, valor FROM turnos WHERE pago_id = ? ORDER BY jornada, id');
function pagoConTurnos(n) { return { ...n, turnos: turnosDelPago.all(n.id) }; }

// La cajera paga el acumulado de turnos sin pagar; el empleado confirma en su teléfono
app.post('/api/nomina', requiere(2), (req, res) => {
  if (!validarJornadaAbierta(res)) return;
  const empleado = db.prepare('SELECT * FROM usuarios WHERE id = ? AND activo = 1 AND eliminado = 0').get(req.body.empleado_id);
  if (!empleado) return res.status(404).json({ error: 'Empleado no encontrado' });
  const ids = (Array.isArray(req.body.turno_ids) ? req.body.turno_ids : []).map(Number).filter(Number.isInteger);
  const turnos = ids.length
    ? db.prepare(`SELECT * FROM turnos WHERE id IN (${ids.map(() => '?').join(',')}) AND empleado_id = ? AND pago_id IS NULL`).all(...ids, empleado.id)
    : [];
  if (!turnos.length) return res.status(400).json({ error: 'Elija al menos un turno sin pagar' });
  const suma = turnos.reduce((s, t) => s + t.valor, 0);
  const descuento = aEntero(req.body.descuento) || 0;
  const bono = aEntero(req.body.bono) || 0;
  const concepto = String(req.body.concepto || '').trim().slice(0, 80) || null;
  const total = suma - descuento + bono;
  if (total <= 0) return res.status(400).json({ error: 'El total del pago debe ser mayor a cero' });
  const id = db.transaction(() => {
    const r = db.prepare(
      `INSERT INTO nomina (empleado_id, jornada, valor_turno, descuento, bono, total, concepto, estado, registrado_por, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?)`)
      .run(empleado.id, jornadaHoy(), suma, descuento, bono, total, concepto, req.usuario.usuarioId, ahora());
    const marcar = db.prepare('UPDATE turnos SET pago_id = ? WHERE id = ?');
    for (const t of turnos) marcar.run(r.lastInsertRowid, t.id);
    return r.lastInsertRowid;
  })();
  registrarHistorial(null, req.usuario.usuarioId, 'pago_nomina', `${empleado.nombre}: ${turnos.length} turno(s) = ${total}`);
  const pago = pagoConTurnos(db.prepare('SELECT * FROM nomina WHERE id = ?').get(id));
  // Aviso directo al teléfono del empleado para que confirme
  io.to(`usuario:${empleado.id}`).emit('nomina:pendiente', { ...pago, empleado: empleado.nombre });
  io.emit('nomina:actualizada');
  res.json({ id, total, turnos: turnos.length });
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

// Corregir descuento, bono o concepto de un pago (admin, también de días
// pasados). El total se recalcula con los turnos que tiene enlazados.
app.put('/api/nomina/:id', requiere(3), (req, res) => {
  const n = db.prepare('SELECT * FROM nomina WHERE id = ?').get(req.params.id);
  if (!n) return res.status(404).json({ error: 'Pago no encontrado' });
  const suma = turnosDelPago.all(n.id).reduce((s, t) => s + t.valor, 0) || n.valor_turno;
  const descuento = req.body.descuento !== undefined ? (aEntero(req.body.descuento) || 0) : n.descuento;
  const bono = req.body.bono !== undefined ? (aEntero(req.body.bono) || 0) : n.bono;
  const concepto = req.body.concepto !== undefined ? (String(req.body.concepto).trim().slice(0, 80) || null) : n.concepto;
  const total = suma - descuento + bono;
  if (total <= 0) return res.status(400).json({ error: 'El total del pago debe ser mayor a cero' });
  db.prepare('UPDATE nomina SET valor_turno = ?, descuento = ?, bono = ?, total = ?, concepto = ? WHERE id = ?')
    .run(suma, descuento, bono, total, concepto, n.id);
  registrarHistorial(null, req.usuario.usuarioId, 'pago_nomina_editado', `#${n.id} ${n.jornada}: total ${n.total} -> ${total}`);
  io.emit('nomina:actualizada');
  io.emit('caja:actualizada');
  res.json({ ok: true, total });
});

// Borrar un pago (admin), también de días pasados: p. ej. una nómina pagada
// por error. Sus turnos vuelven a quedar sin pagar, no se pierden.
app.delete('/api/nomina/:id', requiere(3), (req, res) => {
  const n = db.prepare('SELECT n.*, u.nombre AS empleado FROM nomina n JOIN usuarios u ON u.id = n.empleado_id WHERE n.id = ?').get(req.params.id);
  if (!n) return res.status(404).json({ error: 'Pago no encontrado' });
  db.transaction(() => {
    db.prepare('UPDATE turnos SET pago_id = NULL WHERE pago_id = ?').run(n.id);
    db.prepare('DELETE FROM nomina WHERE id = ?').run(n.id);
  })();
  registrarHistorial(null, req.usuario.usuarioId, 'pago_nomina_borrado', `${n.empleado} ${n.jornada} ${n.total} (${n.estado})`);
  io.emit('nomina:actualizada');
  io.emit('caja:actualizada');
  res.json({ ok: true });
});

// Anular (se conserva por compatibilidad): el pago queda marcado y sus turnos
// vuelven a estar sin pagar
app.post('/api/nomina/:id/anular', requiere(3), (req, res) => {
  db.transaction(() => {
    db.prepare("UPDATE nomina SET estado = 'anulado' WHERE id = ?").run(req.params.id);
    db.prepare('UPDATE turnos SET pago_id = NULL WHERE pago_id = ?').run(req.params.id);
  })();
  io.emit('nomina:actualizada');
  io.emit('caja:actualizada');
  res.json({ ok: true });
});

// Todo lo que necesita la pantalla de nómina en una sola consulta
app.get('/api/nomina/resumen', requiere(2), (req, res) => {
  const hoy = jornadaHoy();
  const sumaDesde = db.prepare(
    "SELECT COALESCE(SUM(total), 0) AS t FROM nomina WHERE empleado_id = ? AND estado = 'confirmado' AND jornada >= ? AND jornada <= ?");
  const sinPagarDe = db.prepare('SELECT id, jornada, cargo, valor, nota FROM turnos WHERE empleado_id = ? AND pago_id IS NULL ORDER BY jornada, id');
  const roles = cargosNomina();
  const empleados = db.prepare('SELECT id, nombre, rol, cargo_habitual FROM usuarios WHERE activo = 1 AND eliminado = 0 ORDER BY nombre').all()
    .map(u => {
      const sinPagar = sinPagarDe.all(u.id);
      return {
        ...u, cargo_default: cargoPorDefecto(u, roles),
        sinPagar, totalSinPagar: sinPagar.reduce((s, t) => s + t.valor, 0),
        dia: sumaDesde.get(u.id, hoy, hoy).t,
        semana: sumaDesde.get(u.id, inicioSemana(), hoy).t,
        quincena: sumaDesde.get(u.id, inicioQuincena(), hoy).t,
        mes: sumaDesde.get(u.id, inicioMes(), hoy).t
      };
    });
  const pendientes = db.prepare(
    `SELECT n.*, u.nombre AS empleado, u.rol AS empleado_rol FROM nomina n JOIN usuarios u ON u.id = n.empleado_id
     WHERE n.estado = 'pendiente' ORDER BY n.id DESC`).all().map(pagoConTurnos);
  const mes = /^\d{4}-\d{2}$/.test(String(req.query.mes || '')) ? req.query.mes : hoy.slice(0, 7);
  const pagosMes = db.prepare(
    `SELECT n.*, u.nombre AS empleado FROM nomina n JOIN usuarios u ON u.id = n.empleado_id
     WHERE n.jornada >= ? AND n.jornada <= ? ORDER BY n.jornada DESC, n.id DESC`).all(mes + '-01', mes + '-31').map(pagoConTurnos);
  const turnosMes = consultaTurnos.all(mes + '-01', mes + '-31');
  res.json({ hoy, mes, cargos: roles, empleados, pendientes, pagosMes, turnosMes });
});

// ---------- Impresión ----------
app.get('/api/impresion/cola', requiere(1), (_req, res) => res.json(impresion.estadoCola()));

app.post('/api/impresion/:id/reintentar', requiere(1), (req, res) => {
  impresion.reintentarTrabajo(req.params.id);
  res.json({ ok: true });
});

app.post('/api/impresion/:id/descartar', requiere(1), (req, res) => {
  impresion.descartarTrabajo(req.params.id);
  res.json({ ok: true });
});

app.post('/api/impresion/descartar-fallidos', requiere(1), (req, res) => {
  const n = impresion.descartarNoImpresos();
  res.json({ ok: true, descartados: n });
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
  // Sin sesión válida no se entra: por este canal viajan en vivo TODAS las
  // comandas del día (platos, totales y nombre del cliente), así que un
  // dispositivo cualquiera del WiFi no puede quedarse escuchando.
  if (!u) {
    socket.emit('error:auth', 'Inicie sesión de nuevo');
    return socket.disconnect(true);
  }
  socket.join(`usuario:${u.usuarioId}`);
  socket.on('impresora:registrar', () => impresion.registrarPuente(socket));
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
      // Rangos típicos del hotspot de un teléfono: si el PC está colgado de uno,
      // ahí es donde están los meseros
      if (/^192\.168\.43\.|^172\.20\.10\.|^192\.168\.137\./.test(ip)) prioridad -= 2;
      // LA REGLA QUE MANDA: si un teléfono YA se conectó por esta dirección,
      // es la buena. Adivinar por el rango falla cuando el PC tiene varias redes
      // al tiempo (cable + hotspot): se anunciaba la del cable, donde no hay
      // ningún mesero, y nadie podía conectarse.
      if (ip === ipQueFunciona) prioridad = -100;
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
  console.log('Puede dejar esta ventana minimizada; NO la cierre durante el servicio.');
  console.log(`Lo que el sistema hace por dentro queda anotado en ${path.join(DATA_DIR, 'registro.log')}`);
  console.log('==============================================');
  // La app se abre sola en el navegador de este PC: lo que la cajera ve es el
  // POS funcionando, no una ventana negra con mensajes
  if (process.platform === 'win32' && process.env.POS_SIN_NAVEGADOR !== '1') {
    exec(`start "" "http://localhost:${PORT}"`, () => {});
  }
  reportes.iniciarPlanificador();
  impresion.procesarCola(); // retomar comandas que quedaron pendientes tras un reinicio
  // Los platos grandes del ticket se dibujan con la letra de Windows. Si no se
  // pudiera leer, el ticket sigue saliendo con la letra de la impresora (2x),
  // pero conviene verlo aquí y no descubrirlo por un ticket más pequeño.
  try {
    require('./fuente-ttf').cargarFuente();
  } catch (e) {
    console.warn('[raster] No se pudo leer la fuente de Windows:', e.message);
    console.warn('[raster] Los platos se imprimirán con la letra de la impresora (tamaño 2x).');
  }
  precalentarMenu(); // pre-render de los nombres del menú
});

// Reportes, cierre de caja, cola de correo del reporte diario y
// sincronización con Google Sheets (vía webhook de Google Apps Script).
const { db, ahora, jornadaHoy, getConfig } = require('./db');

// ---- Resumen de una jornada ----
function resumenJornada(jornada) {
  const pedidos = db.prepare(
    `SELECT p.*, u.nombre AS vendedor FROM pedidos p JOIN usuarios u ON u.id = p.vendedor_id
     WHERE p.jornada = ?`).all(jornada);
  const pagos = db.prepare('SELECT * FROM pagos WHERE jornada = ?').all(jornada);

  const porMetodo = {};
  for (const pg of pagos) porMetodo[pg.metodo] = (porMetodo[pg.metodo] || 0) + pg.monto;

  const porVendedor = {};
  for (const p of pedidos) {
    if (!porVendedor[p.vendedor]) porVendedor[p.vendedor] = { pedidos: 0, total: 0, cancelados: 0 };
    if (p.estado === 'cancelado') porVendedor[p.vendedor].cancelados++;
    else { porVendedor[p.vendedor].pedidos++; porVendedor[p.vendedor].total += p.total; }
  }

  const efectivos = pedidos.filter(p => p.estado !== 'cancelado');
  const cancelados = pedidos.filter(p => p.estado === 'cancelado');
  const pagadosIds = new Set(pagos.map(pg => pg.pedido_id));
  const porCobrar = efectivos.filter(p => !pagadosIds.has(p.id));

  const gastos = db.prepare('SELECT g.*, u.nombre AS usuario FROM gastos g JOIN usuarios u ON u.id = g.usuario_id WHERE g.jornada = ?').all(jornada);
  const nominaDia = db.prepare(
    `SELECT n.*, u.nombre AS empleado FROM nomina n JOIN usuarios u ON u.id = n.empleado_id
     WHERE n.jornada = ? AND n.estado = 'confirmado'`).all(jornada);
  const ventasEfectivo = pagos.filter(pg => pg.metodo === 'efectivo').reduce((s, pg) => s + pg.monto, 0);
  const totalGastos = gastos.reduce((s, g) => s + g.valor, 0);
  const totalNomina = nominaDia.reduce((s, n) => s + n.total, 0);

  return {
    jornada,
    totalVentas: efectivos.reduce((s, p) => s + p.total, 0),
    totalCobrado: pagos.reduce((s, pg) => s + pg.monto, 0),
    numPedidos: efectivos.length,
    numCancelados: cancelados.length,
    totalCancelado: cancelados.reduce((s, p) => s + p.total, 0),
    totalRecargos: efectivos.reduce((s, p) => s + p.recargo, 0),
    totalRecargoTarjeta: pagos.reduce((s, pg) => s + (pg.recargo_tarjeta || 0), 0),
    porMetodo, porVendedor,
    porCobrar: porCobrar.map(p => ({ id: p.id, numero_comanda: p.numero_comanda, comensal: p.comensal, total: p.total, vendedor: p.vendedor })),
    gastos: gastos.map(g => ({ id: g.id, concepto: g.concepto, valor: g.valor, usuario: g.usuario })),
    totalGastos,
    nomina: nominaDia.map(n => ({ empleado: n.empleado, turno: n.valor_turno, descuento: n.descuento, bono: n.bono, total: n.total })),
    totalNomina,
    // Efectivo que debería haber físicamente: ventas en efectivo menos lo que salió de la caja
    efectivoEsperado: ventasEfectivo - totalGastos - totalNomina
  };
}

// ---- Cierre de caja ----
function ejecutarCierre(jornada, efectivoContado, usuarioId) {
  const existente = db.prepare('SELECT id FROM cierres WHERE jornada = ?').get(jornada);
  if (existente) throw new Error('La jornada ya tiene cierre de caja registrado');
  const resumen = resumenJornada(jornada);
  // El efectivo esperado ya descuenta gastos del local y nómina pagada
  const descuadre = efectivoContado === null ? null : efectivoContado - resumen.efectivoEsperado;
  db.prepare('INSERT INTO cierres (jornada, datos, efectivo_contado, descuadre, creado_en) VALUES (?, ?, ?, ?, ?)')
    .run(jornada, JSON.stringify(resumen), efectivoContado, descuadre, ahora());
  db.prepare('INSERT INTO historial (pedido_id, usuario_id, accion, detalle, creado_en) VALUES (NULL, ?, ?, ?, ?)')
    .run(usuarioId, 'cierre_caja', `Jornada ${jornada}, descuadre: ${descuadre}`, ahora());
  // Privacidad: al cerrar la jornada se borran los nombres de los clientes de la
  // base de datos y los tickets guardados en la cola de impresión que los contienen
  db.prepare("UPDATE pedidos SET comensal = '' WHERE jornada = ?").run(jornada);
  db.prepare('DELETE FROM cola_impresion WHERE pedido_id IN (SELECT id FROM pedidos WHERE jornada = ?)').run(jornada);
  return { ...resumen, efectivoSistema: resumen.porMetodo.efectivo || 0, efectivoContado, descuadre };
}

// ---- Reporte diario por correo ----
function textoReporte(resumen) {
  const fmt = n => '$' + Number(n || 0).toLocaleString('es-CO');
  const lineas = [
    `REPORTE DIARIO - ${getConfig('nombre_restaurante')} - Jornada ${resumen.jornada}`,
    '',
    `Ventas totales: ${fmt(resumen.totalVentas)} (${resumen.numPedidos} pedidos)`,
    `Cobrado: ${fmt(resumen.totalCobrado)}`,
    `Cancelados: ${resumen.numCancelados} por ${fmt(resumen.totalCancelado)}`,
    `Recargos por empaque: ${fmt(resumen.totalRecargos)}`,
    '',
    'Por método de pago:'
  ];
  for (const [m, v] of Object.entries(resumen.porMetodo)) lineas.push(`  - ${m}: ${fmt(v)}`);
  if (resumen.totalRecargoTarjeta) lineas.push(`  (incluye ${fmt(resumen.totalRecargoTarjeta)} de recargos por tarjeta)`);
  lineas.push('', 'Por vendedor:');
  for (const [v, d] of Object.entries(resumen.porVendedor)) {
    lineas.push(`  - ${v}: ${d.pedidos} pedidos, ${fmt(d.total)} (cancelados: ${d.cancelados})`);
  }
  if (resumen.gastos.length) {
    lineas.push('', `GASTOS DEL LOCAL (${fmt(resumen.totalGastos)}):`);
    for (const g of resumen.gastos) lineas.push(`  - ${g.concepto}: ${fmt(g.valor)} (registró ${g.usuario})`);
  }
  if (resumen.nomina.length) {
    lineas.push('', `NOMINA PAGADA (${fmt(resumen.totalNomina)}):`);
    for (const n of resumen.nomina) {
      lineas.push(`  - ${n.empleado}: turno ${fmt(n.turno)}${n.descuento ? `, descuento -${fmt(n.descuento)}` : ''}${n.bono ? `, bono +${fmt(n.bono)}` : ''} = ${fmt(n.total)}`);
    }
  }
  lineas.push('', `Efectivo esperado en caja: ${fmt(resumen.efectivoEsperado)}`);
  lineas.push('(ventas en efectivo menos gastos y nómina)');
  if (resumen.porCobrar.length) {
    lineas.push('', 'PENDIENTES DE COBRO:');
    for (const p of resumen.porCobrar) lineas.push(`  - Comanda ${p.numero_comanda}: ${fmt(p.total)}`);
  }
  return lineas.join('\n');
}

function encolarReporteDiario(jornada) {
  const resumen = resumenJornada(jornada);
  const asunto = `Reporte diario ${jornada} - ${getConfig('nombre_restaurante')}`;
  let cuerpo = textoReporte(resumen);
  // Si la jornada ya tiene cierre de caja, el reporte incluye el arqueo
  const cierre = db.prepare('SELECT * FROM cierres WHERE jornada = ?').get(jornada);
  if (cierre) {
    const fmt = n => '$' + Number(n || 0).toLocaleString('es-CO');
    const efectivoSistema = (JSON.parse(cierre.datos).porMetodo || {}).efectivo || 0;
    cuerpo += `\n\nCIERRE DE CAJA:\n  Efectivo según sistema: ${fmt(efectivoSistema)}`;
    if (cierre.efectivo_contado !== null) {
      cuerpo += `\n  Efectivo contado: ${fmt(cierre.efectivo_contado)}`;
      cuerpo += `\n  Descuadre: ${cierre.descuadre === 0 ? 'caja cuadrada' : (cierre.descuadre > 0 ? 'sobran ' : 'faltan ') + fmt(Math.abs(cierre.descuadre))}`;
    }
  }
  db.prepare('INSERT INTO cola_correos (jornada, asunto, cuerpo, estado, creado_en) VALUES (?, ?, ?, ?, ?)')
    .run(jornada, asunto, cuerpo, 'pendiente', ahora());
}

async function drenarCorreos() {
  const usuario = getConfig('gmail_usuario');
  const password = getConfig('gmail_app_password');
  const destino = getConfig('correo_dueno');
  const pendientes = db.prepare("SELECT * FROM cola_correos WHERE estado = 'pendiente' ORDER BY id").all();
  if (!pendientes.length) return { ok: true, enviados: 0, pendientes: 0 };
  if (!usuario || !password || !destino) {
    return { ok: false, enviados: 0, pendientes: pendientes.length, error: 'Faltan datos de Gmail o el correo del dueño en la configuración' };
  }
  const nodemailer = require('nodemailer');
  const transporte = nodemailer.createTransport({ service: 'gmail', auth: { user: usuario, pass: password } });
  let enviados = 0;
  for (const correo of pendientes) {
    try {
      await transporte.sendMail({
        from: usuario, to: destino,
        subject: correo.asunto,
        text: correo.cuerpo + (correo.jornada !== jornadaHoy() ? `\n\n(Enviado con retraso; corresponde a la jornada ${correo.jornada})` : '')
      });
      db.prepare("UPDATE cola_correos SET estado = 'enviado', enviado_en = ? WHERE id = ?").run(ahora(), correo.id);
      enviados++;
      console.log(`[reportes] Correo enviado: ${correo.asunto}`);
    } catch (err) {
      console.error('[reportes] Fallo al enviar correo (se reintentará):', err.message);
      return { ok: false, enviados, pendientes: pendientes.length - enviados, error: err.message };
    }
  }
  return { ok: true, enviados, pendientes: 0 };
}

// ---- Google Sheets (webhook de Apps Script, sin OAuth para mantenerlo simple) ----
function encolarVentaSheets(pedido, items, pago, vendedor) {
  // Privacidad: el nombre del comensal NUNCA se envía a Google Sheets
  const fila = {
    fecha: pedido.jornada,
    hora: (pago.creado_en || '').slice(11, 16),
    comanda: pedido.numero_comanda,
    vendedor,
    tipo_entrega: pedido.tipo_entrega,
    detalle: items.map(i => `${i.cantidad}x ${i.plato_nombre}`).join('; '),
    metodo_pago: pago.metodo,
    recargo: pedido.recargo,
    recargo_tarjeta: pago.recargo_tarjeta || 0,
    total: pedido.total + (pago.recargo_tarjeta || 0)
  };
  db.prepare('INSERT INTO cola_sheets (payload, estado, creado_en) VALUES (?, ?, ?)')
    .run(JSON.stringify(fila), 'pendiente', ahora());
}

async function drenarSheets() {
  const url = getConfig('sheets_webhook_url');
  const pendientes = db.prepare("SELECT * FROM cola_sheets WHERE estado = 'pendiente' ORDER BY id LIMIT 100").all();
  if (!pendientes.length) return { ok: true, enviados: 0, pendientes: 0 };
  if (!url) return { ok: false, enviados: 0, pendientes: pendientes.length, error: 'No hay URL del webhook de Google Sheets configurada' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filas: pendientes.map(p => JSON.parse(p.payload)) })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const marcar = db.prepare("UPDATE cola_sheets SET estado = 'enviado', enviado_en = ? WHERE id = ?");
    const tx = db.transaction(() => { for (const p of pendientes) marcar.run(ahora(), p.id); });
    tx();
    console.log(`[sheets] ${pendientes.length} venta(s) sincronizada(s)`);
    return { ok: true, enviados: pendientes.length, pendientes: 0 };
  } catch (err) {
    console.error('[sheets] Sin conexión o error del webhook (quedan en búfer):', err.message);
    return { ok: false, enviados: 0, pendientes: pendientes.length, error: err.message };
  }
}

// Estado de las colas de sincronización, para mostrarlo en Admin
function estadoSync() {
  return {
    sheets_pendientes: db.prepare("SELECT COUNT(*) AS n FROM cola_sheets WHERE estado = 'pendiente'").get().n,
    correos_pendientes: db.prepare("SELECT COUNT(*) AS n FROM cola_correos WHERE estado = 'pendiente'").get().n,
    sheets_configurado: !!getConfig('sheets_webhook_url'),
    correo_configurado: !!(getConfig('gmail_usuario') && getConfig('gmail_app_password') && getConfig('correo_dueno'))
  };
}

// ---- Planificador: reporte automático a la hora configurada + drenaje de colas ----
let ultimaJornadaReportada = null;
function iniciarPlanificador() {
  setInterval(async () => {
    try {
      const jornada = jornadaHoy();
      const horaConfig = getConfig('hora_reporte'); // se lee en cada ciclo: cambia sin reiniciar
      const d = new Date();
      const horaActual = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const yaEncolado = db.prepare('SELECT id FROM cola_correos WHERE jornada = ?').get(jornada);
      if (horaActual >= horaConfig && !yaEncolado && ultimaJornadaReportada !== jornada) {
        ultimaJornadaReportada = jornada;
        encolarReporteDiario(jornada);
        console.log(`[reportes] Reporte de la jornada ${jornada} encolado (hora configurada: ${horaConfig})`);
      }
      await drenarCorreos();
      await drenarSheets();
    } catch (err) {
      console.error('[planificador]', err.message);
    }
  }, 30000);
}

module.exports = { resumenJornada, ejecutarCierre, encolarReporteDiario, encolarVentaSheets, iniciarPlanificador, drenarCorreos, drenarSheets, estadoSync };

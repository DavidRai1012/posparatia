// Reportes, cierre de caja, cola de correo del reporte diario y
// sincronización con Google Sheets (vía webhook de Google Apps Script).
const { db, ahora, jornadaHoy, getConfig, setConfig } = require('./db');

// Toda salida a internet lleva tope de tiempo. El restaurante navega por el
// hotspot de un teléfono: cuando los datos se acaban o la señal se cae, la
// conexión muchas veces NO falla, se queda muda — y sin tope, un fetch espera
// hasta 5 minutos (y el cierre de caja, hasta 2 minutos por el correo).
const TIMEOUT_INTERNET_MS = 15000;
function fetchConTimeout(url, opciones = {}) {
  return fetch(url, { ...opciones, signal: AbortSignal.timeout(TIMEOUT_INTERNET_MS) });
}
function errorDeRed(err) {
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return 'Internet no respondió en 15 segundos (¿el teléfono que comparte los datos tiene señal?)';
  }
  return (err && (err.cause && err.cause.message || err.message)) || String(err);
}

// ---- Qué se vendió, plato por plato y tipo por tipo ----
// Responde las dos preguntas del dueño: "¿cuántos pollo a la jardinera salieron?"
// y "¿cuántos almuerzos de pollo en total?" (para saber qué comprar más).
// El "tipo" (pollo, carne, cerdo...) se guarda en platos.grupo.
// Ojo: hay platos homónimos inactivos de días viejos, por eso el ORDER BY.
function ventasPorPlato(desde, hasta) {
  const items = db.prepare(
    `SELECT pi.plato_nombre, pi.precio, pi.cantidad, pi.solo,
            (SELECT pl.tipo  FROM platos pl WHERE pl.nombre = pi.plato_nombre ORDER BY pl.activo DESC, pl.id DESC LIMIT 1) AS tipo,
            (SELECT pl.grupo FROM platos pl WHERE pl.nombre = pi.plato_nombre ORDER BY pl.activo DESC, pl.id DESC LIMIT 1) AS grupo
     FROM pedido_items pi JOIN pedidos p ON p.id = pi.pedido_id
     WHERE p.jornada >= ? AND p.jornada <= ? AND p.estado != 'cancelado'`).all(desde, hasta);

  const platos = new Map(), grupos = new Map();
  for (const it of items) {
    const valor = it.precio * it.cantidad;
    const p = platos.get(it.plato_nombre) || { nombre: it.plato_nombre, tipo: it.tipo, grupo: it.grupo || '', cantidad: 0, solos: 0, total: 0 };
    p.cantidad += it.cantidad;
    p.total += valor;
    if (it.solo) p.solos += it.cantidad;
    platos.set(it.plato_nombre, p);
    // El resumen por tipo cuenta proteínas: es lo que se compra en la plaza
    if (it.tipo === 'proteina_dia' || it.tipo === 'proteina_especial') {
      const clave = it.grupo || 'Sin tipo';
      const g = grupos.get(clave) || { grupo: clave, cantidad: 0, solos: 0, total: 0 };
      g.cantidad += it.cantidad;
      g.total += valor;
      if (it.solo) g.solos += it.cantidad;
      grupos.set(clave, g);
    }
  }
  const porCantidad = (a, b) => b.cantidad - a.cantidad || a.nombre?.localeCompare(b.nombre) || 0;
  return {
    desde, hasta,
    platos: [...platos.values()].sort(porCantidad),
    grupos: [...grupos.values()].sort((a, b) => b.cantidad - a.cantidad)
  };
}

// ---- Resumen de una jornada ----
// En los reportes, quien es administrador aparece con su cargo: el gerente del
// restaurante también vende, y "Pepito Pérez (Administrador)" deja claro quién
// es. `corto` da "(Admin)" para columnas estrechas (Google Sheets).
function nombreReporte(nombre, rol, corto) {
  return rol === 'admin' ? `${nombre} (${corto ? 'Admin' : 'Administrador'})` : nombre;
}

// Base de caja: el dinero con el que arrancó el día. La registrada hoy manda;
// si no hay, se asume que lo contado en el cierre anterior sigue en la caja
// (y si ayer no contaron, lo que el sistema esperaba que hubiera).
function baseCajaDe(jornada) {
  const reg = db.prepare(
    `SELECT b.valor, u.nombre AS usuario FROM base_caja b LEFT JOIN usuarios u ON u.id = b.usuario_id WHERE b.jornada = ?`).get(jornada);
  if (reg) return { valor: reg.valor, origen: 'registrada', usuario: reg.usuario, jornadaOrigen: jornada, incierta: false };
  const ant = db.prepare('SELECT jornada, efectivo_contado, datos FROM cierres WHERE jornada < ? ORDER BY jornada DESC LIMIT 1').get(jornada);
  if (!ant) return { valor: 0, origen: 'ninguna', jornadaOrigen: null, incierta: false, diasSinCierre: [] };
  // Días con ventas entre ese cierre y hoy que quedaron SIN cerrar: su efectivo
  // también está en la caja y nadie lo contó, así que la base es una suposición
  // y hay que avisarlo en vez de dar un número falsamente exacto.
  const diasSinCierre = db.prepare(
    `SELECT DISTINCT p.jornada FROM pedidos p WHERE p.jornada > ? AND p.jornada < ?
       AND NOT EXISTS (SELECT 1 FROM cierres c WHERE c.jornada = p.jornada) ORDER BY p.jornada`)
    .all(ant.jornada, jornada).map(r => r.jornada);
  const base = { jornadaOrigen: ant.jornada, incierta: diasSinCierre.length > 0, diasSinCierre };
  if (ant.efectivo_contado !== null) return { ...base, valor: ant.efectivo_contado, origen: 'contado_anterior' };
  let esperado = 0;
  try { esperado = Number(JSON.parse(ant.datos).efectivoEsperado) || 0; } catch { }
  return { ...base, valor: esperado, origen: 'esperado_anterior' };
}

function resumenJornada(jornada) {
  const pedidos = db.prepare(
    `SELECT p.*, u.nombre AS vendedor_nombre, u.rol AS vendedor_rol FROM pedidos p JOIN usuarios u ON u.id = p.vendedor_id
     WHERE p.jornada = ?`).all(jornada);
  for (const p of pedidos) p.vendedor = nombreReporte(p.vendedor_nombre, p.vendedor_rol);
  const pagos = db.prepare('SELECT * FROM pagos WHERE jornada = ?').all(jornada);

  // Lo registrado pago a pago, y encima la corrección del TOTAL por método si
  // la cajera la hizo (p. ej. el Nequi real según el extracto del banco)
  const porMetodoRegistrado = {};
  for (const pg of pagos) porMetodoRegistrado[pg.metodo] = (porMetodoRegistrado[pg.metodo] || 0) + pg.monto;
  const porMetodo = { ...porMetodoRegistrado };
  const ajustados = {}, ajustesDetalle = {};
  for (const a of db.prepare('SELECT * FROM ajustes_metodo WHERE jornada = ?').all(jornada)) {
    // Diferencia, no reemplazo: si después de corregir entra un pago, se anula
    // uno o se rectifica su método, el total real se mueve con ellos.
    const registradoAhora = porMetodoRegistrado[a.metodo] || 0;
    const diferencia = a.total_real - a.registrado;
    porMetodo[a.metodo] = Math.max(0, registradoAhora + diferencia);
    ajustados[a.metodo] = true;
    ajustesDetalle[a.metodo] = { diferencia, registradoAlCorregir: a.registrado, registradoAhora,
      cambiaronPagos: registradoAhora !== a.registrado };
  }

  // Almuerzos por método de pago. Exacto: proteínas de los pedidos pagados con
  // ese método. Si el total del método fue corregido a mano ya no se sabe a
  // qué pedidos corresponde: se estima dividiendo por el precio del almuerzo
  // y se marca APROXIMADO.
  const almuerzosExactos = {};
  for (const r of db.prepare(
    `SELECT pg.metodo, SUM(pi.cantidad) AS n
     FROM pagos pg JOIN pedidos p ON p.id = pg.pedido_id JOIN pedido_items pi ON pi.pedido_id = p.id
     WHERE pg.jornada = ? AND p.estado != 'cancelado' AND pi.solo = 0
       AND (SELECT pl.tipo FROM platos pl WHERE pl.nombre = pi.plato_nombre ORDER BY pl.activo DESC, pl.id DESC LIMIT 1)
           IN ('proteina_dia', 'proteina_especial')
     GROUP BY pg.metodo`).all(jornada)) almuerzosExactos[r.metodo] = r.n;
  const precioAlmuerzo = Number(getConfig('precio_dia_entrada')) || 0;
  const almuerzosPorMetodo = {};
  for (const m of Object.keys(porMetodo)) {
    almuerzosPorMetodo[m] = ajustados[m] && precioAlmuerzo
      ? { cantidad: Math.round(porMetodo[m] / precioAlmuerzo), aproximado: true }
      : { cantidad: almuerzosExactos[m] || 0, aproximado: false };
  }

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
  const ventasEfectivo = porMetodo.efectivo || 0; // el real, si el total fue corregido
  const totalGastos = gastos.reduce((s, g) => s + g.valor, 0);
  const totalNomina = nominaDia.reduce((s, n) => s + n.total, 0);
  const baseCaja = baseCajaDe(jornada);

  // Almuerzos vs extras: cada proteína vendida = un almuerzo; entradas y bebidas
  // (normalmente en $0) suman al almuerzo; lo demás cuenta como extras
  const itemsJornada = db.prepare(
    `SELECT pi.precio, pi.cantidad, pi.solo,
            (SELECT pl.tipo FROM platos pl WHERE pl.nombre = pi.plato_nombre ORDER BY pl.activo DESC, pl.id DESC LIMIT 1) AS tipo
     FROM pedido_items pi JOIN pedidos p ON p.id = pi.pedido_id
     WHERE p.jornada = ? AND p.estado != 'cancelado'`).all(jornada);
  let numAlmuerzos = 0, totalAlmuerzos = 0, totalExtras = 0;
  for (const it of itemsJornada) {
    const v = it.precio * it.cantidad;
    if (it.solo) totalExtras += v; // plato del día vendido suelto: cuenta como extra
    else if (it.tipo === 'proteina_dia' || it.tipo === 'proteina_especial') { numAlmuerzos += it.cantidad; totalAlmuerzos += v; }
    else if (it.tipo === 'entrada' || it.tipo === 'bebida') totalAlmuerzos += v;
    else totalExtras += v;
  }

  return {
    jornada,
    totalVentas: efectivos.reduce((s, p) => s + p.total, 0),
    totalCobrado: Object.values(porMetodo).reduce((s, v) => s + v, 0), // con los totales corregidos
    totalCobradoRegistrado: pagos.reduce((s, pg) => s + pg.monto, 0),
    numPedidos: efectivos.length,
    numCancelados: cancelados.length,
    totalCancelado: cancelados.reduce((s, p) => s + p.total, 0),
    totalRecargos: efectivos.reduce((s, p) => s + p.recargo, 0),
    totalRecargoTarjeta: pagos.reduce((s, pg) => s + (pg.recargo_tarjeta || 0), 0),
    porMetodo, porMetodoRegistrado, ajustados, ajustesDetalle, almuerzosPorMetodo, porVendedor,
    baseCaja, ventasEfectivo,
    porCobrar: porCobrar.map(p => ({ id: p.id, numero_comanda: p.numero_comanda, comensal: p.comensal, total: p.total, vendedor: p.vendedor })),
    gastos: gastos.map(g => ({ id: g.id, concepto: g.concepto, valor: g.valor, usuario: g.usuario })),
    totalGastos,
    nomina: nominaDia.map(n => ({ empleado: n.empleado, turno: n.valor_turno, descuento: n.descuento, bono: n.bono, concepto: n.concepto, total: n.total })),
    totalNomina,
    numAlmuerzos, totalAlmuerzos, totalExtras,
    // Detalle de qué se vendió (por plato y por tipo de proteína)
    ...(() => { const v = ventasPorPlato(jornada, jornada); return { porPlato: v.platos, porGrupo: v.grupos }; })(),
    // Efectivo que debería haber físicamente: lo que había al arrancar, más las
    // ventas en efectivo, menos lo que salió de la caja
    efectivoEsperado: baseCaja.valor + ventasEfectivo - totalGastos - totalNomina
  };
}

// ---- Resumen de un mes ('YYYY-MM'): suma de los resúmenes de cada día ----
// Se arma día por día para respetar las correcciones de totales y la base de
// caja de cada jornada, exactamente como salieron en los reportes diarios.
function resumenMes(mes) {
  const desde = mes + '-01', hasta = mes + '-31';
  const jornadas = [...new Set([
    ...db.prepare('SELECT DISTINCT jornada FROM pedidos WHERE jornada >= ? AND jornada <= ?').all(desde, hasta).map(r => r.jornada),
    ...db.prepare('SELECT DISTINCT jornada FROM gastos WHERE jornada >= ? AND jornada <= ?').all(desde, hasta).map(r => r.jornada),
    ...db.prepare("SELECT DISTINCT jornada FROM nomina WHERE estado = 'confirmado' AND jornada >= ? AND jornada <= ?").all(desde, hasta).map(r => r.jornada),
    ...db.prepare('SELECT DISTINCT jornada FROM cierres WHERE jornada >= ? AND jornada <= ?').all(desde, hasta).map(r => r.jornada)
  ])].sort();
  const cierres = new Map(db.prepare('SELECT * FROM cierres WHERE jornada >= ? AND jornada <= ?').all(desde, hasta).map(c => [c.jornada, c]));

  const acumulado = {
    mes, desde, hasta, dias: [],
    totalVentas: 0, totalCobrado: 0, numPedidos: 0, numCancelados: 0, totalCancelado: 0,
    numAlmuerzos: 0, totalAlmuerzos: 0, totalExtras: 0, totalRecargos: 0, totalRecargoTarjeta: 0,
    porMetodo: {}, porMetodoRegistrado: {}, ajustados: {}, almuerzosPorMetodo: {}, porVendedor: {},
    gastos: [], totalGastos: 0, nomina: [], totalNomina: 0, porCobrar: []
  };
  const nominaPorEmpleado = new Map();
  for (const j of jornadas) {
    const r = resumenJornada(j);
    const cierre = cierres.get(j);
    acumulado.dias.push({
      jornada: j, totalVentas: r.totalVentas, totalCobrado: r.totalCobrado, numPedidos: r.numPedidos,
      numAlmuerzos: r.numAlmuerzos, totalGastos: r.totalGastos, totalNomina: r.totalNomina,
      baseCaja: r.baseCaja.valor, efectivoEsperado: r.efectivoEsperado,
      efectivoContado: cierre ? cierre.efectivo_contado : null, descuadre: cierre ? cierre.descuadre : null,
      conCierre: !!cierre
    });
    for (const k of ['totalVentas', 'totalCobrado', 'numPedidos', 'numCancelados', 'totalCancelado', 'numAlmuerzos',
                     'totalAlmuerzos', 'totalExtras', 'totalRecargos', 'totalRecargoTarjeta', 'totalGastos', 'totalNomina']) {
      acumulado[k] += r[k];
    }
    for (const [m, v] of Object.entries(r.porMetodo)) {
      acumulado.porMetodo[m] = (acumulado.porMetodo[m] || 0) + v;
      acumulado.porMetodoRegistrado[m] = (acumulado.porMetodoRegistrado[m] || 0) + (r.porMetodoRegistrado[m] || 0);
      if (r.ajustados[m]) acumulado.ajustados[m] = true;
      const a = acumulado.almuerzosPorMetodo[m] || { cantidad: 0, aproximado: false };
      a.cantidad += (r.almuerzosPorMetodo[m] || { cantidad: 0 }).cantidad;
      a.aproximado = a.aproximado || !!(r.almuerzosPorMetodo[m] && r.almuerzosPorMetodo[m].aproximado);
      acumulado.almuerzosPorMetodo[m] = a;
    }
    for (const [v, d] of Object.entries(r.porVendedor)) {
      const acc = acumulado.porVendedor[v] || { pedidos: 0, total: 0, cancelados: 0 };
      acc.pedidos += d.pedidos; acc.total += d.total; acc.cancelados += d.cancelados;
      acumulado.porVendedor[v] = acc;
    }
    for (const g of r.gastos) acumulado.gastos.push({ ...g, jornada: j });
    for (const n of r.nomina) {
      const e = nominaPorEmpleado.get(n.empleado) || { empleado: n.empleado, turnos: 0, total: 0, descuentos: 0, bonos: 0 };
      e.turnos++; e.total += n.total; e.descuentos += n.descuento; e.bonos += n.bono;
      nominaPorEmpleado.set(n.empleado, e);
    }
    for (const p of r.porCobrar) acumulado.porCobrar.push({ ...p, jornada: j });
  }
  acumulado.nomina = [...nominaPorEmpleado.values()].sort((a, b) => b.total - a.total);
  const v = ventasPorPlato(desde, hasta);
  acumulado.porPlato = v.platos;
  acumulado.porGrupo = v.grupos;
  acumulado.diasConVentas = acumulado.dias.filter(d => d.numPedidos > 0).length;
  return acumulado;
}

// ---- Ventas una a una (formato compartido por el Excel del día, el del mes y Google Sheets) ----
const ETIQUETAS_METODO = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', nequi: 'Nequi', daviplata: 'Daviplata',
  qr_bancolombia: 'QR Bancolombia', tarjeta_debito: 'Tarjeta débito', tarjeta_credito: 'Tarjeta crédito', billetera: 'Billetera' };

const itemsConTipo = db.prepare(
  `SELECT pi.*, (SELECT pl.tipo FROM platos pl WHERE pl.nombre = pi.plato_nombre ORDER BY pl.activo DESC, pl.id DESC LIMIT 1) AS tipo
   FROM pedido_items pi WHERE pi.pedido_id = ?`);

function filaVenta(p, items, corto) {
  const porTipo = { entrada: [], proteina: [], bebida: [], extra: [] };
  for (const it of items) {
    const clave = it.tipo === 'entrada' ? 'entrada'
      : (it.tipo === 'proteina_dia' || it.tipo === 'proteina_especial') ? 'proteina'
      : it.tipo === 'bebida' ? 'bebida' : 'extra';
    // Un plato del día vendido solo (sin entrada) va con los extras, que es como se cobra
    (it.solo ? porTipo.extra : porTipo[clave]).push(`${it.cantidad > 1 ? it.cantidad + 'x ' : ''}${it.plato_nombre}${it.solo ? ' (solo)' : ''}`);
  }
  const cancelado = p.estado === 'cancelado';
  return {
    fecha: p.jornada,
    dia: Number(p.jornada.slice(8, 10)),
    hora: ((p.pagado_en || p.creado_en) || '').slice(11, 16),
    comanda: p.numero_comanda,
    vendedor: nombreReporte(p.vendedor_nombre, p.vendedor_rol, corto),
    entrega: p.tipo_entrega === 'llevar' ? 'Domicilio' : 'Local',
    entrada: porTipo.entrada.join(' | '), proteina: porTipo.proteina.join(' | '),
    bebida: porTipo.bebida.join(' | '), extras: porTipo.extra.join(' | '),
    metodo: p.metodo ? (ETIQUETAS_METODO[p.metodo] || p.metodo) : '',
    metodo_clave: p.metodo || null,
    recargo: (p.recargo || 0) + (p.recargo_tarjeta || 0),
    recargo_domicilio: p.recargo || 0, recargo_tarjeta: p.recargo_tarjeta || 0,
    estado: cancelado ? 'ANULADA' : (p.metodo ? 'PAGADA' : 'POR COBRAR'),
    total: cancelado ? 0 : (p.cobrado ?? p.total)
  };
}

const pedidosConPago = (filtro) => db.prepare(
  `SELECT p.*, u.nombre AS vendedor_nombre, u.rol AS vendedor_rol,
          pg.metodo, pg.monto AS cobrado, pg.recargo_tarjeta, pg.creado_en AS pagado_en
   FROM pedidos p JOIN usuarios u ON u.id = p.vendedor_id
   LEFT JOIN pagos pg ON pg.pedido_id = p.id
   WHERE ${filtro} ORDER BY p.jornada, p.numero_comanda`);

function filasVentas(desde, hasta) {
  return pedidosConPago('p.jornada >= ? AND p.jornada <= ?').all(desde, hasta)
    .map(p => filaVenta(p, itemsConTipo.all(p.id)));
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

// ---- Correos: reporte diario y reportes mensuales ----
// El contenido (texto, HTML y los Excel adjuntos) lo arma informes.js; aquí
// solo se encola. Los adjuntos van en base64 para que esperen sin internet.
function encolarCorreo(jornada, correo) {
  db.prepare('INSERT INTO cola_correos (jornada, asunto, cuerpo, html, adjuntos, estado, creado_en) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(jornada, correo.asunto, correo.texto, correo.html || null,
         correo.adjuntos && correo.adjuntos.length ? JSON.stringify(correo.adjuntos) : null, 'pendiente', ahora());
}

function encolarReporteDiario(jornada) {
  const informes = require('./informes');
  encolarCorreo(jornada, informes.correoDiario(jornada));
}

// El último día del mes (o el primer cierre después, si ese día no abrieron)
// salen dos correos más: la nómina del mes y el resumen del mes con todas las
// ventas. Cada mes se reporta una sola vez.
function mesesPorReportar(jornada) {
  let reportados = [];
  try { reportados = JSON.parse(getConfig('meses_reportados') || '[]'); } catch { }
  const [anio, mes, dia] = jornada.split('-').map(Number);
  const ultimoDia = new Date(anio, mes, 0).getDate();
  const candidatos = new Set();
  if (dia === ultimoDia) candidatos.add(jornada.slice(0, 7));
  // Meses anteriores con ventas que quedaron sin reportar (máximo los 2 últimos,
  // para que la primera vez no salga un correo por cada mes viejo)
  const limite = new Date(anio, mes - 3, 1).toLocaleDateString('sv-SE').slice(0, 7);
  for (const r of db.prepare('SELECT DISTINCT substr(jornada, 1, 7) AS m FROM pedidos WHERE substr(jornada, 1, 7) < ? AND substr(jornada, 1, 7) >= ?')
      .all(jornada.slice(0, 7), limite)) candidatos.add(r.m);
  return [...candidatos].filter(m => !reportados.includes(m)).sort();
}

function encolarReportesMensuales(jornada, forzarMes) {
  const informes = require('./informes');
  const meses = forzarMes ? [forzarMes] : mesesPorReportar(jornada);
  for (const mes of meses) {
    for (const correo of informes.correosMensuales(mes)) encolarCorreo(jornada, correo);
    if (!forzarMes) {
      let reportados = [];
      try { reportados = JSON.parse(getConfig('meses_reportados') || '[]'); } catch { }
      if (!reportados.includes(mes)) setConfig('meses_reportados', JSON.stringify([...reportados, mes]));
    }
    console.log(`[reportes] Reportes mensuales de ${mes} encolados`);
  }
  return meses;
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
  // Con topes de tiempo: sin ellos, un cierre de caja sin internet se queda
  // esperando el correo hasta 2 minutos con la cajera mirando la pantalla
  const transporte = nodemailer.createTransport({
    service: 'gmail', auth: { user: usuario, pass: password },
    connectionTimeout: TIMEOUT_INTERNET_MS, greetingTimeout: TIMEOUT_INTERNET_MS, socketTimeout: 30000
  });
  let enviados = 0;
  for (const correo of pendientes) {
    try {
      const retraso = correo.jornada !== jornadaHoy() ? `(Enviado con retraso; corresponde a la jornada ${correo.jornada})` : '';
      let adjuntos = [];
      try { adjuntos = JSON.parse(correo.adjuntos || '[]'); } catch { }
      await transporte.sendMail({
        from: usuario, to: destino,
        subject: correo.asunto,
        text: correo.cuerpo + (retraso ? `\n\n${retraso}` : ''),
        html: correo.html ? correo.html + (retraso ? `<p style="color:#888">${retraso}</p>` : '') : undefined,
        attachments: adjuntos.map(a => ({ filename: a.nombre, content: Buffer.from(a.base64, 'base64') }))
      });
      // Los adjuntos ya cumplieron: se sueltan para no engordar la base de datos
      db.prepare("UPDATE cola_correos SET estado = 'enviado', enviado_en = ?, adjuntos = NULL WHERE id = ?").run(ahora(), correo.id);
      enviados++;
      console.log(`[reportes] Correo enviado: ${correo.asunto}`);
    } catch (err) {
      console.error('[reportes] Fallo al enviar correo (se reintentará):', err.message);
      return { ok: false, enviados, pendientes: pendientes.length - enviados, error: errorDeRed(err) };
    }
  }
  return { ok: true, enviados, pendientes: 0 };
}

// ---- Google Sheets (webhook de Apps Script, sin OAuth para mantenerlo simple) ----
// Cada venta pagada va a la hoja de su mes ("09-2026") con el mismo formato
// del Excel: Día, Hora, Comanda, Vendedor, Entrega, Entrada, Proteína, Bebida,
// Extras, Método de pago, Recargo, Total. Privacidad: el nombre del comensal
// NUNCA se envía.
function payloadSheets(f) {
  return {
    // Campos del formato NUEVO (una hoja por mes)
    hoja: `${f.fecha.slice(5, 7)}-${f.fecha.slice(0, 4)}`,
    dia: f.dia, hora: f.hora, comanda: f.comanda, vendedor: f.vendedor, entrega: f.entrega,
    entrada: f.entrada, proteina: f.proteina, bebida: f.bebida, extras: f.extras,
    metodo: f.metodo,                 // etiqueta: "Nequi"
    recargo_total: f.recargo,         // domicilio + tarjeta, la columna "Recargo"
    total: f.total,
    // Campos del script ANTERIOR, con EXACTAMENTE el mismo significado de antes,
    // para que la hoja vieja siga bien mientras el cliente actualiza el script:
    // recargo = solo domicilio (el script viejo suma aparte recargo_tarjeta),
    // metodo_pago = clave ('nequi'), tipo_entrega = 'mesa' | 'llevar'.
    fecha: f.fecha,
    metodo_pago: f.metodo_clave || '',
    tipo_entrega: f.entrega === 'Domicilio' ? 'llevar' : 'mesa',
    recargo: f.recargo_domicilio,
    recargo_tarjeta: f.recargo_tarjeta,
    detalle: [f.entrada, f.proteina, f.bebida, f.extras].filter(Boolean).join('; ')
  };
}

function encolarVentaSheets(pedidoId) {
  const p = pedidosConPago('p.id = ?').get(pedidoId);
  if (!p || !p.metodo) return;
  const fila = filaVenta(p, itemsConTipo.all(p.id), true);
  db.prepare('INSERT INTO cola_sheets (payload, estado, creado_en) VALUES (?, ?, ?)')
    .run(JSON.stringify(payloadSheets(fila)), 'pendiente', ahora());
}

// Fila de prueba para verificar la conexión desde Admin
function encolarFilaPruebaSheets(vendedor) {
  const hoy = jornadaHoy();
  const fila = {
    fecha: hoy, dia: Number(hoy.slice(8, 10)), hora: ahora().slice(11, 16), comanda: 0, vendedor,
    entrega: 'Local', entrada: 'FILA DE PRUEBA', proteina: 'Conexión verificada desde el POS', bebida: '', extras: '',
    metodo: 'Efectivo', metodo_clave: 'efectivo', recargo: 0, recargo_domicilio: 0, recargo_tarjeta: 0, total: 0
  };
  db.prepare('INSERT INTO cola_sheets (payload, estado, creado_en) VALUES (?, ?, ?)')
    .run(JSON.stringify(payloadSheets(fila)), 'pendiente', ahora());
}

// Envía filas al webhook y devuelve lo que respondió, ya interpretado.
// Lanza error con un mensaje que dice QUÉ corregir, no solo que falló.
async function enviarASheets(url, filas) {
  const res = await fetchConTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filas })
  });
  const cuerpo = (await res.text()).trim();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Google negó el acceso (HTTP ${res.status}): la implementación del Apps Script debe tener "Quién tiene acceso: Cualquier persona".`);
    }
    throw new Error(`El webhook respondió HTTP ${res.status}. ${cuerpo.slice(0, 120)}`);
  }
  // El script de la guía NUEVA responde JSON {ok, hoja, fila}; el de la guía
  // vieja respondía el texto 'ok'. Un script mal implementado (acceso distinto
  // de "Cualquier persona") devuelve la página de login de Google CON ESTADO
  // 200: sin esta verificación las ventas se marcaban enviadas sin llegar.
  let json = null;
  try { json = JSON.parse(cuerpo); } catch { }
  const jsonOk = !!(json && (json.ok || json.result === 'ok' || json.status === 'ok'));
  if (cuerpo.toLowerCase() !== 'ok' && !jsonOk) {
    if (/<html|<!doctype/i.test(cuerpo)) {
      throw new Error('Google pidió iniciar sesión: la implementación del Apps Script debe tener acceso "Cualquier persona" (paso 5 de la guía). Vuelva a Implementar y pegue la URL nueva.');
    }
    if (json && json.error) throw new Error(`El Apps Script falló: ${String(json.error).slice(0, 160)}`);
    throw new Error(`La URL no respondió como el Apps Script de la guía (¿pegó el enlace que termina en /exec?). Respondió: "${cuerpo.slice(0, 100)}"`);
  }
  return { status: res.status, cuerpo, json: jsonOk ? json : null, versionNueva: !!(json && json.hoja) };
}

async function drenarSheets() {
  const url = String(getConfig('sheets_webhook_url') || '').trim();
  const pendientes = db.prepare("SELECT * FROM cola_sheets WHERE estado = 'pendiente' ORDER BY id LIMIT 100").all();
  if (!pendientes.length) return { ok: true, enviados: 0, pendientes: 0 };
  if (!url) return { ok: false, enviados: 0, pendientes: pendientes.length, error: 'No hay URL del webhook de Google Sheets configurada' };
  try {
    const r = await enviarASheets(url, pendientes.map(p => JSON.parse(p.payload)));
    const marcar = db.prepare("UPDATE cola_sheets SET estado = 'enviado', enviado_en = ? WHERE id = ?");
    const tx = db.transaction(() => { for (const p of pendientes) marcar.run(ahora(), p.id); });
    tx();
    setConfig('sheets_ultimo_ok', ahora() + (r.json && r.json.hoja ? ` (hoja ${r.json.hoja})` : ''));
    setConfig('sheets_ultimo_error', '');
    console.log(`[sheets] ${pendientes.length} venta(s) sincronizada(s)${r.json && r.json.hoja ? ` en la hoja ${r.json.hoja}` : ''}`);
    return { ok: true, enviados: pendientes.length, pendientes: 0, hoja: r.json && r.json.hoja };
  } catch (err) {
    const detalle = errorDeRed(err);
    setConfig('sheets_ultimo_error', ahora() + ' — ' + detalle);
    console.error('[sheets] Sin conexión o error del webhook (quedan en búfer):', detalle);
    return { ok: false, enviados: 0, pendientes: pendientes.length, error: detalle };
  }
}

// ---- Solucionador de problemas de Google Sheets ----
// Revisa paso por paso y dice exactamente qué corregir. Lo más útil: si el
// Apps Script responde el JSON de la guía nueva, informa EN QUÉ HOJA Y FILA
// escribió — así se sabe si de verdad llegó y a dónde.
async function diagnosticoSheets(vendedor) {
  const pasos = [];
  const agregar = (paso, ok, detalle, consejo) => pasos.push({ paso, ok, detalle, consejo: consejo || '' });
  const url = String(getConfig('sheets_webhook_url') || '').trim();

  if (!url) {
    agregar('Enlace configurado', false, 'No hay URL guardada',
      'Pegue en Admin la URL que da Google al Implementar el Apps Script (termina en /exec).');
    return { pasos, pendientes: db.prepare("SELECT COUNT(*) AS n FROM cola_sheets WHERE estado = 'pendiente'").get().n, resumen: 'Falta configurar el enlace de Google Sheets.' };
  }
  const formaOk = /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(url);
  agregar('Enlace configurado', formaOk, url, formaOk ? ''
    : 'No parece el enlace de una implementación de Apps Script. Debe empezar por https://script.google.com/macros/s/ y TERMINAR en /exec. Si termina en /dev o es el enlace de la hoja, está mal.');

  const net = await hayInternet();
  agregar('Internet en el PC', net, net ? 'Hay salida a internet' : 'El PC no tiene salida a internet',
    net ? '' : 'Revise que el teléfono que comparte los datos tenga señal y datos. Las ventas quedan en cola y suben solas al volver.');

  let resumen;
  if (!net) {
    resumen = 'No hay internet: no se puede probar el envío. Las ventas están guardadas y suben solas.';
  } else {
    const hoy = jornadaHoy();
    const filaPrueba = payloadSheets({
      fecha: hoy, dia: Number(hoy.slice(8, 10)), hora: ahora().slice(11, 16), comanda: 0,
      vendedor: vendedor || 'Prueba', entrega: 'Local', entrada: 'PRUEBA DEL SOLUCIONADOR',
      proteina: 'Si ve esta fila, la conexión sirve', bebida: '', extras: '',
      metodo: 'Efectivo', metodo_clave: 'efectivo', recargo: 0, recargo_domicilio: 0, recargo_tarjeta: 0, total: 0
    });
    try {
      const r = await enviarASheets(url, [filaPrueba]);
      agregar('Respuesta del Apps Script', true, `HTTP ${r.status}: ${r.cuerpo.slice(0, 120)}`);
      if (r.versionNueva) {
        agregar('Fila escrita', true, `Escribió en la hoja "${r.json.hoja}"${r.json.fila ? `, fila ${r.json.fila}` : ''}`,
          `Abra esa pestaña de su hoja de cálculo: ahí debe estar la fila de prueba. Si no la ve, es que el enlace apunta a OTRA hoja de cálculo distinta de la que está mirando.`);
        resumen = `✅ Funciona. La prueba quedó en la hoja "${r.json.hoja}"${r.json.fila ? `, fila ${r.json.fila}` : ''}.`;
      } else {
        agregar('Versión del Apps Script', false, `Respondió "${r.cuerpo.slice(0, 40)}" (versión anterior)`,
          'El script respondió bien, pero es la versión ANTERIOR: escribe en una sola hoja con el formato viejo y no puede decir en qué fila quedó. Pegue el script nuevo de la guía y luego Implementar → Administrar implementaciones → ✏️ → Versión: "Nueva versión" → Implementar. OJO: guardar el script NO basta, hay que crear una versión nueva de la implementación.');
        resumen = '⚠️ La conexión sirve, pero el Apps Script es la versión anterior: actualícelo e implemente una VERSIÓN NUEVA para tener una hoja por mes.';
      }
    } catch (e) {
      const msj = errorDeRed(e);
      agregar('Respuesta del Apps Script', false, msj,
        /Cualquier persona|acceso|login/i.test(msj)
          ? 'En el editor del Apps Script: Implementar → Administrar implementaciones → ✏️ → Quién tiene acceso: "Cualquier persona" → Implementar, y pegue en el POS la URL nueva.'
          : 'Revise que el enlace sea el de la implementación (termina en /exec) y que el script de la guía esté pegado y guardado.');
      resumen = '❌ El envío falla: ' + msj;
    }
  }
  const pend = db.prepare("SELECT COUNT(*) AS n FROM cola_sheets WHERE estado = 'pendiente'").get().n;
  if (pend) agregar('Ventas en espera', false, `${pend} venta(s) sin subir`, 'Se suben solas apenas el envío funcione: no se pierde ninguna.');
  else agregar('Ventas en espera', true, 'Ninguna: todo lo registrado ya se envió');
  return { pasos, pendientes: pend, resumen, ultimoOk: getConfig('sheets_ultimo_ok') || '', ultimoError: getConfig('sheets_ultimo_error') || '' };
}

// ¿El PC tiene salida a internet en este momento? Para el diagnóstico del
// botón 📶: separa "no hay internet" (Sheets/correo esperan, la app local
// sigue normal) de "los teléfonos no alcanzan al PC" (problema del WiFi).
async function hayInternet() {
  try {
    const res = await fetch('https://www.gstatic.com/generate_204', { signal: AbortSignal.timeout(4000) });
    return res.status === 204 || res.ok;
  } catch { return false; }
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
let drenando = false; // un ciclo a la vez: si internet está lento, no acumular intentos
function iniciarPlanificador() {
  setInterval(async () => {
    if (drenando) return;
    drenando = true;
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
    } finally {
      drenando = false;
    }
  }, 30000);
}

module.exports = {
  resumenJornada, resumenMes, ventasPorPlato, filasVentas, nombreReporte, baseCajaDe, ETIQUETAS_METODO,
  ejecutarCierre, encolarReporteDiario, encolarReportesMensuales, mesesPorReportar,
  encolarVentaSheets, encolarFilaPruebaSheets, iniciarPlanificador, drenarCorreos, drenarSheets, diagnosticoSheets, estadoSync, hayInternet
};

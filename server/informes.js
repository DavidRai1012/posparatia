// Contenido de los informes que le llegan al dueño.
//
// Una sola fuente de verdad: `seccionesResumen()` arma el reporte como una
// lista de secciones (título + filas), y de ahí salen el correo en texto, el
// correo en HTML y la hoja 1 del Excel — así los tres dicen exactamente lo
// mismo. Los Excel de ventas (día, mes y Google Sheets) comparten el formato
// de `reportes.filasVentas()`.
//
//   correoDiario(jornada)   → asunto, texto, html, adjuntos [resumen del día (+ nómina si hubo)]
//   correosMensuales(mes)   → [nómina del mes, resumen del mes] con sus Excel
//   excelResumenDia / excelResumenMes / excelNomina → Buffers .xlsx
const { db, getConfig } = require('./db');
const reportes = require('./reports');

const fmt = (n) => '$' + Number(n || 0).toLocaleString('es-CO');
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const DIAS_CORTOS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const nombreMes = (mes) => `${MESES[Number(mes.slice(5, 7)) - 1]} ${mes.slice(0, 4)}`; // '2026-09' -> 'Septiembre 2026'
const hojaMes = (mes) => `${mes.slice(5, 7)}-${mes.slice(0, 4)}`;                          // '2026-09' -> '09-2026'
const diaSemana = (fecha) => DIAS[new Date(fecha + 'T12:00:00').getDay()];
const primeraLinea = (s) => String(s || '').split('\n')[0];

function textoDescuadre(d) {
  if (d === null || d === undefined) return '';
  if (d === 0) return 'caja cuadrada';
  return (d > 0 ? 'sobran ' : 'faltan ') + fmt(Math.abs(d));
}

function etiquetaBase(b) {
  if (!b) return '';
  let t;
  if (b.origen === 'registrada') t = `registrada hoy${b.usuario ? ` por ${b.usuario}` : ''}`;
  else if (b.origen === 'contado_anterior') t = `lo contado en el cierre del ${b.jornadaOrigen}`;
  else if (b.origen === 'esperado_anterior') t = `según el sistema al cierre del ${b.jornadaOrigen} (ese día no se contó)`;
  else t = 'sin cierre anterior: se asume que se arrancó en $0';
  // Si quedaron días con ventas sin cerrar, ese efectivo también está en la
  // caja y nadie lo contó: el número es una suposición, hay que decirlo
  if (b.incierta && b.diasSinCierre && b.diasSinCierre.length) {
    t += ` — OJO: ${b.diasSinCierre.length} día(s) con ventas sin cierre (${b.diasSinCierre.join(', ')}), ese efectivo no está contado: registre la base a mano`;
  }
  return t;
}

// ---- Secciones del reporte (día o mes) ----
// Cada fila es [etiqueta, valor, nota]; una sección con `cabecera` es una tabla.
function seccionesResumen(r, esMes) {
  const S = [];
  S.push({ titulo: 'VENTAS', filas: [
    ['Ventas totales', fmt(r.totalVentas), `${r.numPedidos} pedidos${esMes ? ` en ${r.diasConVentas} día(s)` : ''}`],
    ['Almuerzos completos', r.numAlmuerzos, fmt(r.totalAlmuerzos)],
    ['Sueltos y extras', fmt(r.totalExtras)],
    ['Domicilios cobrados', fmt(r.totalRecargos)],
    ['Anulados', r.numCancelados, fmt(r.totalCancelado)],
    ['Cobrado', fmt(r.totalCobrado)]
  ] });

  // Por método: valor real (corregido si la cajera ajustó el total) y los
  // almuerzos de ese método — exactos, o APROXIMADOS si el total se corrigió
  const filasMetodo = [];
  for (const [m, v] of Object.entries(r.porMetodo)) {
    const a = r.almuerzosPorMetodo[m] || { cantidad: 0, aproximado: false };
    let nota = `${a.cantidad} almuerzo(s)${a.aproximado ? ' APROXIMADO' : ''}`;
    if (r.ajustados[m]) {
      const d = (r.ajustesDetalle || {})[m] || {};
      nota += ` · corregido a mano ${d.diferencia >= 0 ? '+' : '−'}${fmt(Math.abs(d.diferencia || 0))} sobre lo registrado (${fmt(r.porMetodoRegistrado[m] || 0)})`;
      if (d.cambiaronPagos) nota += ' · hubo pagos nuevos o anulados después de corregir: verifique contra el extracto';
    }
    filasMetodo.push([reportes.ETIQUETAS_METODO[m] || m, fmt(v), nota]);
  }
  if (r.totalRecargoTarjeta) filasMetodo.push(['(incluye recargos por tarjeta)', fmt(r.totalRecargoTarjeta)]);
  if (Object.values(r.ajustados).some(Boolean)) {
    filasMetodo.push(['Nota', '', 'APROXIMADO = el total de ese método se corrigió a mano, así que los almuerzos se estiman dividiendo por el precio del almuerzo completo']);
  }
  S.push({ titulo: 'POR MÉTODO DE PAGO', filas: filasMetodo.length ? filasMetodo : [['Sin pagos', '']] });

  S.push({ titulo: 'POR VENDEDOR', filas: Object.entries(r.porVendedor).map(([v, d]) =>
    [v, fmt(d.total), `${d.pedidos} pedidos${d.cancelados ? `, ${d.cancelados} anulado(s)` : ''}`]) });

  if (r.porGrupo && r.porGrupo.length) {
    S.push({ titulo: 'ALMUERZOS POR TIPO (para las compras)', filas: r.porGrupo.map(g =>
      [g.grupo, g.cantidad, `${g.solos ? `${g.solos} sin entrada · ` : ''}${fmt(g.total)}`]) });
  }
  const proteinas = (r.porPlato || []).filter(p => p.tipo === 'proteina_dia' || p.tipo === 'proteina_especial');
  if (proteinas.length) {
    S.push({ titulo: 'PROTEÍNAS VENDIDAS (de la más vendida a la menos)', filas: proteinas.map(p =>
      [p.nombre + (p.grupo ? ` [${p.grupo}]` : ''), p.cantidad, fmt(p.total)]) });
  }
  if (r.gastos.length) {
    S.push({ titulo: `GASTOS DEL LOCAL (${fmt(r.totalGastos)})`, filas: r.gastos.map(g =>
      [(esMes ? g.jornada + ' · ' : '') + primeraLinea(g.concepto), fmt(g.valor), `registró ${g.usuario}`]) });
  }
  if (r.nomina.length) {
    const detalleTurnos = (n) => n.turnos && n.turnos.length
      ? `${n.turnos.length} turno(s): ${n.turnos.map(t => `${DIAS_CORTOS[new Date(t.jornada + 'T12:00:00').getDay()]} ${Number(t.jornada.slice(8, 10))} ${t.cargo}`).join(', ')}`
      : `turno ${fmt(n.turno)}`;
    S.push({ titulo: `NÓMINA PAGADA (${fmt(r.totalNomina)})`, filas: esMes
      ? r.nomina.map(n => [n.empleado, fmt(n.total),
          `${n.pagos || 1} pago(s) por ${n.turnos} turno(s)${n.bonos ? `, bonos +${fmt(n.bonos)}` : ''}${n.descuentos ? `, descuentos -${fmt(n.descuentos)}` : ''}`])
      : r.nomina.map(n => [n.empleado, fmt(n.total),
          `${detalleTurnos(n)}${n.descuento ? `, descuento -${fmt(n.descuento)}` : ''}${n.bono ? `, bono +${fmt(n.bono)}` : ''}${n.concepto ? ` (${n.concepto})` : ''}`]) });
  }
  // Quién vino y qué hizo en el mes, se haya pagado o no
  if (esMes && r.turnosMes && r.turnosMes.length) {
    S.push({ titulo: 'DÍAS TRABAJADOS EN EL MES (por rol)', filas: r.turnosMes.map(t =>
      [`${t.empleado} · ${t.cargo}`, t.cantidad, `${fmt(t.total)}${t.sinPagar ? ` · sin pagar ${fmt(t.sinPagar)}` : ''}`]) });
  }

  if (!esMes) {
    const filasCaja = [
      ['Base de caja (inicio del día)', fmt(r.baseCaja.valor), etiquetaBase(r.baseCaja)],
      ['+ Ventas en efectivo', fmt(r.ventasEfectivo), r.ajustados.efectivo ? 'total corregido a mano' : ''],
      ['− Gastos del local', fmt(r.totalGastos)],
      ['− Nómina pagada', fmt(r.totalNomina)],
      ['= EFECTIVO ESPERADO EN CAJA', fmt(r.efectivoEsperado)]
    ];
    if (r.cierre) {
      filasCaja.push(['Efectivo contado en el cierre', r.cierre.efectivo_contado === null ? 'no se contó' : fmt(r.cierre.efectivo_contado)]);
      if (r.cierre.efectivo_contado !== null) filasCaja.push(['Descuadre', textoDescuadre(r.cierre.descuadre)]);
    } else {
      filasCaja.push(['Cierre de caja', 'todavía no se ha hecho']);
    }
    S.push({ titulo: 'CAJA', filas: filasCaja });
  } else {
    S.push({
      titulo: 'DÍA POR DÍA',
      cabecera: ['Día', 'Ventas', 'Cobrado', 'Pedidos', 'Almuerzos', 'Gastos', 'Nómina', 'Efectivo esperado', 'Contado', 'Descuadre'],
      filas: r.dias.map(d => [d.jornada, fmt(d.totalVentas), fmt(d.totalCobrado), d.numPedidos, d.numAlmuerzos,
        fmt(d.totalGastos), fmt(d.totalNomina), fmt(d.efectivoEsperado),
        d.efectivoContado === null ? (d.conCierre ? 'no se contó' : 'sin cierre') : fmt(d.efectivoContado),
        textoDescuadre(d.descuadre)])
    });
  }
  if (r.porCobrar.length) {
    S.push({ titulo: 'PENDIENTES DE COBRO', filas: r.porCobrar.map(p =>
      [`Comanda ${p.numero_comanda}${p.jornada ? ' · ' + p.jornada : ''}`, fmt(p.total), p.vendedor || '']) });
  }
  return S;
}

// ---- Texto plano ----
function textoDeSecciones(titulo, secciones, intro) {
  const lineas = [titulo, ''];
  if (intro) lineas.push(intro, '');
  for (const s of secciones) {
    lineas.push(s.titulo);
    if (s.cabecera) {
      lineas.push('  ' + s.cabecera.join(' | '));
      for (const f of s.filas) lineas.push('  ' + f.join(' | '));
    } else {
      for (const [etq, valor, nota] of s.filas) {
        lineas.push(`  - ${etq}${valor !== '' && valor !== undefined ? `: ${valor}` : ''}${nota ? ` (${nota})` : ''}`);
      }
    }
    lineas.push('');
  }
  return lineas.join('\n').trim();
}

// ---- HTML (se ve bien en Gmail del celular) ----
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function htmlDeSecciones(titulo, secciones, intro) {
  const partes = [`<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222;max-width:680px">`,
    `<h2 style="margin:0 0 4px;color:#1a4d8f">${escHtml(titulo)}</h2>`];
  if (intro) partes.push(`<p style="margin:0 0 14px;color:#555">${escHtml(intro)}</p>`);
  for (const s of secciones) {
    partes.push(`<h3 style="margin:18px 0 6px;font-size:14px;letter-spacing:.04em;color:#444;border-bottom:2px solid #dde">${escHtml(s.titulo)}</h3>`);
    partes.push('<table cellpadding="4" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px">');
    if (s.cabecera) {
      partes.push('<tr>' + s.cabecera.map(c => `<th align="left" style="background:#eef2f8;border-bottom:1px solid #ccd">${escHtml(c)}</th>`).join('') + '</tr>');
      for (const f of s.filas) partes.push('<tr>' + f.map(c => `<td style="border-bottom:1px solid #eee">${escHtml(c)}</td>`).join('') + '</tr>');
    } else {
      for (const [etq, valor, nota] of s.filas) {
        const fuerte = /^=|ESPERADO|Descuadre|Ventas totales|Cobrado$/.test(String(etq));
        partes.push(`<tr><td style="border-bottom:1px solid #eee;${fuerte ? 'font-weight:700' : ''}">${escHtml(etq)}</td>` +
          `<td align="right" style="border-bottom:1px solid #eee;white-space:nowrap;font-weight:${fuerte ? 800 : 600}">${escHtml(valor)}</td>` +
          `<td style="border-bottom:1px solid #eee;color:#666;font-size:12px">${escHtml(nota || '')}</td></tr>`);
      }
    }
    partes.push('</table>');
  }
  partes.push(`<p style="margin-top:18px;color:#888;font-size:12px">Enviado automáticamente por el POS de ${escHtml(getConfig('nombre_restaurante'))}.</p></div>`);
  return partes.join('\n');
}

// ---- Excel ----
function hojaConFiltro(XLSX, filas, anchos) {
  const ws = XLSX.utils.aoa_to_sheet(filas);
  if (filas.length > 1) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: filas.length - 1, c: Math.max(0, filas[0].length - 1) } }) };
  if (anchos) ws['!cols'] = anchos.map(w => ({ wch: w }));
  return ws;
}

// Hoja 1: "lo que viene escrito en el correo", en filas
function hojaDeSecciones(XLSX, titulo, secciones) {
  const filas = [[titulo], []];
  for (const s of secciones) {
    filas.push([s.titulo]);
    if (s.cabecera) { filas.push(s.cabecera); for (const f of s.filas) filas.push(f); }
    else for (const f of s.filas) filas.push([f[0], f[1] ?? '', f[2] ?? '']);
    filas.push([]);
  }
  const ws = XLSX.utils.aoa_to_sheet(filas);
  ws['!cols'] = [{ wch: 36 }, { wch: 16 }, { wch: 14 }, { wch: 10 }, { wch: 11 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 13 }, { wch: 18 }];
  return ws;
}

const CABECERA_VENTAS = ['Día', 'Hora', 'Comanda', 'Vendedor', 'Entrega', 'Entrada', 'Proteína', 'Bebida', 'Extras',
  'Método de pago', 'Recargo', 'Total', 'Estado'];
const ANCHOS_VENTAS = [5, 6, 9, 22, 10, 18, 22, 14, 18, 14, 9, 10, 11];

function hojaVentas(XLSX, filasVenta, conFecha) {
  const filas = [conFecha ? ['Fecha', ...CABECERA_VENTAS] : CABECERA_VENTAS];
  for (const f of filasVenta) {
    const fila = [f.dia, f.hora, f.comanda, f.vendedor, f.entrega, f.entrada, f.proteina, f.bebida, f.extras,
      f.metodo, f.recargo, f.total, f.estado];
    filas.push(conFecha ? [f.fecha, ...fila] : fila);
  }
  return hojaConFiltro(XLSX, filas, conFecha ? [11, ...ANCHOS_VENTAS] : ANCHOS_VENTAS);
}

const ETIQUETAS_CLASE = { entrada: 'Entrada', proteina_dia: 'Del día', proteina_especial: 'Especial', bebida: 'Bebida', extra: 'Extra' };

// Hojas "qué se vendió": plato por plato y por tipo (pollo, carne, cerdo...)
function hojasDePlatos(XLSX, libro, ventas) {
  const filasPlatos = [['Plato', 'Tipo (compras)', 'Clase', 'Cantidad', 'De esos, sin entrada', 'Total $']];
  for (const p of ventas.platos) {
    filasPlatos.push([p.nombre, p.grupo || '', ETIQUETAS_CLASE[p.tipo] || p.tipo || '', p.cantidad, p.solos, p.total]);
  }
  const filasGrupos = [['Tipo', 'Almuerzos vendidos', 'De esos, sin entrada', 'Total $']];
  for (const g of ventas.grupos) filasGrupos.push([g.grupo, g.cantidad, g.solos, g.total]);
  filasGrupos.push([]);
  filasGrupos.push(['TOTAL', ventas.grupos.reduce((s, g) => s + g.cantidad, 0), '', ventas.grupos.reduce((s, g) => s + g.total, 0)]);
  XLSX.utils.book_append_sheet(libro, hojaConFiltro(XLSX, filasPlatos, [30, 16, 12, 10, 20, 12]), 'Platos vendidos');
  XLSX.utils.book_append_sheet(libro, hojaConFiltro(XLSX, filasGrupos, [18, 20, 20, 12]), 'Por tipo');
}

function hojaGastos(XLSX, gastos, total, conFecha) {
  const filas = [conFecha ? ['Fecha', 'Concepto', 'Valor', 'Registró'] : ['Concepto', 'Valor', 'Registró']];
  for (const g of gastos) filas.push(conFecha ? [g.jornada, g.concepto, g.valor, g.usuario] : [g.concepto, g.valor, g.usuario]);
  filas.push([]);
  filas.push(conFecha ? ['', 'TOTAL GASTOS', total, ''] : ['TOTAL GASTOS', total, '']);
  return hojaConFiltro(XLSX, filas, conFecha ? [11, 46, 12, 14] : [46, 12, 14]);
}

function resumenConCierre(jornada) {
  const r = reportes.resumenJornada(jornada);
  const cierre = db.prepare('SELECT efectivo_contado, descuadre FROM cierres WHERE jornada = ?').get(jornada);
  if (cierre) r.cierre = cierre;
  return r;
}

// Excel del día. `completo` agrega las hojas de platos, tipos y gastos (para
// la descarga desde la app); el adjunto del correo lleva las 2 hojas pedidas.
function excelResumenDia(jornada, completo) {
  const XLSX = require('xlsx');
  const r = resumenConCierre(jornada);
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hojaDeSecciones(XLSX, `RESUMEN DEL DÍA ${jornada} (${diaSemana(jornada)})`, seccionesResumen(r, false)), 'Resumen del día');
  XLSX.utils.book_append_sheet(libro, hojaVentas(XLSX, reportes.filasVentas(jornada, jornada), false), 'Ventas');
  if (completo) {
    hojasDePlatos(XLSX, libro, { platos: r.porPlato, grupos: r.porGrupo });
    XLSX.utils.book_append_sheet(libro, hojaGastos(XLSX, r.gastos, r.totalGastos, false), 'Gastos del día');
  }
  return XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' });
}

// Excel del mes: resumen (con la tabla día por día) + todas las ventas del mes
function excelResumenMes(mes) {
  const XLSX = require('xlsx');
  const r = reportes.resumenMes(mes);
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hojaDeSecciones(XLSX, `RESUMEN DE ${nombreMes(mes).toUpperCase()}`, seccionesResumen(r, true)), 'Resumen del mes');
  XLSX.utils.book_append_sheet(libro, hojaVentas(XLSX, reportes.filasVentas(r.desde, r.hasta), true), `Ventas ${hojaMes(mes)}`);
  hojasDePlatos(XLSX, libro, { platos: r.porPlato, grupos: r.porGrupo });
  XLSX.utils.book_append_sheet(libro, hojaGastos(XLSX, r.gastos, r.totalGastos, true), 'Gastos del mes');
  return XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' });
}

// Excel de nómina, estilo Kardex: hoja RESUMEN (empleado × mes, lo pagado) +
// UNA HOJA POR MES con, por empleado, los DÍAS TRABAJADOS (fecha, día, rol,
// valor, si ya se pagó) y luego sus PAGOS (fecha, turnos incluidos, descuento,
// bono, total, confirmación). A cada empleado se le paga distinto (días sin
// pago, pagos por acumulado), así que se lista lo que realmente pasó.
// `soloMes` ('YYYY-MM') deja solo la hoja de ese mes (más el RESUMEN).
function excelNomina(anio, soloMes) {
  const XLSX = require('xlsx');
  const pagos = db.prepare(
    `SELECT n.*, u.nombre AS empleado FROM nomina n JOIN usuarios u ON u.id = n.empleado_id
     WHERE n.estado != 'anulado' AND n.jornada LIKE ? ORDER BY n.jornada, u.nombre, n.id`).all(anio + '-%');
  const turnos = db.prepare(
    `SELECT t.*, u.nombre AS empleado, n.jornada AS pagado_en, n.estado AS pago_estado
     FROM turnos t JOIN usuarios u ON u.id = t.empleado_id LEFT JOIN nomina n ON n.id = t.pago_id
     WHERE t.jornada LIKE ? ORDER BY t.jornada, u.nombre, t.id`).all(anio + '-%');
  if (!pagos.length && !turnos.length) return null;
  const libro = XLSX.utils.book_new();
  const confirmados = pagos.filter(p => p.estado === 'confirmado');

  const empleados = [...new Set([...pagos.map(p => p.empleado), ...turnos.map(t => t.empleado)])].sort();
  const filasResumen = [['Empleado', ...MESES, 'TOTAL ' + anio]];
  for (const emp of empleados) {
    const fila = [emp];
    let totalAnio = 0;
    for (let m = 1; m <= 12; m++) {
      const suma = confirmados.filter(p => p.empleado === emp && Number(p.jornada.slice(5, 7)) === m).reduce((s, p) => s + p.total, 0);
      fila.push(suma || 0);
      totalAnio += suma;
    }
    fila.push(totalAnio);
    filasResumen.push(fila);
  }
  filasResumen.push([]);
  const totalMes = (m) => confirmados.filter(p => Number(p.jornada.slice(5, 7)) === m).reduce((s, p) => s + p.total, 0);
  filasResumen.push(['TOTAL PAGADO', ...MESES.map((_, i) => totalMes(i + 1)), confirmados.reduce((s, p) => s + p.total, 0)]);
  filasResumen.push([]);
  filasResumen.push(['(pagos confirmados por el empleado; los días trabajados están en la hoja de cada mes)']);
  XLSX.utils.book_append_sheet(libro, hojaConFiltro(XLSX, filasResumen, [18, ...MESES.map(() => 11), 13]), 'RESUMEN');

  const meses = [...new Set([...pagos.map(p => p.jornada.slice(0, 7)), ...turnos.map(t => t.jornada.slice(0, 7))])].sort()
    .filter(m => !soloMes || m === soloMes);
  for (const mes of meses) {
    const filas = [[`NÓMINA DE ${nombreMes(mes).toUpperCase()}`], []];
    let totalPagadoMes = 0;
    for (const emp of empleados) {
      const suyos = turnos.filter(t => t.empleado === emp && t.jornada.slice(0, 7) === mes);
      const susPagos = pagos.filter(p => p.empleado === emp && p.jornada.slice(0, 7) === mes);
      if (!suyos.length && !susPagos.length) continue;
      filas.push([emp.toUpperCase()]);
      filas.push(['Días trabajados', 'Día', 'Rol', 'Valor', 'Nota', 'Pago']);
      let subtotalTurnos = 0, sinPagar = 0;
      for (const t of suyos) {
        filas.push([t.jornada, diaSemana(t.jornada), t.cargo, t.valor, t.nota || '',
          t.pago_id ? `pagado el ${t.pagado_en}${t.pago_estado === 'pendiente' ? ' (sin confirmar)' : ''}` : 'SIN PAGAR']);
        subtotalTurnos += t.valor;
        if (!t.pago_id) sinPagar += t.valor;
      }
      if (suyos.length) filas.push(['', '', `${suyos.length} turno(s)`, subtotalTurnos, sinPagar ? `sin pagar: ${sinPagar}` : '', '']);
      if (susPagos.length) {
        filas.push(['Pagos', 'Turnos incluidos', 'Suma turnos', 'Descuento', 'Bono', 'Total', 'Concepto', 'Confirmado']);
        let subtotalPagos = 0;
        for (const p of susPagos) {
          const incluidos = turnos.filter(t => t.pago_id === p.id).map(t => `${DIAS_CORTOS[new Date(t.jornada + 'T12:00:00').getDay()]} ${Number(t.jornada.slice(8, 10))}`).join(', ');
          filas.push([p.jornada, incluidos, p.valor_turno, p.descuento, p.bono, p.total, p.concepto || '',
            p.estado === 'confirmado' ? (p.confirmado_en || '').slice(0, 16) : p.estado]);
          if (p.estado === 'confirmado') subtotalPagos += p.total;
        }
        filas.push(['', '', '', '', `Pagado a ${emp}`, subtotalPagos, '', '']);
        totalPagadoMes += subtotalPagos;
      }
      filas.push([]);
    }
    filas.push(['', '', '', '', `TOTAL PAGADO ${nombreMes(mes).toUpperCase()}`, totalPagadoMes]);
    const ws = XLSX.utils.aoa_to_sheet(filas);
    ws['!cols'] = [{ wch: 14 }, { wch: 22 }, { wch: 20 }, { wch: 11 }, { wch: 22 }, { wch: 24 }, { wch: 22 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(libro, ws, hojaMes(mes));
  }
  return XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' });
}

// ---- Correos ----
function correoDiario(jornada) {
  const r = resumenConCierre(jornada);
  const nombre = getConfig('nombre_restaurante');
  const titulo = `Reporte del ${diaSemana(jornada)} ${jornada} · ${nombre}`;
  const secciones = seccionesResumen(r, false);
  const adjuntos = [{ nombre: `resumen-${jornada}.xlsx`, base64: excelResumenDia(jornada, false).toString('base64') }];
  let intro = 'Adjunto va el Excel del día: hoja 1 con este mismo resumen y hoja 2 con las ventas una a una.';
  if (r.nomina.length) {
    const xn = excelNomina(jornada.slice(0, 4));
    if (xn) {
      adjuntos.push({ nombre: `nomina-${jornada.slice(0, 4)}.xlsx`, base64: xn.toString('base64') });
      intro += ' Hoy se pagó nómina: también va el Excel de nómina, con una hoja por mes.';
    }
  }
  return {
    asunto: `Reporte diario ${jornada} - ${nombre}`,
    texto: textoDeSecciones(titulo, secciones, intro),
    html: htmlDeSecciones(titulo, secciones, intro),
    adjuntos
  };
}

function correosMensuales(mes) {
  const r = reportes.resumenMes(mes);
  const nombre = getConfig('nombre_restaurante');
  const nm = nombreMes(mes);

  // 1. Nómina del mes
  const filasNomina = r.nomina.length
    ? r.nomina.map(n => [n.empleado, fmt(n.total), `${n.pagos || 1} pago(s) por ${n.turnos} turno(s)${n.bonos ? `, bonos +${fmt(n.bonos)}` : ''}${n.descuentos ? `, descuentos -${fmt(n.descuentos)}` : ''}`])
    : [['Sin pagos de nómina confirmados este mes', '']];
  filasNomina.push(['TOTAL NÓMINA DEL MES', fmt(r.totalNomina)]);
  const secN = [{ titulo: `NÓMINA PAGADA EN ${nm.toUpperCase()}`, filas: filasNomina }];
  if (r.turnosMes && r.turnosMes.length) {
    secN.push({ titulo: 'DÍAS TRABAJADOS EN EL MES (por rol)', filas: r.turnosMes.map(t =>
      [`${t.empleado} · ${t.cargo}`, t.cantidad, `${fmt(t.total)}${t.sinPagar ? ` · sin pagar ${fmt(t.sinPagar)}` : ''}`]) });
  }
  const xn = excelNomina(mes.slice(0, 4), mes);
  const introN = xn
    ? `Adjunto va el Excel de nómina de ${nm} (hoja RESUMEN del año y la hoja del mes con cada pago por empleado).`
    : `No hubo pagos de nómina confirmados en ${nm}.`;
  const correoNomina = {
    asunto: `Nómina de ${nm} - ${nombre}`,
    texto: textoDeSecciones(`Nómina de ${nm} · ${nombre}`, secN, introN),
    html: htmlDeSecciones(`Nómina de ${nm} · ${nombre}`, secN, introN),
    adjuntos: xn ? [{ nombre: `nomina-${mes}.xlsx`, base64: xn.toString('base64') }] : []
  };

  // 2. Resumen del mes con todas las ventas
  const secR = seccionesResumen(r, true);
  // Si el mes todavía no ha terminado, el reporte es parcial y hay que decirlo
  const hoy = new Date().toLocaleDateString('sv-SE');
  const parcial = mes >= hoy.slice(0, 7) ? ` ATENCIÓN: ${nm} todavía no ha terminado, así que este reporte va hasta el ${hoy}.` : '';
  const introR = `Adjunto va el Excel del mes: hoja 1 con este resumen (incluida la tabla día por día) y hoja 2 con todas las ventas de ${nm} una a una.${parcial}`;
  const correoResumen = {
    asunto: `Resumen mensual ${nm} - ${nombre}`,
    texto: textoDeSecciones(`Resumen de ${nm} · ${nombre}`, secR, introR),
    html: htmlDeSecciones(`Resumen de ${nm} · ${nombre}`, secR, introR),
    adjuntos: [{ nombre: `resumen-${mes}.xlsx`, base64: excelResumenMes(mes).toString('base64') }]
  };
  return [correoNomina, correoResumen];
}

module.exports = { seccionesResumen, textoDeSecciones, htmlDeSecciones, excelResumenDia, excelResumenMes, excelNomina,
  correoDiario, correosMensuales, nombreMes, hojaMes, MESES };

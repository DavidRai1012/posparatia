// Generador de tickets ESC/POS para la comanda de cocina.
// Produce dos representaciones del mismo ticket:
//   - raw:   bytes ESC/POS (Buffer) para enviar a la impresora térmica
//   - texto: versión en texto plano para la vista previa en pantalla y el log
//
// Formato según especificaciones:
//   - "LLAMAR: <COMENSAL>" en doble alto y doble ancho
//   - Platos en doble alto
//   - Notas ">> NOTA: ..." en negrita y doble alto, debajo del plato
//   - Hora en tamaño estándar
//   - Nunca imprime vendedor ni datos de pago
//   - "PARA LLEVAR / EMPACAR" destacado cuando aplica

const ESC = 0x1b, GS = 0x1d;

// Las impresoras térmicas económicas suelen usar CP437 sin acentos:
// transliteramos para que el ticket nunca salga con caracteres basura.
function transliterar(s) {
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ñ/g, 'n').replace(/Ñ/g, 'N')
    .replace(/[^\x20-\x7E\n]/g, '?');
}

class TicketBuilder {
  constructor(ancho) {
    this.ancho = ancho || 32; // caracteres por línea en tamaño estándar
    this.partes = [];
    this.lineas = [];
    this.init();
  }
  bytes(...b) { this.partes.push(Buffer.from(b)); }
  init() { this.bytes(ESC, 0x40); } // reset
  alinear(n) { this.bytes(ESC, 0x61, n); } // 0 izq, 1 centro, 2 der
  // GS ! n -> tamaño: bit alto = ancho x2, bit bajo = alto x2
  tam(anchoX2, altoX2) { this.bytes(GS, 0x21, (anchoX2 ? 0x10 : 0) | (altoX2 ? 0x01 : 0)); }
  negrita(on) { this.bytes(ESC, 0x45, on ? 1 : 0); }

  linea(texto, { anchoX2 = false, altoX2 = false, bold = false, centrar = false } = {}) {
    const t = transliterar(texto);
    this.alinear(centrar ? 1 : 0);
    this.tam(anchoX2, altoX2);
    this.negrita(bold);
    this.partes.push(Buffer.from(t + '\n', 'ascii'));
    this.tam(false, false);
    this.negrita(false);
    this.alinear(0);
    // Representación en texto plano para pantalla
    const marca = (anchoX2 || altoX2) ? (bold ? '**' : '*') : (bold ? '**' : '');
    let plano = marca ? `${marca}${t}${marca}` : t;
    if (centrar) {
      const pad = Math.max(0, Math.floor((this.ancho - t.length) / 2));
      plano = ' '.repeat(pad) + plano;
    }
    this.lineas.push(plano);
  }
  separador() { this.linea('-'.repeat(this.ancho)); }
  saltos(n = 1) {
    this.partes.push(Buffer.from('\n'.repeat(n)));
    for (let i = 0; i < n; i++) this.lineas.push('');
  }
  cortar() {
    this.saltos(3);
    this.bytes(GS, 0x56, 0x42, 0x00); // corte parcial; inofensivo si la impresora no tiene cutter
  }
  resultado() {
    return { raw: Buffer.concat(this.partes), texto: this.lineas.join('\n') };
  }
}

// tipo: 'comanda' | 'actualizacion' | 'anulacion' | 'reimpresion'
//
// Formato de comanda (definido con el usuario el 2026-08-18):
//   #-051 (grande) + hora
//   un bloque por almuerzo separado por rayas; cada plato como IMAGEN x3
//   (72 puntos de alto: la fuente nativa de la SAT 15T US topa en 2x),
//   las notas del almuerzo con ">>" debajo, y el nombre del comensal al final.
const { rasterizarAlturaObjetivo } = require('./texto-bitmap');
const ALTO_BASE = 24; // alto en puntos de la fuente nativa 1x

// Escribe una línea al multiplicador pedido: 1x usa la fuente nativa (rápida);
// mayores se renderizan como imagen (la fuente nativa de la SAT topa en 2x).
function lineaEscalada(t, texto, mult, negrita) {
  const m = Number(mult) || 1;
  if (m <= 1) { t.linea(texto, { bold: !!negrita }); return; }
  if (m === 2) { t.linea(texto, { anchoX2: true, altoX2: true, bold: !!negrita }); return; } // 2x nativo: sin renderizar
  try {
    const r = rasterizarAlturaObjetivo(texto, Math.round(ALTO_BASE * m), { centrar: false });
    t.partes.push(r.buffer);
    t.lineas.push(`${negrita ? '**' : '###'} ${transliterar(texto)}`);
  } catch {
    t.linea(texto, { anchoX2: true, altoX2: true, bold: !!negrita }); // respaldo nativo 2x
  }
}

// Parte un texto largo en líneas que quepan en el papel al multiplicador dado
function partirParaAncho(texto, mult) {
  // ~0.5 del alto por carácter en Arial Bold; si algo queda largo, el raster se encoge solo
  const porLinea = Math.max(8, Math.floor(384 / (ALTO_BASE * mult * 0.5)));
  const palabras = String(texto).split(/\s+/).filter(Boolean);
  const lineas = [];
  let actual = '';
  for (const p of palabras) {
    if (actual && (actual + ' ' + p).length > porLinea) { lineas.push(actual); actual = p; }
    else actual = actual ? actual + ' ' + p : p;
  }
  if (actual) lineas.push(actual);
  return lineas.length ? lineas : [String(texto)];
}

// La nota viaja como "chips\ntexto libre": la primera línea son los cambios
// rápidos y lo que sigue al salto de línea son observaciones del mesero.
function partesDeNota(nota) {
  if (!nota) return { chips: '', obs: '' };
  const i = nota.indexOf('\n');
  if (i < 0) return { chips: nota.trim(), obs: '' };
  return { chips: nota.slice(0, i).trim(), obs: nota.slice(i + 1).trim() };
}

// Agrupa items IGUALES (mismo plato y misma nota) y los ordena por tipo:
// entradas, proteínas, bebidas, extras — formato pedido por cocina el 2026-08-19.
const ORDEN_TIPO = { entrada: 0, proteina_dia: 1, proteina_especial: 1, bebida: 2, extra: 3 };
function agruparIguales(items) {
  const grupos = new Map();
  for (const it of items) {
    const clave = `${it.plato_nombre}|${it.nota || ''}`;
    if (!grupos.has(clave)) {
      // En la comanda se usa el acrónimo si el plato lo tiene ("CREMA" en vez
      // de "Crema de champiñones con pollo"); los reportes usan el nombre completo
      grupos.set(clave, { nombre: it.acronimo || it.plato_nombre, nota: it.nota, tipo: it.tipo, n: 0 });
    }
    grupos.get(clave).n += it.cantidad || 1;
  }
  return [...grupos.values()].sort((a, b) => (ORDEN_TIPO[a.tipo] ?? 1.5) - (ORDEN_TIPO[b.tipo] ?? 1.5));
}

function ticketCocina(pedido, items, tipo, opciones = {}) {
  const ancho = Number(opciones.ancho || 32);
  const hora = opciones.hora; // "HH:MM"
  const t = new TicketBuilder(ancho);

  if (tipo === 'anulacion') {
    t.linea(`ANULADO`, { anchoX2: true, altoX2: true, bold: true, centrar: true });
    t.linea(`#-${String(pedido.numero_comanda).padStart(3, '0')}`, { anchoX2: true, altoX2: true, centrar: true });
    t.separador();
    t.linea(`Comensal: ${pedido.comensal}`);
    for (const it of items) t.linea(`${it.cantidad > 1 ? it.cantidad + 'x ' : ''}${it.plato_nombre}`);
    t.linea(`Hora: ${hora}`);
    t.cortar();
    return t.resultado();
  }

  if (tipo === 'actualizacion') t.linea('** ACTUALIZACION **', { altoX2: true, bold: true, centrar: true });
  if (tipo === 'reimpresion') t.linea('** REIMPRESION **', { altoX2: true, bold: true, centrar: true });

  t.linea(`#-${String(pedido.numero_comanda).padStart(3, '0')}`, { anchoX2: true, altoX2: true, centrar: true });
  t.linea(hora, { centrar: true });
  if (pedido.tipo_entrega === 'llevar') {
    t.linea('DOMICILIO / EMPACAR', { anchoX2: true, altoX2: true, bold: true, centrar: true });
  }

  const tamPlatos = Number(opciones.tamPlatos || 3);
  const tamObs = Number(opciones.tamObs || 2);

  t.separador();
  for (const g of agruparIguales(items)) {
    // "4 CREMA DE ESPINACA" — cantidad + plato al tamaño configurado
    lineaEscalada(t, `${g.n} ${g.nombre}`.toUpperCase(), tamPlatos, false);
    // Su nota justo debajo, entre >> <<  (los iguales CON nota distinta van por aparte)
    const { chips, obs } = partesDeNota(g.nota);
    const notaTexto = [chips, obs].filter(Boolean).join(', ');
    if (notaTexto) {
      const lineasNota = partirParaAncho(notaTexto, tamObs);
      lineasNota[0] = '>>' + lineasNota[0];
      lineasNota[lineasNota.length - 1] += '<<';
      for (const lin of lineasNota) lineaEscalada(t, lin, tamObs, true);
    }
  }
  t.separador();

  t.saltos(1);
  t.linea(`Nombre: ${pedido.comensal}`, { altoX2: true });
  t.cortar();
  return t.resultado();
}

// Cuenta de venta para el cliente: datos del negocio configurables (NIT, etc.),
// detalle con precios, total y método de pago. Documento informativo — la
// factura electrónica DIAN requiere un proveedor autorizado.
function ticketFactura(datos, opciones = {}) {
  const ancho = Number(opciones.ancho || 32);
  const t = new TicketBuilder(ancho);
  const fmt = (n) => '$' + Number(n || 0).toLocaleString('es-CO');
  const filaValor = (izq, der) => {
    const d = String(der);
    const espacio = Math.max(1, ancho - d.length);
    t.linea(transliterar(izq).slice(0, espacio - 1).padEnd(espacio) + d);
  };
  const parrafo = (texto) => {
    const palabras = transliterar(texto).split(/\s+/).filter(Boolean);
    let linea = '';
    for (const p of palabras) {
      if (linea && (linea + ' ' + p).length > ancho) { t.linea(linea); linea = p; }
      else linea = linea ? linea + ' ' + p : p;
    }
    if (linea) t.linea(linea);
  };

  t.linea(datos.titulo || 'FACTURA DE VENTA', { altoX2: true, bold: true, centrar: true });
  if (datos.razon) t.linea(datos.razon, { centrar: true, bold: true });
  if (datos.nit) t.linea(`NIT/CC: ${datos.nit}`, { centrar: true });
  if (datos.direccion) t.linea(datos.direccion, { centrar: true });
  if (datos.telefono) t.linea(`Tel: ${datos.telefono}`, { centrar: true });
  t.separador();
  t.linea(`No. ${String(datos.consecutivo).padStart(6, '0')}  Comanda #-${String(datos.numero_comanda).padStart(3, '0')}`);
  t.linea(`Fecha: ${datos.fecha}  ${datos.hora}`);
  t.separador();
  for (const it of datos.items) {
    const nombre = `${it.cantidad} ${it.nombre}${it.solo ? ' (solo)' : ''}`;
    filaValor(nombre, it.subtotal > 0 ? fmt(it.subtotal) : 'Incl.');
  }
  if (datos.recargoDomicilio) filaValor('Domicilio', fmt(datos.recargoDomicilio));
  if (datos.recargoTarjeta) filaValor('Recargo tarjeta', fmt(datos.recargoTarjeta));
  t.separador();
  t.linea(`TOTAL ${fmt(datos.total)}`, { anchoX2: true, altoX2: true, bold: true });
  if (datos.metodo) t.linea(`Pago: ${datos.metodo}`);
  else t.linea('PENDIENTE DE PAGO', { bold: true });
  t.saltos(1);
  if (datos.leyenda) parrafo(datos.leyenda);
  t.linea('Gracias por su compra', { centrar: true });
  t.cortar();
  return t.resultado();
}

// Ticket de confirmación de pago de nómina
function ticketNomina(datos, opciones = {}) {
  const fmt = (n) => '$' + Number(n || 0).toLocaleString('es-CO');
  const t = new TicketBuilder(Number(opciones.ancho || 32));
  t.linea('PAGO DE NOMINA', { anchoX2: true, altoX2: true, bold: true, centrar: true });
  t.separador();
  t.linea(`Empleado: ${datos.empleado}`, { altoX2: true });
  t.linea(`Fecha del turno: ${datos.jornada}`);
  t.linea(`Turno:      ${fmt(datos.valor_turno)}`);
  if (datos.descuento) t.linea(`Descuento: -${fmt(datos.descuento)}`);
  if (datos.bono) t.linea(`Bono:      +${fmt(datos.bono)}`);
  if (datos.concepto) t.linea(`Motivo: ${datos.concepto}`);
  t.separador();
  t.linea(`TOTAL ${fmt(datos.total)}`, { anchoX2: true, altoX2: true, bold: true });
  t.linea('Confirmado por el empleado en la app', {});
  t.linea(`Hora: ${opciones.hora || ''}`);
  t.cortar();
  return t.resultado();
}

// Ticket con código QR nativo (GS ( k) para pegar en el mostrador:
// los meseros lo escanean y el teléfono abre la app en la LAN.
function ticketAccesoQR(url, nombreRestaurante, ancho) {
  const t = new TicketBuilder(ancho || 32);
  t.linea(nombreRestaurante || 'Restaurante', { altoX2: true, bold: true, centrar: true });
  t.linea('Escanee para abrir la app:', { centrar: true });
  t.saltos(1);
  t.alinear(1);
  const datos = Buffer.from(url, 'ascii');
  const len = datos.length + 3;
  t.bytes(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00); // modelo 2
  t.bytes(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06);       // tamaño de módulo 6
  t.bytes(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31);       // corrección de errores M
  t.bytes(GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30); // almacenar datos
  t.partes.push(datos);
  t.bytes(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30);       // imprimir QR
  t.alinear(0);
  t.lineas.push(`[QR] ${url}`);
  t.saltos(1);
  t.linea(url, { centrar: true });
  t.cortar();
  return t.resultado();
}

module.exports = { ticketCocina, ticketNomina, ticketFactura, ticketAccesoQR, transliterar };

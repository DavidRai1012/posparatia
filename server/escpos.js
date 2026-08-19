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
  const porLinea = Math.max(6, Math.floor(384 / (ALTO_BASE * mult * 0.55)));
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

function agruparEnBloques(items) {
  const conBloque = items.some(it => it.bloque !== null && it.bloque !== undefined);
  if (!conBloque) return [items]; // compatibilidad: pedidos viejos o ticket de prueba
  const mapa = new Map();
  for (const it of items) {
    const b = it.bloque ?? 0;
    if (!mapa.has(b)) mapa.set(b, []);
    mapa.get(b).push(it);
  }
  return [...mapa.keys()].sort((a, b) => a - b).map(k => mapa.get(k));
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

  for (const bloque of agruparEnBloques(items)) {
    t.separador();
    let bloqueSinNotas = true;
    for (const it of bloque) {
      // El plato, al tamaño configurado (imagen: soporta tildes y tamaños intermedios)
      const nombre = `${it.cantidad > 1 ? it.cantidad + 'X ' : ''}${it.plato_nombre}`.toUpperCase();
      lineaEscalada(t, nombre, tamPlatos, false);
      // Sus notas, justo debajo, al tamaño de observaciones configurado
      const { chips, obs } = partesDeNota(it.nota);
      if (chips) { bloqueSinNotas = false; lineaEscalada(t, `>>${chips}`, tamObs, true); }
      if (obs) {
        bloqueSinNotas = false;
        lineaEscalada(t, '>>OBSERVACIONES:', tamObs, true);
        for (const lin of partirParaAncho(obs.toUpperCase(), tamObs)) lineaEscalada(t, lin, tamObs, true);
      }
    }
    if (bloqueSinNotas) t.linea('>>', { altoX2: true, bold: true });
  }

  t.saltos(1);
  t.linea(`Nombre: ${pedido.comensal}`, { altoX2: true });
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

module.exports = { ticketCocina, ticketAccesoQR, transliterar };

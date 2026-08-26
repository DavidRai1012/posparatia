// Renderiza texto como imagen ESC/POS (raster GS v 0).
//
// ¿Por qué? Los multiplicadores de tamaño de ESC/POS son enteros y la SAT 15T US
// además los topa en 2x. Renderizando el texto con una fuente TrueType de Windows
// (vía System.Drawing en PowerShell) se logra CUALQUIER tamaño (2.5x, 2.7x...)
// y rotación de 90 grados a tamaños grandes: girado, el límite de 384 puntos
// aplica al alto de las letras (ancho del papel) y el largo del papel es infinito.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ANCHO_PAPEL = 384; // puntos imprimibles en papel de 58mm (203 dpi)

// ---- 1. Renderizar el texto a un BMP con GDI+ (sin dependencias de npm) ----
function renderizarBMP(texto, altoPx, fuente) {
  const bmpPath = path.join(os.tmpdir(), `texto_${Date.now()}_${Math.floor(Math.random() * 1e6)}.bmp`);
  const textoPS = String(texto).replace(/'/g, "''");
  const fuentePS = String(fuente || 'Arial').replace(/'/g, "''");
  const script = `
Add-Type -AssemblyName System.Drawing
$f = New-Object System.Drawing.Font('${fuentePS}', ${Math.round(altoPx)}, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$medidor = New-Object System.Drawing.Bitmap(8, 8)
$gm = [System.Drawing.Graphics]::FromImage($medidor)
$tam = $gm.MeasureString('${textoPS}', $f)
$w = [int][Math]::Ceiling($tam.Width) + 4
$h = [int][Math]::Ceiling($tam.Height) + 4
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::SingleBitPerPixelGridFit
$g.DrawString('${textoPS}', $f, [System.Drawing.Brushes]::Black, 2, 2)
$bmp.Save('${bmpPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Bmp)
$g.Dispose(); $bmp.Dispose(); $gm.Dispose(); $medidor.Dispose()
`;
  const ps1 = bmpPath.replace(/\.bmp$/, '.ps1');
  // BOM obligatorio: sin él, PowerShell 5.1 lee el .ps1 como ANSI y una Ñ/tilde
  // se convierte en bytes que rompen el script (comanda lenta y errores al arrancar)
  fs.writeFileSync(ps1, '\uFEFF' + script, 'utf8');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { windowsHide: true });
  } finally {
    fs.unlink(ps1, () => {});
  }
  return bmpPath;
}

// ---- 2. Leer el BMP (24 o 32 bpp, sin compresión) a una matriz de puntos ----
function leerBMP(ruta) {
  const b = fs.readFileSync(ruta);
  const offsetDatos = b.readUInt32LE(10);
  const ancho = b.readInt32LE(18);
  let alto = b.readInt32LE(22);
  const bpp = b.readUInt16LE(28);
  const abajoArriba = alto > 0;
  alto = Math.abs(alto);
  if (bpp !== 24 && bpp !== 32) throw new Error(`BMP con ${bpp} bpp no soportado`);
  const bytesPx = bpp / 8;
  const stride = Math.ceil((ancho * bytesPx) / 4) * 4;
  const pix = new Uint8Array(ancho * alto); // 1 = punto negro
  for (let y = 0; y < alto; y++) {
    const filaSrc = abajoArriba ? alto - 1 - y : y;
    const base = offsetDatos + filaSrc * stride;
    for (let x = 0; x < ancho; x++) {
      const i = base + x * bytesPx;
      const lum = (b[i] + b[i + 1] + b[i + 2]) / 3; // BGR
      if (lum < 128) pix[y * ancho + x] = 1;
    }
  }
  return { pix, ancho, alto };
}

// ---- 3. Recortar bordes blancos ----
function recortar({ pix, ancho, alto }, margen = 2) {
  let minX = ancho, maxX = -1, minY = alto, maxY = -1;
  for (let y = 0; y < alto; y++) for (let x = 0; x < ancho; x++) {
    if (pix[y * ancho + x]) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { pix: new Uint8Array(1), ancho: 1, alto: 1 }; // todo blanco
  minX = Math.max(0, minX - margen); maxX = Math.min(ancho - 1, maxX + margen);
  minY = Math.max(0, minY - margen); maxY = Math.min(alto - 1, maxY + margen);
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    out[y * w + x] = pix[(minY + y) * ancho + (minX + x)];
  }
  return { pix: out, ancho: w, alto: h };
}

// ---- 4. Rotar 90 grados (horario) ----
function rotar90({ pix, ancho, alto }) {
  const out = new Uint8Array(ancho * alto);
  const w2 = alto, h2 = ancho;
  for (let y = 0; y < alto; y++) for (let x = 0; x < ancho; x++) {
    if (pix[y * ancho + x]) out[x * w2 + (alto - 1 - y)] = 1;
  }
  return { pix: out, ancho: w2, alto: h2 };
}

// ---- 5. Empaquetar como raster ESC/POS (GS v 0) ----
function empaquetarRaster({ pix, ancho, alto }, centrar) {
  let img = { pix, ancho, alto };
  if (img.ancho > ANCHO_PAPEL) throw new Error(`Imagen de ${img.ancho} puntos no cabe en ${ANCHO_PAPEL}`);
  if (centrar) {
    const margen = Math.floor((ANCHO_PAPEL - img.ancho) / 2);
    const w = img.ancho + margen;
    const out = new Uint8Array(w * img.alto);
    for (let y = 0; y < img.alto; y++) for (let x = 0; x < img.ancho; x++) {
      out[y * w + margen + x] = img.pix[y * img.ancho + x];
    }
    img = { pix: out, ancho: w, alto: img.alto };
  }
  const bytesFila = Math.ceil(img.ancho / 8);
  const datos = Buffer.alloc(bytesFila * img.alto);
  for (let y = 0; y < img.alto; y++) for (let x = 0; x < img.ancho; x++) {
    if (img.pix[y * img.ancho + x]) datos[y * bytesFila + (x >> 3)] |= (0x80 >> (x & 7));
  }
  const cab = Buffer.from([0x1d, 0x76, 0x30, 0x00,
    bytesFila & 0xff, (bytesFila >> 8) & 0xff,
    img.alto & 0xff, (img.alto >> 8) & 0xff]);
  return Buffer.concat([cab, datos]);
}

// ---- API principal ----
// rasterizarInfo devuelve { buffer, ancho, alto } (dimensiones reales ya recortadas).
// opciones: { rotado: bool, fuente: 'Arial', centrar: bool, maxAncho: 384 }
function rasterizarInfo(texto, altoPx, opciones = {}) {
  let intento = Math.round(altoPx);
  for (let i = 0; i < 6; i++) {
    const bmp = renderizarBMP(texto, intento, opciones.fuente);
    let img;
    try { img = recortar(leerBMP(bmp)); } finally { fs.unlink(bmp, () => {}); }
    if (opciones.rotado) img = rotar90(img);
    if (img.ancho <= (opciones.maxAncho || ANCHO_PAPEL)) {
      return { buffer: empaquetarRaster(img, opciones.centrar !== false), ancho: img.ancho, alto: img.alto };
    }
    // No cabe: reducir proporcionalmente y reintentar
    intento = Math.floor(intento * (opciones.maxAncho || ANCHO_PAPEL) / img.ancho);
    if (intento < 8) break;
  }
  throw new Error(`El texto "${texto}" no cabe en el papel ni reduciéndolo`);
}

function textoAEscposRaster(texto, altoPx, opciones = {}) {
  return rasterizarInfo(texto, altoPx, opciones).buffer;
}

// Renderiza apuntando a una ALTURA REAL en puntos (ej: 72 = "x3"), con caché en
// memoria: los nombres de platos se repiten en cada comanda, así que tras la
// primera impresión el costo de renderizar es cero.
const cacheRaster = new Map();
function rasterizarAlturaObjetivo(texto, altoObjetivo, opciones = {}) {
  const clave = `${texto}|h${altoObjetivo}|${opciones.rotado ? 1 : 0}|${opciones.fuente || 'Arial'}|${opciones.centrar === false ? 0 : 1}`;
  if (cacheRaster.has(clave)) return cacheRaster.get(clave);
  // el alto recortado queda en ~72% del tamaño em pedido; se afina en segunda pasada
  let em = Math.round(altoObjetivo / 0.72);
  let r = rasterizarInfo(texto, em, opciones);
  if (Math.abs(r.alto - altoObjetivo) > 2 && r.alto > 0) {
    em = Math.round(em * altoObjetivo / r.alto);
    r = rasterizarInfo(texto, Math.max(8, em), opciones);
  }
  cacheRaster.set(clave, r);
  return r;
}

// Pre-renderiza una lista de textos para que la primera comanda del día no espere
function precalentar(textos, altoObjetivo, opciones = {}) {
  for (const t of textos) {
    try { rasterizarAlturaObjetivo(t, altoObjetivo, opciones); } catch { /* texto imposible: se ignora */ }
  }
}

// Vista previa en consola (para verificar sin gastar papel)
function previewASCII(texto, altoPx, opciones = {}) {
  const bmp = renderizarBMP(texto, Math.round(altoPx), opciones.fuente);
  let img;
  try { img = recortar(leerBMP(bmp)); } finally { fs.unlink(bmp, () => {}); }
  if (opciones.rotado) img = rotar90(img);
  const paso = Math.max(1, Math.ceil(img.ancho / 60));
  const lineas = [];
  for (let y = 0; y < img.alto; y += paso * 2) {
    let l = '';
    for (let x = 0; x < img.ancho; x += paso) l += img.pix[y * img.ancho + x] ? '#' : '.';
    lineas.push(l);
  }
  return { ancho: img.ancho, alto: img.alto, dibujo: lineas.join('\n') };
}

module.exports = { textoAEscposRaster, rasterizarInfo, rasterizarAlturaObjetivo, precalentar, previewASCII, ANCHO_PAPEL };

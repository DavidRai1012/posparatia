// Escala fina de tamaños imprimiendo el texto como IMAGEN (no fuente nativa).
// La SAT topa la fuente nativa en 2x; con imágenes logramos 2.1x, 2.5x, 2.8x...
// y texto girado 90 grados a tamaños grandes.
//
// Uso:  node herramientas/prueba-tamano-imagen.js
//       node herramientas/prueba-tamano-imagen.js --texto "MARIA FERNANDA"
//       node herramientas/prueba-tamano-imagen.js --sin-girados
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { rasterizarInfo } = require('../server/texto-bitmap');

const ESC = 0x1b, GS = 0x1d;
const args = process.argv.slice(2);
const valorDe = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const texto = valorDe('--texto') || 'CARLOS';
const share = valorDe('--share') || 'POS58';
const NATIVO = 24; // alto en puntos de la fuente nativa en 1x

const partes = [];
const bytes = (...b) => partes.push(Buffer.from(b));
const linea = (s) => partes.push(Buffer.from(s + '\n', 'ascii'));

bytes(ESC, 0x40);
bytes(ESC, 0x61, 1); // centrar
bytes(ESC, 0x45, 1); linea('ESCALA FINA (imagen)'); bytes(ESC, 0x45, 0);
bytes(ESC, 0x61, 0);
linea('--------------------------------');

// Referencia: la fuente nativa en 2x2 (el tope de la impresora)
linea('NATIVO 2x2 (referencia):');
bytes(GS, 0x21, 0x11);
linea(texto);
bytes(GS, 0x21, 0x00);
linea('');

// Serie fina: buscamos alturas reales de ~2.0x a ~3.0x en pasos parejos
console.log('Renderizando muestras (unos segundos)...');
const objetivos = [48, 50, 53, 55, 58, 60, 62, 65, 67, 70, 72]; // puntos = 2.0x .. 3.0x
const vistos = new Set();
for (const objetivo of objetivos) {
  // el alto recortado es ~72% del tamaño em pedido; afinamos con una segunda pasada
  let em = Math.round(objetivo / 0.72);
  let r = rasterizarInfo(texto, em, {});
  if (Math.abs(r.alto - objetivo) > 2) {
    em = Math.round(em * objetivo / r.alto);
    r = rasterizarInfo(texto, em, {});
  }
  if (vistos.has(r.alto)) continue;
  vistos.add(r.alto);
  const mult = (r.alto / NATIVO).toFixed(1);
  linea(`x${mult}  (${r.alto} puntos de alto):`);
  partes.push(r.buffer);
  linea('');
  console.log(`  x${mult}: ${r.ancho}x${r.alto} puntos`);
}

// Girados 90: ahora sí en grande (el largo del papel no tiene límite)
if (!args.includes('--sin-girados')) {
  linea('--------------------------------');
  bytes(ESC, 0x45, 1); linea('GIRADOS 90 (imagen):'); bytes(ESC, 0x45, 0);
  for (const [etiqueta, em] of [['x4', 133], ['x6', 200], ['x9', 300]]) {
    let r;
    try { r = rasterizarInfo(texto, em, { rotado: true }); }
    catch (e) { linea(`${etiqueta}: no cabe (${e.message})`); continue; }
    linea(`${etiqueta} girado (letras de ${r.ancho} puntos):`);
    partes.push(r.buffer);
    linea('');
    console.log(`  ${etiqueta} girado: ${r.ancho}x${r.alto} puntos`);
  }
}

linea('== FIN ==');
partes.push(Buffer.from('\n\n\n'));
bytes(GS, 0x56, 0x42, 0x00);

const buf = Buffer.concat(partes);
const tmp = path.join(os.tmpdir(), `escala_${Date.now()}.bin`);
fs.writeFileSync(tmp, buf);
try {
  execFileSync('cmd.exe', ['/c', 'copy', '/b', tmp, `\\\\localhost\\${share}`], { windowsHide: true });
  console.log(`Enviado a \\\\localhost\\${share} (${buf.length} bytes). Revise el papel.`);
} finally {
  fs.unlinkSync(tmp);
}

// Imprime una COMANDA DE MUESTRA con el nombre del comensal girado 90 grados
// como imagen, para evaluar formato y gasto de papel antes de adoptarlo.
//
// Uso: node herramientas/prueba-comanda.js
//      node herramientas/prueba-comanda.js --nombre "MARIA FERNANDA" --em 100
//   --em controla el tamaño del nombre girado (133 = x4, 200 = x6)
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { rasterizarInfo } = require('../server/texto-bitmap');

const ESC = 0x1b, GS = 0x1d;
const args = process.argv.slice(2);
const valorDe = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const nombre = (valorDe('--nombre') || 'CARLOS').toUpperCase();
const em = Number(valorDe('--em') || 133); // 133 ~ x4
const share = valorDe('--share') || 'POS58';

// Platos de la muestra: los que pidió el usuario
const platos = [
  { nombre: 'Pollo', nota: null },
  { nombre: 'Cerdo', nota: null },
  { nombre: 'Carne', nota: 'Sin ensalada' }
];

const partes = [];
let puntosAlto = 0; // acumulador para estimar el largo del papel
const bytes = (...b) => partes.push(Buffer.from(b));
const linea = (s, dots) => { partes.push(Buffer.from(s + '\n', 'ascii')); puntosAlto += dots || 24; };

bytes(ESC, 0x40);

// Cabecera igual a la comanda real
bytes(ESC, 0x61, 1);
const hora = new Date().toTimeString().slice(0, 5);
linea(`COMANDA 001   ${hora}`);
bytes(ESC, 0x61, 0);
linea('-'.repeat(32));

// Nombre del comensal: girado 90, como imagen
const r = rasterizarInfo(nombre, em, { rotado: true, centrar: true });
partes.push(r.buffer);
puntosAlto += r.alto;

linea('-'.repeat(32));

// Platos en doble alto, notas en negrita como en la comanda real
for (const p of platos) {
  bytes(GS, 0x21, 0x01); // doble alto
  linea(p.nombre, 48);
  if (p.nota) {
    bytes(ESC, 0x45, 1);
    linea(`>> NOTA: ${p.nota}`, 48);
    bytes(ESC, 0x45, 0);
  }
  bytes(GS, 0x21, 0x00);
}
linea('-'.repeat(32));

partes.push(Buffer.from('\n\n\n')); puntosAlto += 72;
bytes(GS, 0x56, 0x42, 0x00);

// 203 dpi ~ 8 puntos por mm
const cm = (puntosAlto / 8 / 10).toFixed(1);
const cmNombre = (r.alto / 8 / 10).toFixed(1);
console.log(`Nombre girado: ${r.ancho}x${r.alto} puntos (${cmNombre} cm de papel solo el nombre)`);
console.log(`Largo total estimado de la comanda: ~${cm} cm`);

const buf = Buffer.concat(partes);
const tmp = path.join(os.tmpdir(), `comanda_${Date.now()}.bin`);
fs.writeFileSync(tmp, buf);
try {
  execFileSync('cmd.exe', ['/c', 'copy', '/b', tmp, `\\\\localhost\\${share}`], { windowsHide: true });
  console.log(`Enviado a \\\\localhost\\${share}. Revise el papel.`);
} finally {
  fs.unlinkSync(tmp);
}

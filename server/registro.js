// Registro de actividad del servidor EN ARCHIVO, no en la ventana negra.
// Lo que hace el sistema por dentro (envíos a Google Sheets, correos,
// reintentos) asustaba a la cajera cuando aparecía en la terminal ("¿se dañó?"),
// así que la terminal solo muestra el arranque; lo demás queda en
// data\registro.log para cuando haya que revisar algo.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./db');

const ARCHIVO = path.join(DATA_DIR, 'registro.log');
const MAX_BYTES = 1024 * 1024; // al pasar de 1 MB se guarda como .anterior y se empieza otro
const ultimos = [];            // las últimas líneas en memoria, para el solucionador

function registrar(tipo, mensaje) {
  const linea = `${new Date().toLocaleString('sv-SE')} [${tipo}] ${mensaje}`;
  ultimos.push(linea);
  if (ultimos.length > 200) ultimos.shift();
  try {
    try {
      if (fs.statSync(ARCHIVO).size > MAX_BYTES) fs.renameSync(ARCHIVO, ARCHIVO.replace(/\.log$/, '.anterior.log'));
    } catch { /* todavía no existe */ }
    fs.appendFileSync(ARCHIVO, linea + '\n');
  } catch { /* disco lleno o sin permisos: no vale la pena tumbar nada por el registro */ }
}

function ultimasLineas(n = 50) { return ultimos.slice(-n); }

module.exports = { registrar, ultimasLineas, ARCHIVO };

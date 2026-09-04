// Cola de impresión única del servidor con drivers intercambiables.
//
// Todos los pedidos, sin importar desde qué teléfono se registren, pasan por
// esta cola. El modo de salida se configura en Admin y puede cambiarse en
// caliente sin reiniciar:
//   - simulado : escribe el ticket en data/impresiones.log (para desarrollo/pruebas)
//   - usb      : impresora conectada por USB al PC, compartida en Windows
//                (se envían los bytes crudos con `copy /b archivo \\localhost\<share>`)
//   - com      : impresora Bluetooth emparejada con el PC (puerto serie COMx)
//   - puente   : un teléfono con la vista "Estación de impresión" abierta recibe
//                el trabajo por WebSocket y lo imprime por Bluetooth (BLE o RawBT)

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { db, ahora, getConfig, DATA_DIR } = require('./db');
const { registrar } = require('./registro');

let io = null;                 // socket.io, inyectado desde index.js
let procesando = false;
let socketPuente = null;       // socket del teléfono "estación de impresión"
const acksPendientes = new Map(); // trabajoId -> {resolve, reject, timer}

function setIO(_io) { io = _io; }

function estadoCola() {
  const filas = db.prepare(
    `SELECT ci.id, ci.pedido_id, ci.tipo, ci.estado, ci.intentos, ci.error, ci.creado_en, ci.impreso_en,
            p.numero_comanda, p.comensal
     FROM cola_impresion ci LEFT JOIN pedidos p ON p.id = ci.pedido_id
     ORDER BY ci.id DESC LIMIT 50`).all();
  return {
    modo: getConfig('modo_impresion'),
    puenteConectado: !!socketPuente,
    trabajos: filas
  };
}

function notificarEstado() {
  if (io) io.emit('impresion:estado', estadoCola());
}

function encolar(pedidoId, tipo, ticket) {
  db.prepare('INSERT INTO cola_impresion (pedido_id, tipo, texto, raw, estado, creado_en) VALUES (?, ?, ?, ?, ?, ?)')
    .run(pedidoId, tipo, ticket.texto, ticket.raw.toString('base64'), 'pendiente', ahora());
  procesarCola();
}

async function procesarCola() {
  if (procesando) return;
  procesando = true;
  try {
    for (;;) {
      const trabajo = db.prepare(
        "SELECT * FROM cola_impresion WHERE estado = 'pendiente' AND intentos < 3 ORDER BY id LIMIT 1").get();
      if (!trabajo) break;
      const modo = getConfig('modo_impresion');
      try {
        await imprimirTrabajo(trabajo, modo);
        db.prepare("UPDATE cola_impresion SET estado = 'impreso', impreso_en = ?, error = NULL WHERE id = ?")
          .run(ahora(), trabajo.id);
      } catch (err) {
        const intentos = trabajo.intentos + 1;
        const estado = intentos >= 3 ? 'error' : 'pendiente';
        db.prepare('UPDATE cola_impresion SET intentos = ?, estado = ?, error = ? WHERE id = ?')
          .run(intentos, estado, String(err.message || err), trabajo.id);
        if (modo === 'puente' && !socketPuente) break; // sin puente conectado: retener y no quemar intentos
        if (estado === 'pendiente') await esperar(2000); // pausa breve antes de reintentar
        else registrar('impresion', `trabajo ${trabajo.id} en error tras 3 intentos: ${err.message}`);
      }
      notificarEstado();
    }
  } finally {
    procesando = false;
    notificarEstado();
  }
}

function imprimirTrabajo(trabajo, modo) {
  const raw = Buffer.from(trabajo.raw, 'base64');
  switch (modo) {
    case 'simulado': return driverSimulado(trabajo, raw);
    case 'usb': return driverUsbWindows(raw);
    case 'com': return driverPuertoCom(raw);
    case 'puente': return driverPuente(trabajo);
    default: return Promise.reject(new Error(`Modo de impresión desconocido: ${modo}`));
  }
}

// --- Driver 1: simulado (desarrollo) ---
function driverSimulado(trabajo, _raw) {
  const log = path.join(DATA_DIR, 'impresiones.log');
  const bloque = `\n===== [${ahora()}] trabajo ${trabajo.id} (${trabajo.tipo}) =====\n${trabajo.texto}\n`;
  fs.appendFileSync(log, bloque, 'utf8');
  return Promise.resolve();
}

// --- Driver 2: USB en Windows via impresora compartida ---
// Requiere compartir la impresora térmica en Windows (p. ej. con el nombre "POS58").
// `copy /b` envía los bytes ESC/POS sin que el driver de Windows los altere.
function driverUsbWindows(raw) {
  return new Promise((resolve, reject) => {
    const share = getConfig('impresora_share');
    if (!share) return reject(new Error('No hay nombre de impresora compartida configurado'));
    const tmp = path.join(DATA_DIR, `ticket_${Date.now()}.bin`);
    fs.writeFileSync(tmp, raw);
    execFile('cmd.exe', ['/c', 'copy', '/b', tmp, `\\\\localhost\\${share}`], { windowsHide: true }, (err, _out, stderr) => {
      fs.unlink(tmp, () => {});
      if (err) reject(new Error(`Fallo al copiar a \\\\localhost\\${share}: ${stderr || err.message}`));
      else resolve();
    });
  });
}

// --- Driver 3: puerto serie (Bluetooth emparejado con el PC) ---
function driverPuertoCom(raw) {
  return new Promise((resolve, reject) => {
    let SerialPort;
    try { ({ SerialPort } = require('serialport')); }
    catch { return reject(new Error('El paquete serialport no está instalado')); }
    const puerto = getConfig('puerto_com');
    const port = new SerialPort({ path: puerto, baudRate: 9600, autoOpen: false });
    port.open((err) => {
      if (err) return reject(new Error(`No se pudo abrir ${puerto}: ${err.message}`));
      port.write(raw, (errW) => {
        if (errW) { port.close(() => {}); return reject(errW); }
        port.drain(() => port.close(() => resolve()));
      });
    });
  });
}

// --- Driver 4: teléfono puente (WebSocket) ---
function driverPuente(trabajo) {
  return new Promise((resolve, reject) => {
    if (!socketPuente) return reject(new Error('Ningún teléfono tiene abierta la Estación de impresión'));
    const timer = setTimeout(() => {
      acksPendientes.delete(trabajo.id);
      reject(new Error('El teléfono puente no confirmó la impresión (timeout 20s)'));
    }, 20000);
    acksPendientes.set(trabajo.id, { resolve, reject, timer });
    socketPuente.emit('trabajo:imprimir', {
      id: trabajo.id, tipo: trabajo.tipo, texto: trabajo.texto, raw: trabajo.raw
    });
  });
}

function registrarPuente(socket) {
  socketPuente = socket;
  registrar('impresion', `Estación de impresión conectada: ${socket.id}`);
  socket.on('trabajo:resultado', ({ id, ok, error }) => {
    const ack = acksPendientes.get(id);
    if (!ack) return;
    acksPendientes.delete(id);
    clearTimeout(ack.timer);
    if (ok) ack.resolve();
    else ack.reject(new Error(error || 'El teléfono reportó un fallo de impresión'));
  });
  socket.on('disconnect', () => {
    if (socketPuente === socket) {
      socketPuente = null;
      registrar('impresion', 'Estación de impresión desconectada');
      notificarEstado();
    }
  });
  notificarEstado();
  procesarCola(); // al reconectar el puente, drenar lo retenido en orden de llegada
}

function reintentarTrabajo(id) {
  db.prepare("UPDATE cola_impresion SET estado = 'pendiente', intentos = 0, error = NULL WHERE id = ?").run(id);
  procesarCola();
}

// Descartar trabajos que ya no interesan (p. ej. comandas atascadas por una
// impresora mal configurada). El pedido no se toca: se puede Reimprimir después.
function descartarTrabajo(id) {
  db.prepare("DELETE FROM cola_impresion WHERE id = ? AND estado != 'impreso'").run(id);
  notificarEstado();
}

function descartarNoImpresos() {
  const n = db.prepare("SELECT COUNT(*) AS n FROM cola_impresion WHERE estado != 'impreso'").get().n;
  db.prepare("DELETE FROM cola_impresion WHERE estado != 'impreso'").run();
  notificarEstado();
  return n;
}

function esperar(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { setIO, encolar, procesarCola, estadoCola, notificarEstado, registrarPuente, reintentarTrabajo, descartarTrabajo, descartarNoImpresos };

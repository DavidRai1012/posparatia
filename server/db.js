// Base de datos local SQLite del POS. Un solo archivo en /data para que
// sobreviva reinicios del PC y sea fácil de respaldar copiándolo.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'pos.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  pin TEXT NOT NULL UNIQUE,
  rol TEXT NOT NULL CHECK(rol IN ('admin','cajero','mesero','cocinera')),
  valor_turno INTEGER NOT NULL DEFAULT 0,
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS gastos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jornada TEXT NOT NULL,
  concepto TEXT NOT NULL,
  valor INTEGER NOT NULL,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nomina (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empleado_id INTEGER NOT NULL REFERENCES usuarios(id),
  jornada TEXT NOT NULL,
  valor_turno INTEGER NOT NULL,
  descuento INTEGER NOT NULL DEFAULT 0,
  bono INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  concepto TEXT,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','confirmado','anulado')),
  registrado_por INTEGER NOT NULL REFERENCES usuarios(id),
  confirmado_en TEXT,
  creado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  precio INTEGER NOT NULL,
  categoria TEXT NOT NULL DEFAULT 'General',
  tipo TEXT NOT NULL DEFAULT 'proteina_dia'
    CHECK(tipo IN ('entrada','proteina_dia','proteina_especial','bebida','extra')),
  precio_solo INTEGER,
  acronimo TEXT,
  disponible INTEGER NOT NULL DEFAULT 1,
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS pedidos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE,
  numero_comanda INTEGER NOT NULL,
  jornada TEXT NOT NULL,
  comensal TEXT NOT NULL,
  tipo_entrega TEXT NOT NULL DEFAULT 'mesa' CHECK(tipo_entrega IN ('mesa','llevar')),
  estado TEXT NOT NULL DEFAULT 'en_proceso' CHECK(estado IN ('en_proceso','entregado','cancelado')),
  vendedor_id INTEGER NOT NULL REFERENCES usuarios(id),
  recargo INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT,
  entregado_en TEXT,
  cancelado_en TEXT
);
CREATE INDEX IF NOT EXISTS idx_pedidos_jornada ON pedidos(jornada);

CREATE TABLE IF NOT EXISTS pedido_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  plato_nombre TEXT NOT NULL,
  precio INTEGER NOT NULL,
  cantidad INTEGER NOT NULL DEFAULT 1,
  nota TEXT,
  bloque INTEGER,
  solo INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pagos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER NOT NULL UNIQUE REFERENCES pedidos(id),
  metodo TEXT NOT NULL CHECK(metodo IN ('efectivo','tarjeta','nequi','daviplata','qr_bancolombia','tarjeta_debito','tarjeta_credito','billetera')),
  monto INTEGER NOT NULL,
  recibido INTEGER,
  vueltas INTEGER,
  recargo_tarjeta INTEGER NOT NULL DEFAULT 0,
  cajero_id INTEGER NOT NULL REFERENCES usuarios(id),
  jornada TEXT NOT NULL,
  creado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cola_impresion (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER REFERENCES pedidos(id),
  tipo TEXT NOT NULL,
  texto TEXT NOT NULL,
  raw TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','impreso','error')),
  intentos INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  creado_en TEXT NOT NULL,
  impreso_en TEXT
);

CREATE TABLE IF NOT EXISTS cola_sheets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','enviado')),
  creado_en TEXT NOT NULL,
  enviado_en TEXT
);

CREATE TABLE IF NOT EXISTS cola_correos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jornada TEXT NOT NULL,
  asunto TEXT NOT NULL,
  cuerpo TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','enviado')),
  creado_en TEXT NOT NULL,
  enviado_en TEXT
);

CREATE TABLE IF NOT EXISTS cierres (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jornada TEXT NOT NULL UNIQUE,
  datos TEXT NOT NULL,
  efectivo_contado INTEGER,
  descuadre INTEGER,
  creado_en TEXT NOT NULL
);

-- Dinero con el que arrancó el día (base de caja). Opcional: si no se registra,
-- se asume que lo contado en el cierre anterior sigue en la caja.
CREATE TABLE IF NOT EXISTS base_caja (
  jornada TEXT PRIMARY KEY,
  valor INTEGER NOT NULL,
  usuario_id INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL
);

-- Corrección del TOTAL del día por método de pago (p. ej. Nequi real según el
-- extracto). No toca los pagos uno a uno: el reporte muestra el valor real y
-- los almuerzos de ese método pasan a ser un aproximado.
-- La columna registrado guarda lo que sumaban los pagos EN EL MOMENTO de
-- corregir. La corrección se aplica como diferencia (total_real - registrado),
-- no como reemplazo: así, si después entra un pago, se anula uno o se
-- rectifica su método, el total real se mueve con ellos en vez de congelarse.
CREATE TABLE IF NOT EXISTS ajustes_metodo (
  jornada TEXT NOT NULL,
  metodo TEXT NOT NULL,
  total_real INTEGER NOT NULL,
  registrado INTEGER NOT NULL DEFAULT 0,
  usuario_id INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL,
  PRIMARY KEY (jornada, metodo)
);

CREATE TABLE IF NOT EXISTS historial (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER REFERENCES pedidos(id),
  usuario_id INTEGER REFERENCES usuarios(id),
  accion TEXT NOT NULL,
  detalle TEXT,
  creado_en TEXT NOT NULL
);
`);

// Migración: agregar 'nequi' y 'daviplata' al CHECK de pagos sin perder registros
const esquemaPagos = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pagos'").get();
if (esquemaPagos && !esquemaPagos.sql.includes('nequi')) {
  db.exec(`
    CREATE TABLE pagos_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL UNIQUE REFERENCES pedidos(id),
      metodo TEXT NOT NULL CHECK(metodo IN ('efectivo','tarjeta','nequi','daviplata','qr_bancolombia','tarjeta_debito','tarjeta_credito','billetera')),
      monto INTEGER NOT NULL,
      recibido INTEGER,
      vueltas INTEGER,
      cajero_id INTEGER NOT NULL REFERENCES usuarios(id),
      jornada TEXT NOT NULL,
      creado_en TEXT NOT NULL
    );
    INSERT INTO pagos_v2 SELECT * FROM pagos;
    DROP TABLE pagos;
    ALTER TABLE pagos_v2 RENAME TO pagos;
  `);
  console.log('[db] Migración aplicada: métodos de pago Nequi y Daviplata');
}

// Migración: método de pago QR Bancolombia
const esquemaPagosV3 = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pagos'").get();
if (esquemaPagosV3 && !esquemaPagosV3.sql.includes('qr_bancolombia')) {
  db.exec(`
    CREATE TABLE pagos_v3 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL UNIQUE REFERENCES pedidos(id),
      metodo TEXT NOT NULL CHECK(metodo IN ('efectivo','tarjeta','nequi','daviplata','qr_bancolombia','tarjeta_debito','tarjeta_credito','billetera')),
      monto INTEGER NOT NULL,
      recibido INTEGER,
      vueltas INTEGER,
      cajero_id INTEGER NOT NULL REFERENCES usuarios(id),
      jornada TEXT NOT NULL,
      creado_en TEXT NOT NULL
    );
    INSERT INTO pagos_v3 SELECT * FROM pagos;
    DROP TABLE pagos;
    ALTER TABLE pagos_v3 RENAME TO pagos;
  `);
  console.log('[db] Migración aplicada: método de pago QR Bancolombia');
}

// Migración: columna tipo en platos y bloque (número de almuerzo) en pedido_items
if (!db.prepare('PRAGMA table_info(platos)').all().some(c => c.name === 'tipo')) {
  db.exec("ALTER TABLE platos ADD COLUMN tipo TEXT NOT NULL DEFAULT 'proteina_dia'");
  db.prepare("UPDATE platos SET tipo = 'proteina_especial' WHERE lower(categoria) LIKE 'especial%'").run();
  console.log('[db] Migración aplicada: tipos de plato');
}
if (!db.prepare('PRAGMA table_info(pedido_items)').all().some(c => c.name === 'bloque')) {
  db.exec('ALTER TABLE pedido_items ADD COLUMN bloque INTEGER');
  console.log('[db] Migración aplicada: bloque de almuerzo en items');
}

// Migración: valor del turno por empleado y recargo de tarjeta en pagos
if (!db.prepare('PRAGMA table_info(usuarios)').all().some(c => c.name === 'valor_turno')) {
  db.exec('ALTER TABLE usuarios ADD COLUMN valor_turno INTEGER NOT NULL DEFAULT 0');
  console.log('[db] Migración aplicada: valor de turno por empleado');
}
if (!db.prepare('PRAGMA table_info(pagos)').all().some(c => c.name === 'recargo_tarjeta')) {
  db.exec('ALTER TABLE pagos ADD COLUMN recargo_tarjeta INTEGER NOT NULL DEFAULT 0');
  console.log('[db] Migración aplicada: recargo de tarjeta en pagos');
}
if (!db.prepare('PRAGMA table_info(nomina)').all().some(c => c.name === 'concepto')) {
  db.exec('ALTER TABLE nomina ADD COLUMN concepto TEXT');
  console.log('[db] Migración aplicada: concepto en nómina');
}

// Migración: precio "solo" (plato del día vendido por fuera del almuerzo completo)
if (!db.prepare('PRAGMA table_info(platos)').all().some(c => c.name === 'precio_solo')) {
  db.exec('ALTER TABLE platos ADD COLUMN precio_solo INTEGER');
  db.exec('ALTER TABLE pedido_items ADD COLUMN solo INTEGER NOT NULL DEFAULT 0');
  console.log('[db] Migración aplicada: precio de platos del día vendidos solos');
}

// Migración: acrónimo del plato para la comanda ("CREMA" en vez de
// "Crema de champiñones con pollo"; los reportes usan el nombre completo)
if (!db.prepare('PRAGMA table_info(platos)').all().some(c => c.name === 'acronimo')) {
  db.exec('ALTER TABLE platos ADD COLUMN acronimo TEXT');
  console.log('[db] Migración aplicada: acrónimos de platos');
}

// Migración: rol "cocinera" (sin acceso a la app, solo para nómina).
// usuarios es referenciada por casi todas las tablas: hay que reconstruirla
// con las llaves foráneas APAGADAS (las referencias son por nombre y se
// conservan al renombrar).
const esquemaUsuarios = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'usuarios'").get();
if (esquemaUsuarios && !esquemaUsuarios.sql.includes('cocinera')) {
  db.pragma('foreign_keys = OFF');
  db.exec(`
    DROP TABLE IF EXISTS usuarios_v2;
    CREATE TABLE usuarios_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      pin TEXT NOT NULL UNIQUE,
      rol TEXT NOT NULL CHECK(rol IN ('admin','cajero','mesero','cocinera')),
      valor_turno INTEGER NOT NULL DEFAULT 0,
      activo INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO usuarios_v2 (id, nombre, pin, rol, valor_turno, activo)
      SELECT id, nombre, pin, rol, valor_turno, activo FROM usuarios;
    DROP TABLE usuarios;
    ALTER TABLE usuarios_v2 RENAME TO usuarios;
  `);
  db.pragma('foreign_keys = ON');
  console.log('[db] Migración aplicada: rol cocinera');
}

// Migración: tipo "bebida" (jugo/limonada incluidos en el almuerzo)
const esquemaPlatos = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'platos'").get();
if (esquemaPlatos && !esquemaPlatos.sql.includes('bebida')) {
  db.exec(`
    CREATE TABLE platos_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      precio INTEGER NOT NULL,
      categoria TEXT NOT NULL DEFAULT 'General',
      tipo TEXT NOT NULL DEFAULT 'proteina_dia'
        CHECK(tipo IN ('entrada','proteina_dia','proteina_especial','bebida','extra')),
      disponible INTEGER NOT NULL DEFAULT 1,
      activo INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO platos_v2 (id, nombre, precio, categoria, tipo, disponible, activo)
      SELECT id, nombre, precio, categoria, tipo, disponible, activo FROM platos;
    DROP TABLE platos;
    ALTER TABLE platos_v2 RENAME TO platos;
  `);
  console.log('[db] Migración aplicada: tipo bebida incluida');
}

// Migración: "tipo" del plato para el reporte de compras (pollo, carne, cerdo...).
// En la base se llama `grupo` para no confundirlo con platos.tipo, que es la
// estructura del almuerzo (entrada / proteína / bebida / extra).
if (!db.prepare('PRAGMA table_info(platos)').all().some(c => c.name === 'grupo')) {
  db.exec('ALTER TABLE platos ADD COLUMN grupo TEXT');
  console.log('[db] Migración aplicada: tipo de proteína (pollo/carne/cerdo) por plato');
}

// Migración: precio por defecto. El 90% de las ~150 proteínas del día valen lo
// mismo y ese valor cambia cada año; con usa_default = 1 el plato toma el precio
// configurado en el Menú, así se cambia una vez y aplica a todos.
if (!db.prepare('PRAGMA table_info(platos)').all().some(c => c.name === 'usa_default')) {
  db.exec('ALTER TABLE platos ADD COLUMN usa_default INTEGER NOT NULL DEFAULT 0');
  console.log('[db] Migración aplicada: precio por defecto de proteínas y especiales');
}

// Migración: valor del turno POR DÍA DE LA SEMANA (de lunes a jueves vale una
// cosa, el sábado otra y el domingo otra). JSON de 7 valores con el índice de
// getDay() (0=domingo ... 6=sábado); un día en 0/vacío usa valor_turno de base.
if (!db.prepare('PRAGMA table_info(usuarios)').all().some(c => c.name === 'turnos')) {
  db.exec('ALTER TABLE usuarios ADD COLUMN turnos TEXT');
  console.log('[db] Migración aplicada: valor del turno por día de la semana');
}

// Migración: usuarios eliminados. No se pueden borrar de verdad si tienen
// ventas o nómina registradas (los reportes viejos los referencian), así que
// se marcan eliminados: desaparecen de todas las listas y su PIN queda libre.
if (!db.prepare('PRAGMA table_info(usuarios)').all().some(c => c.name === 'eliminado')) {
  db.exec('ALTER TABLE usuarios ADD COLUMN eliminado INTEGER NOT NULL DEFAULT 0');
  console.log('[db] Migración aplicada: eliminación de usuarios');
}

// Migración: los correos llevan versión HTML y archivos adjuntos (Excel del
// resumen del día, de nómina y del mes). Los adjuntos viajan en la cola en
// base64 para que sobrevivan sin internet, y se borran al enviarse.
if (!db.prepare('PRAGMA table_info(cola_correos)').all().some(c => c.name === 'adjuntos')) {
  db.exec('ALTER TABLE cola_correos ADD COLUMN html TEXT');
  db.exec('ALTER TABLE cola_correos ADD COLUMN adjuntos TEXT');
  console.log('[db] Migración aplicada: correos con HTML y adjuntos');
}

// Migración: la corrección de totales por método pasó de reemplazo a diferencia
if (!db.prepare('PRAGMA table_info(ajustes_metodo)').all().some(c => c.name === 'registrado')) {
  db.exec('ALTER TABLE ajustes_metodo ADD COLUMN registrado INTEGER NOT NULL DEFAULT 0');
  // Las correcciones viejas no saben contra qué se hicieron: se descartan para
  // que nadie herede un total congelado (se vuelven a hacer si hacen falta)
  db.exec('DELETE FROM ajustes_metodo');
  console.log('[db] Migración aplicada: correcciones de total por método como diferencia');
}

// ---- Helpers de fecha/hora local ----
function ahora() {
  return new Date().toLocaleString('sv-SE'); // "YYYY-MM-DD HH:MM:SS" en hora local
}
function jornadaHoy() {
  return new Date().toLocaleDateString('sv-SE'); // "YYYY-MM-DD"
}
function horaLocal() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---- Config ----
const CONFIG_DEFAULTS = {
  nombre_restaurante: 'Restaurante',
  recargo_empaque: '1500',
  hora_reporte: '22:00',
  correo_dueno: '',
  gmail_usuario: '',
  gmail_app_password: '',
  sheets_webhook_url: '',
  modo_impresion: 'simulado', // simulado | usb | com | puente
  impresora_share: 'POS58',   // nombre del recurso compartido de la impresora USB en Windows
  puerto_com: 'COM4',         // puerto serie del emparejamiento Bluetooth en el PC
  ancho_ticket: '32',         // caracteres por línea (32 = papel 58mm, 48 = 80mm)
  tamano_platos: '3',         // multiplicador de letra de los platos en el ticket (1 a 3)
  tamano_obs: '2',            // multiplicador de letra de las observaciones (1 a 3)
  // Recargo por pago con tarjeta: bajo el umbral se cobra el valor fijo; desde el umbral, el porcentaje
  recargo_tarjeta_fijo: '1000',
  recargo_tarjeta_umbral: '20000',
  recargo_tarjeta_pct: '5',
  // Cambios rápidos (chips de notas): editables por meseros y cajeros desde la pestaña Menú
  chips_notas: '["Sin arroz","Sin sopa","Sin ensalada"]',
  // Tipos de plato para el reporte de compras: "pollo a la jardinera" es del
  // tipo Pollo, "chuleta" es Cerdo... Los edita cualquier mesero o cajero.
  grupos_plato: '["Pollo","Carne","Cerdo","Pescado","Pasta","Vegetariano"]',
  // Precio por defecto del almuerzo (con entrada) y del plato vendido solo.
  // Casi todas las proteínas del día valen igual y el valor cambia cada año.
  precio_dia_entrada: '17500',
  precio_dia_solo: '17000',
  precio_especial_entrada: '26000',
  precio_especial_solo: '25000',
  // Meses cuyo reporte mensual ya se encoló (para no repetirlo en cada cierre)
  meses_reportados: '[]',
  // Cuenta de venta para el cliente (documento informativo; para factura
  // electrónica DIAN se requiere un proveedor autorizado)
  factura_titulo: 'FACTURA DE VENTA',
  factura_razon_social: '',
  factura_nit: '',
  factura_direccion: '',
  factura_telefono: '',
  factura_leyenda: 'No responsable de IVA. Documento informativo: no equivale a factura electronica.',
  factura_consecutivo: '0'
};

function getConfig(clave) {
  const row = db.prepare('SELECT valor FROM config WHERE clave = ?').get(clave);
  if (row) return row.valor;
  return CONFIG_DEFAULTS[clave] !== undefined ? CONFIG_DEFAULTS[clave] : null;
}
function setConfig(clave, valor) {
  db.prepare('INSERT INTO config (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor')
    .run(clave, String(valor));
}
function getConfigAll() {
  const out = { ...CONFIG_DEFAULTS };
  for (const row of db.prepare('SELECT clave, valor FROM config').all()) out[row.clave] = row.valor;
  return out;
}

// ---- Semilla inicial ----
const nUsuarios = db.prepare('SELECT COUNT(*) AS n FROM usuarios').get().n;
if (nUsuarios === 0) {
  db.prepare("INSERT INTO usuarios (nombre, pin, rol) VALUES ('Administrador', '1234', 'admin')").run();
  console.log('[db] Usuario inicial creado: Administrador / PIN 1234 (cámbielo en la sección Admin)');
}

// Menú de ejemplo para poder probar la app apenas se instala (editable/borrable en la pestaña Menú)
// Precios: la proteína del día lleva el precio del almuerzo completo; las entradas van en $0
// porque están incluidas; los especiales tienen su precio propio; los extras se cobran aparte.
const insPlato = db.prepare('INSERT INTO platos (nombre, precio, categoria, tipo, disponible) VALUES (?, ?, ?, ?, ?)');
const hayTipo = (t) => db.prepare('SELECT COUNT(*) AS n FROM platos WHERE tipo = ? AND activo = 1').get(t).n > 0;
if (!hayTipo('entrada')) {
  insPlato.run('Sopa', 0, 'Entrada', 'entrada', 1);
  insPlato.run('Crema', 0, 'Entrada', 'entrada', 1);
  insPlato.run('Fruta', 0, 'Entrada', 'entrada', 1);
  console.log('[db] Entradas de ejemplo creadas');
}
if (!hayTipo('proteina_dia') && !hayTipo('proteina_especial')) {
  insPlato.run('Pollo', 14000, 'Proteína del día', 'proteina_dia', 1);
  insPlato.run('Carne', 14000, 'Proteína del día', 'proteina_dia', 1);
  insPlato.run('Cerdo', 14000, 'Proteína del día', 'proteina_dia', 1);
  insPlato.run('Churrasco', 22000, 'Especiales', 'proteina_especial', 1);
  insPlato.run('Mojarra', 24000, 'Especiales', 'proteina_especial', 1);
  console.log('[db] Proteínas de ejemplo creadas');
}
if (!hayTipo('extra')) {
  insPlato.run('Gaseosa', 3000, 'Extras', 'extra', 1);
  insPlato.run('Jugo', 3000, 'Extras', 'extra', 1);
  insPlato.run('Postre', 4000, 'Extras', 'extra', 1);
  insPlato.run('Desechable completo', 1500, 'Extras', 'extra', 1);
  insPlato.run('Desechable de sopa', 800, 'Extras', 'extra', 1);
  console.log('[db] Extras de ejemplo creados');
}

function registrarHistorial(pedidoId, usuarioId, accion, detalle) {
  db.prepare('INSERT INTO historial (pedido_id, usuario_id, accion, detalle, creado_en) VALUES (?, ?, ?, ?, ?)')
    .run(pedidoId, usuarioId, accion, detalle || null, ahora());
}

function jornadaCerrada(jornada) {
  return !!db.prepare('SELECT id FROM cierres WHERE jornada = ?').get(jornada);
}

module.exports = {
  db, ahora, jornadaHoy, horaLocal,
  getConfig, setConfig, getConfigAll,
  registrarHistorial, jornadaCerrada, DATA_DIR
};

/* POS Restaurante - app web (vanilla JS)
   Corre en los teléfonos de los meseros y en el PC servidor. */
'use strict';

const $ = (sel) => document.querySelector(sel);
const fmt = (n) => '$' + Number(n || 0).toLocaleString('es-CO');
const METODOS = {
  efectivo: 'Efectivo', tarjeta: 'Tarjeta', nequi: 'Nequi', daviplata: 'Daviplata',
  qr_bancolombia: 'QR Bancolombia',
  tarjeta_debito: 'Tarjeta de débito', tarjeta_credito: 'Tarjeta de crédito', billetera: 'Billetera virtual'
};
// Métodos que se ofrecen al cobrar (los otros solo se muestran en reportes históricos)
const METODOS_COBRO = [
  ['efectivo', '💵 Efectivo'], ['tarjeta', '💳 Tarjeta'],
  ['nequi', '🟣 Nequi'], ['daviplata', '🔴 Daviplata'],
  ['qr_bancolombia', '🟡 QR Bancolombia']
];
// Cambios rápidos por plato: se cargan del servidor y los editan meseros/cajeros en Menú
function chipsNotas() { return (state.config && state.config.chips_notas) || []; }

// Turno por día de la semana: índice de getDay() (0=domingo ... 6=sábado)
const DIAS_TURNO = [[1, 'Lunes'], [2, 'Martes'], [3, 'Miércoles'], [4, 'Jueves'], [5, 'Viernes'], [6, 'Sábado'], [0, 'Domingo']];
// El mismo cálculo que hace el servidor (el servidor manda de todas formas).
// Con la fecha vacía el servidor usa la de hoy: aquí igual, para que el total
// que se muestra en pantalla nunca difiera del que se registra.
function fechaTurnoValida(fecha) {
  return /^\d{4}-\d{2}-\d{2}$/.test(fecha || '') ? fecha : new Date().toLocaleDateString('sv-SE');
}
function valorTurnoCliente(emp, fecha) {
  if (emp.turnos) {
    const dia = new Date(fechaTurnoValida(fecha) + 'T12:00:00').getDay();
    if (emp.turnos[dia] > 0) return emp.turnos[dia];
  }
  return emp.valor_turno || 0;
}

// Recargo por pago con tarjeta (el servidor recalcula; esto es solo para mostrar)
function recargoTarjetaCliente(monto) {
  const c = state.config || {};
  if (!monto) return 0;
  return monto < (c.recargo_tarjeta_umbral || 0)
    ? (c.recargo_tarjeta_fijo || 0)
    : Math.round(monto * (c.recargo_tarjeta_pct || 0) / 100);
}

const state = {
  token: localStorage.getItem('pos_token') || null,
  usuario: null,
  platos: [], pedidos: [], impresion: { trabajos: [] }, config: {},
  jornada: null, jornadaCerrada: false,
  vista: 'tomar',
  // toma de pedido: 3 pantallas (entrada→proteína→extras); cada toque agrega 1 unidad
  sel: { entrada: [], proteina: [], bebida: [], extra: [], solo: [] }, uidSeq: 1,
  notas: {},                                // uid de proteína -> {chips, custom} (nota del almuerzo)
  notaExtras: { chips: [], custom: '' },    // nota del bloque de extras sueltos
  pantalla: 'entrada', itemAbierto: null, ticketAbierto: false, busqueda: '', busquedaMenu: '',
  gruposAbiertos: {},                       // tipos de plato desplegados en el Menú
  comensal: '', tipoEntrega: 'mesa', editandoId: null,
  valorDomicilio: '', imprimirExtras: false,
  enviandoPedido: false, pagoMetodo: null, pagoRecibido: '',
  uuidsPropios: new Set(), nominaPendientes: [],
  cobrandoId: null, cobroMetodo: 'efectivo', cobroRecibido: '',
  // estación de impresión
  estacion: { activa: false, via: 'rawbt', bleChar: null, bleNombre: '', log: [] },
  pinBuffer: ''
};

let socket = null;

// ---------------- Utilidades ----------------
function toast(msg, esError) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'visible' + (esError ? ' error' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, 3000);
}

async function api(ruta, opciones = {}) {
  const res = await fetch('/api' + ruta, {
    method: opciones.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
    body: opciones.body ? JSON.stringify(opciones.body) : undefined
  });
  const datos = await res.json().catch(() => ({}));
  if (res.status === 401) { cerrarSesionLocal(); throw new Error(datos.error || 'Sesión vencida'); }
  if (!res.ok) throw new Error(datos.error || `Error ${res.status}`);
  return datos;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// crypto.randomUUID solo existe en contextos seguros (https o localhost);
// desde los teléfonos la app corre en http://IP:3000, así que hay que tener respaldo.
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Ningún error debe morir en silencio: mejor un aviso feo que un botón que "no hace nada"
window.addEventListener('error', (e) => toast('Error: ' + (e.message || 'desconocido'), true));
window.addEventListener('unhandledrejection', (e) => {
  toast('Error: ' + ((e.reason && e.reason.message) || e.reason || 'desconocido'), true);
});

// ---------------- Dirección de red y QR de conexión ----------------
function dibujarQR(elemento, texto) {
  try {
    const qr = qrcode(0, 'M');
    qr.addData(texto);
    qr.make();
    elemento.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2 });
  } catch { elemento.textContent = texto; }
}

async function mostrarRed() {
  let red;
  try { red = await (await fetch('/api/red')).json(); }
  catch { return toast('No se pudo consultar la dirección del servidor', true); }
  const viejo = $('#overlay-red');
  if (viejo) viejo.remove();
  const div = document.createElement('div');
  div.id = 'overlay-red';
  div.innerHTML = `
    <div class="red-caja">
      <h2 style="margin-bottom:4px">📶 Conectar teléfonos</h2>
      <div class="suave">Escanee el código o escriba la dirección en el navegador del teléfono (misma red WiFi):</div>
      <div class="red-qr" id="red-qr"></div>
      <div class="red-url">${esc(red.url)}</div>
      ${red.candidatas.length > 1 ? `<div class="suave" style="margin-top:8px">Si no abre, pruebe:<br>
        ${red.candidatas.slice(1).map(c => `${esc(c.url)} <em>(${esc(c.red)})</em>`).join('<br>')}</div>` : ''}
      <div class="suave" id="red-diagnostico" style="margin-top:10px;text-align:left">🔎 Revisando internet...</div>
      <div class="suave" style="margin-top:8px;text-align:left">💡 Si el hotspot se apagó y se prendió, la dirección pudo
        cambiar: vuelvan a escanear este QR (se actualiza solo). La app local funciona aunque no haya internet.</div>
      <button class="btn gris" id="btn-cerrar-red" style="margin-top:14px">Cerrar</button>
    </div>`;
  document.body.appendChild(div);
  dibujarQR($('#red-qr'), red.url);
  $('#btn-cerrar-red').onclick = () => div.remove();
  div.onclick = (e) => { if (e.target === div) div.remove(); };
  // Diagnóstico aparte (tarda unos segundos si no hay internet)
  fetch('/api/red?diagnostico=1').then(r => r.json()).then(d => {
    const el = $('#red-diagnostico');
    if (!el) return;
    const colas = (d.sheets_pendientes || 0) + (d.correos_pendientes || 0);
    el.innerHTML = d.internet
      ? '🌐 Internet del PC: <b style="color:var(--ok)">funcionando</b>' +
        (colas ? ` · ${colas} envío(s) pendiente(s) saliendo` : '')
      : '🌐 Internet del PC: <b style="color:var(--peligro)">sin salida</b> — Google Sheets y el correo quedan en cola' +
        (colas ? ` (${colas} pendiente(s))` : '') + ' y se envían solos cuando vuelva. Las ventas NO se pierden.';
  }).catch(() => {});
}

const ES_PC_SERVIDOR = ['localhost', '127.0.0.1'].includes(location.hostname);

// El QR de la pantalla de login se refresca solo: cuando el hotspot se apaga y
// se prende, el teléfono le entrega OTRA dirección al PC y un QR viejo deja a
// todos los meseros "sin poder conectar" aunque el POS esté funcionando.
let qrLoginTimer = null;
function pintarQRLogin() {
  fetch('/api/red').then(r => r.json()).then(red => {
    const cont = $('#login-redes');
    if (!cont) return; // la vista pudo cambiar
    // El PC puede estar en varias redes (cable + hotspot): se muestran TODAS,
    // porque si se muestra una sola y es la equivocada, nadie puede conectarse.
    const otras = (red.candidatas || []).filter(c => c.url !== red.url);
    const firma = red.url + '|' + otras.map(c => c.url).join(',');
    if (cont.dataset.firma === firma) return; // sin cambios: no redibujar
    cont.dataset.firma = firma;
    cont.innerHTML = `
      <div class="suave">📶 Conectar teléfonos — escanee:</div>
      <div class="red-qr" id="login-qr"></div>
      <div class="red-url">${esc(red.url)}</div>
      ${otras.length ? `<div class="suave" style="margin-top:10px">Si ese no abre, este PC también está en otra red:</div>
        <div class="login-otras">${otras.map((c, i) => `
          <div class="login-otra">
            <div class="red-qr chico" id="login-qr-${i}"></div>
            <div class="red-url chico">${esc(c.url)}</div>
            <div class="suave">${esc(c.red)}</div>
          </div>`).join('')}</div>` : ''}`;
    dibujarQR($('#login-qr'), red.url);
    otras.forEach((c, i) => { const el = $('#login-qr-' + i); if (el) dibujarQR(el, c.url); });
  }).catch(() => {});
}

// ---------------- Login ----------------
function renderLogin(mensajeError) {
  $('#cabecera').classList.add('oculto');
  $('#tabs').classList.add('oculto');
  $('#vista').innerHTML = `
    <div id="login">
      <h1>🍽️ ${esc(state.config.nombre_restaurante || 'POS Restaurante')}</h1>
      <div class="suave">Ingrese su PIN de 4 dígitos</div>
      <div id="pin-puntos">${[0,1,2,3].map(i => `<span class="${i < state.pinBuffer.length ? 'lleno' : ''}"></span>`).join('')}</div>
      <div id="pin-teclado">
        ${[1,2,3,4,5,6,7,8,9].map(n => `<button data-n="${n}">${n}</button>`).join('')}
        <button data-accion="borrar">⌫</button>
        <button data-n="0">0</button>
        <button data-accion="limpiar">C</button>
      </div>
      <div class="error-login">${esc(mensajeError || '')}</div>
      ${ES_PC_SERVIDOR ? '<div class="tarjeta" style="text-align:center" id="login-redes"></div>' : ''}
    </div>`;
  if (ES_PC_SERVIDOR) {
    pintarQRLogin();
    clearInterval(qrLoginTimer); // renderLogin corre en cada dígito del PIN: un solo timer
    qrLoginTimer = setInterval(() => {
      if (!$('#login-redes')) { clearInterval(qrLoginTimer); return; } // ya no es la vista de login
      pintarQRLogin();
    }, 20000);
  }
  $('#pin-teclado').onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.accion === 'borrar') state.pinBuffer = state.pinBuffer.slice(0, -1);
    else if (b.dataset.accion === 'limpiar') state.pinBuffer = '';
    else if (state.pinBuffer.length < 4) state.pinBuffer += b.dataset.n;
    if (state.pinBuffer.length === 4) {
      const pin = state.pinBuffer;
      state.pinBuffer = '';
      await intentarLogin(pin);
    } else renderLogin();
  };
}

async function intentarLogin(pin) {
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin })
    });
    const datos = await res.json();
    if (!res.ok) return renderLogin(datos.error || 'PIN incorrecto');
    state.token = datos.token;
    localStorage.setItem('pos_token', datos.token);
    await iniciarApp();
  } catch {
    renderLogin('No hay conexión con el servidor');
  }
}

function cerrarSesionLocal() {
  state.token = null; state.usuario = null;
  localStorage.removeItem('pos_token');
  if (socket) { socket.disconnect(); socket = null; }
  renderLogin();
}

// ---------------- Arranque tras login ----------------
async function iniciarApp() {
  let estado;
  try { estado = await api('/estado'); }
  catch (e) { return renderLogin(e.message); }
  state.usuario = estado.usuario;
  state.platos = estado.platos;
  state.pedidos = estado.pedidos;
  state.impresion = estado.impresion;
  state.config = estado.configPublica;
  state.jornada = estado.jornada;
  state.jornadaCerrada = estado.jornadaCerrada;
  state.sheets = estado.sheets || null;

  $('#cabecera').classList.remove('oculto');
  $('#titulo-app').textContent = `👤 ${state.usuario.nombre}`;
  $('#usuario-activo').textContent = '';
  $('#btn-salir').onclick = async () => {
    try { await api('/logout', { method: 'POST' }); } catch {}
    cerrarSesionLocal();
  };
  $('#btn-red').onclick = mostrarRed;

  conectarSocket();
  renderTabs();
  cambiarVista(state.vista);
  state.nominaPendientes = estado.nominaPendienteMia || [];
  mostrarConfirmacionNomina();
}

// Modal para que el empleado confirme desde SU teléfono el pago de nómina
function mostrarConfirmacionNomina() {
  if (document.querySelector('#overlay-nomina')) return;
  const n = state.nominaPendientes[0];
  if (!n) return;
  const div = document.createElement('div');
  div.id = 'overlay-nomina';
  div.innerHTML = `
    <div class="red-caja">
      <h2>💰 Pago de nómina</h2>
      ${n.turnos && n.turnos.length ? `
      <div class="suave" style="margin:6px 0">Le están pagando ${n.turnos.length} turno(s):</div>
      ${n.turnos.map(t => `<div class="fila suave"><span>${esc(fechaCorta(t.jornada))} · ${esc(t.cargo)}</span><span class="der">${fmt(t.valor)}</span></div>`).join('')}
      <div class="fila suave" style="border-top:1px dashed var(--borde);margin-top:4px;padding-top:4px"><span>Suma de turnos</span><span class="der">${fmt(n.valor_turno)}</span></div>`
      : `<div class="suave" style="margin:6px 0">Fecha del turno: ${esc(n.jornada)}</div>
      <div class="fila suave"><span>Turno</span><span class="der">${fmt(n.valor_turno)}</span></div>`}
      ${n.descuento ? `<div class="fila suave"><span>Descuento</span><span class="der">-${fmt(n.descuento)}</span></div>` : ''}
      ${n.bono ? `<div class="fila suave"><span>Bono</span><span class="der">+${fmt(n.bono)}</span></div>` : ''}
      ${n.concepto ? `<div class="suave" style="margin:4px 0">📝 ${esc(n.concepto)}</div>` : ''}
      <div class="fila grande" style="margin:8px 0"><span>TOTAL</span><span class="der">${fmt(n.total)}</span></div>
      <button class="btn ok" id="btn-nomina-confirmar">✓ Confirmo que recibí este pago</button>
      <button class="enlace-suave" id="btn-nomina-despues">Después</button>
    </div>`;
  document.body.appendChild(div);
  $('#btn-nomina-confirmar').onclick = async () => {
    try {
      await api(`/nomina/${n.id}/confirmar`, { method: 'POST' });
      beep(990, 0.12); vibrar(80);
      toast('Pago confirmado; sale el ticket de nómina');
      state.nominaPendientes.shift();
      div.remove();
      mostrarConfirmacionNomina();
    } catch (e) { toast(e.message, true); }
  };
  $('#btn-nomina-despues').onclick = () => { state.nominaPendientes.shift(); div.remove(); mostrarConfirmacionNomina(); };
}

function conectarSocket() {
  if (socket) socket.disconnect();
  socket = io({ auth: { token: state.token } });
  socket.on('menu:actualizado', (platos) => { state.platos = platos; refrescarVistaEnVivo(['tomar', 'menu']); });
  // La pantalla de toma de pedido no muestra comandas ajenas: redibujarla en
  // cada venta de otro mesero solo estorbaba (perdía el buscador y el scroll)
  socket.on('pedidos:actualizado', (pedidos) => { state.pedidos = pedidos; refrescarVistaEnVivo(['historial', 'caja']); });
  socket.on('menu:config', (cfg) => {
    Object.assign(state.config, cfg);
    refrescarVistaEnVivo(['menu', 'tomar']);
  });
  socket.on('impresion:estado', (imp) => { state.impresion = imp; renderBanner(); refrescarVistaEnVivo(['impresora', 'admin']); });
  socket.on('jornada:cerrada', () => { state.jornadaCerrada = true; renderBanner(); refrescarVistaEnVivo(); });
  socket.on('jornada:reabierta', () => { state.jornadaCerrada = false; renderBanner(); refrescarVistaEnVivo(); });
  socket.on('pedido:guardado', (d) => {
    // El PC recibió y guardó un pedido: avisar en todos los teléfonos
    // (excepto en el que lo creó, que ya ve su propia confirmación)
    if (d.uuid && state.uuidsPropios.has(d.uuid)) return;
    beep(700, 0.1); vibrar(50);
    toast(`🔔 Comanda ${String(d.numero_comanda).padStart(3, '0')} guardada — ${d.comensal} (${d.vendedor})`);
  });
  socket.on('chips:actualizados', (chips) => { state.config.chips_notas = chips; refrescarVistaEnVivo(['tomar', 'menu']); });
  socket.on('caja:actualizada', () => refrescarVistaEnVivo(['caja']));
  socket.on('nomina:actualizada', () => {
    // En la pantalla de nómina se recargan los datos sin tumbar lo que se esté escribiendo
    if (state.vista === 'caja' && state.enNomina) {
      const activo = document.activeElement;
      if (activo && /^(INPUT|SELECT|TEXTAREA)$/.test(activo.tagName) && activo.type !== 'checkbox') return;
      return cargarNominaDatos();
    }
    refrescarVistaEnVivo(['caja']);
  });
  socket.on('nomina:pendiente', (n) => { state.nominaPendientes.push(n); mostrarConfirmacionNomina(); });
  socket.on('sheets:estado', (estado) => { state.sheets = estado; renderBanner(); });
  socket.on('trabajo:imprimir', manejarTrabajoImpresion);
  socket.on('connect', renderBanner);
  socket.on('disconnect', renderBanner);
}

function refrescarVistaEnVivo(soloVistas) {
  if (soloVistas && !soloVistas.includes(state.vista)) return;
  // Con el editor de turnos abierto, cada comanda que entra disparaba un
  // redibujado de Admin que borraba lo que el administrador venía escribiendo
  if (state.vista === 'admin' && state.turnosAbiertoId) return;
  // Ídem mientras el admin escribe en cualquier campo de Admin (roles, correo...)
  if (state.vista === 'admin') {
    const activo = document.activeElement;
    if (activo && $('#vista').contains(activo) && /^(INPUT|SELECT|TEXTAREA)$/.test(activo.tagName)) return;
  }
  // Lo mismo en Rectificar: la cajera está escribiendo totales contra el
  // extracto y cada venta de un mesero le cerraba el teclado y le borraba el
  // filtro de fecha. Esa pantalla se refresca sola con sus propios botones.
  if (state.vista === 'caja' && state.enRectificar) return;
  // La pantalla de nómina se refresca con sus propios datos (ver socket nomina:actualizada)
  if (state.vista === 'caja' && state.enNomina) return;
  if (['historial', 'caja', 'menu', 'impresora', 'admin', 'tomar'].includes(state.vista)) renderVista();
}

// ---------------- Navegación ----------------
function tabsDisponibles() {
  const tabs = [
    { id: 'tomar', nombre: 'Pedido', ic: '📝' },
    { id: 'historial', nombre: 'Historial', ic: '📜' },
  ];
  if (state.usuario.rol !== 'mesero') tabs.push({ id: 'caja', nombre: 'Caja', ic: '💰' });
  tabs.push({ id: 'menu', nombre: 'Menú', ic: '🍲' });
  tabs.push({ id: 'impresora', nombre: 'Impresora', ic: '🖨️' });
  if (state.usuario.rol === 'admin') tabs.push({ id: 'admin', nombre: 'Admin', ic: '⚙️' });
  return tabs;
}

function renderTabs() {
  const tabs = tabsDisponibles();
  const nav = $('#tabs');
  nav.classList.remove('oculto');
  nav.innerHTML = tabs.map(t =>
    `<button data-vista="${t.id}" class="${state.vista === t.id ? 'activo' : ''}"><span class="ic">${t.ic}</span>${t.nombre}</button>`
  ).join('');
  nav.onclick = (e) => {
    const b = e.target.closest('button');
    if (b) cambiarVista(b.dataset.vista);
  };
}

function cambiarVista(vista) {
  state.vista = vista;
  state.enRectificar = false;
  state.enNomina = false;
  renderTabs();
  renderBanner();
  renderVista();
}

function renderBanner() {
  const avisos = [];
  if (socket && !socket.connected) avisos.push(['rojo', 'Sin conexión con el servidor. Reintentando...']);
  if (state.impresion && state.impresion.modo === 'puente' && !state.impresion.puenteConectado) {
    avisos.push(['rojo', '🖨️ Impresora sin conexión: ningún teléfono tiene activa la Estación de impresión']);
  }
  const errores = (state.impresion.trabajos || []).filter(t => t.estado === 'error').length;
  if (errores) avisos.push(['amarillo', `⚠️ ${errores} comanda(s) con error de impresión (ver pestaña Impresora)`]);
  if (state.jornadaCerrada) avisos.push(['amarillo', 'Jornada con cierre de caja: solo consulta']);
  // Excel en tiempo real: solo si está activado, y solo lo ven caja y admin.
  // Apagado no aparece nada (el detector de fallos ya no sale en la terminal).
  const s = state.sheets;
  if (s && s.activo && state.usuario && ['admin', 'cajero'].includes(state.usuario.rol)) {
    const hora = (t) => String(t || '').slice(11, 16);
    const fallo = s.ultimoError && (!s.ultimoOk || s.ultimoError.slice(0, 19) > s.ultimoOk.slice(0, 19));
    const detalle = String(s.ultimoError || '').split(' — ').slice(1).join(' — ');
    if (fallo) {
      avisos.push(['amarillo chico', `📊 Excel en tiempo real: ${s.pendientes ? `${s.pendientes} venta(s) en espera` : 'el último envío falló'} · ${esc(detalle)} · se reintenta solo${s.proximoIntento ? ` a las ${s.proximoIntento}` : ''}. No se pierde ninguna venta.`]);
    } else if (s.pendientes > 0) {
      avisos.push(['verde chico', `📊 Excel en tiempo real: enviando ${s.pendientes} venta(s)...`]);
    } else {
      avisos.push(['verde chico', `📊 Excel en tiempo real al día${s.ultimoOk ? ` · última venta subida ${hora(s.ultimoOk)}` : ''}`]);
    }
  }
  $('#banner').innerHTML = avisos.map(([c, m]) => `<div class="aviso ${c}">${m}</div>`).join('');
}

function renderVista() {
  const v = state.vista;
  if (v === 'tomar') return renderTomar();
  if (v === 'historial') return renderHistorial();
  if (v === 'caja') return renderCaja();
  if (v === 'menu') return renderMenu();
  if (v === 'impresora') return renderImpresora();
  if (v === 'admin') return renderAdmin();
}

// ---------------- Toma de pedidos: 3 pantallas + ticket por almuerzos ----------------
// Flujo: 1.Entradas -> 2.Proteinas -> 3.Extras -> Ticket.
// Tocar un plato N veces = N almuerzos. La entrada i se empareja con la proteina i
// y el extra i; los extras que sobren van en su propio bloque al final.

function claveListaDeTipo(tipo) {
  if (tipo === 'entrada') return 'entrada';
  if (tipo === 'bebida') return 'bebida';
  if (tipo === 'extra') return 'extra';
  return 'proteina';
}

function platoDe(id) { return state.platos.find(p => p.id === id); }

function totalCarrito() {
  let total = 0;
  for (const [listaKey, lista] of Object.entries(state.sel)) {
    for (const it of lista) {
      const p = platoDe(it.platoId);
      if (p) total += listaKey === 'solo' ? (p.precio_solo || 0) : p.precio;
    }
  }
  if (state.tipoEntrega === 'llevar') total += recargoDomicilioActual();
  return total;
}

function recargoDomicilioActual() {
  if (state.tipoEntrega !== 'llevar') return 0;
  const v = String(state.valorDomicilio).trim();
  return v === '' ? Number(state.config.recargo_empaque || 0) : Math.max(0, Math.round(Number(v) || 0));
}

// Una proteína del día o un especial vendidos SOLOS (sin entrada) también
// llevan la bebida incluida: cuentan para el cupo de jugos del ticket.
function solosConBebida() {
  return state.sel.solo.filter(it => {
    const p = platoDe(it.platoId);
    return p && (p.tipo === 'proteina_dia' || p.tipo === 'proteina_especial');
  }).length;
}

// Regla acordada: el ticket solo se habilita con SOLO extras/sueltos, o con
// almuerzos completos (misma cantidad de entradas y proteinas).
function estadoTicket() {
  const nE = state.sel.entrada.length, nP = state.sel.proteina.length,
        nB = state.sel.bebida.length, nX = state.sel.extra.length, nS = state.sel.solo.length;
  const cupoBebidas = nE + solosConBebida();
  if (!nE && !nP && !nB && !nX && !nS) return { ok: false, motivo: 'Toque los platos para armar el pedido' };
  if (!nE && !nP) {
    if (nB > cupoBebidas) {
      return { ok: false, motivo: cupoBebidas
        ? `Hay ${nB} bebida(s) para ${cupoBebidas} plato(s) del día vendido(s) solo(s)`
        : 'La bebida va incluida con un almuerzo o con un plato del día vendido solo' };
    }
    return { ok: true, modo: 'extras' };
  }
  if (nE !== nP) return { ok: false, motivo: `Almuerzos incompletos: ${nE} entrada(s) y ${nP} proteína(s)` };
  if (nB > cupoBebidas) return { ok: false, motivo: `Hay ${nB} bebida(s) incluida(s) para ${cupoBebidas} almuerzo(s) o plato(s) solo(s)` };
  return { ok: true, modo: 'almuerzos' };
}

function derivarBloques() {
  const n = Math.min(state.sel.entrada.length, state.sel.proteina.length);
  const bloques = [];
  for (let i = 0; i < n; i++) {
    const items = [state.sel.entrada[i], state.sel.proteina[i]];
    if (state.sel.bebida[i]) items.push(state.sel.bebida[i]);
    if (state.sel.extra[i]) items.push(state.sel.extra[i]);
    bloques.push({ items, proteinaUid: state.sel.proteina[i].uid });
  }
  // Lo que no cupo en un almuerzo completo: los platos del día vendidos solos,
  // las bebidas que van con ellos y los extras sueltos.
  const sobrantes = [
    ...state.sel.solo.map(it => ({ ...it, esSolo: true })),
    ...state.sel.bebida.slice(n).map(it => ({ ...it, esSolo: false })),
    ...state.sel.extra.slice(n).map(it => ({ ...it, esSolo: false }))
  ];
  return { bloques, sobrantes };
}

function componerNota(n) {
  if (!n) return '';
  const chips = (n.chips || []).join(', ');
  const custom = (n.custom || '').trim();
  if (!chips && !custom) return '';
  return custom ? chips + '\n' + custom : chips;
}

function parsearNota(nota) {
  if (!nota) return { chips: [], custom: '' };
  const i = nota.indexOf('\n');
  const parteChips = i < 0 ? nota : nota.slice(0, i);
  const custom = i < 0 ? '' : nota.slice(i + 1);
  const partes = parteChips.split(', ').map(s => s.trim()).filter(Boolean);
  const chips = partes.filter(p => chipsNotas().includes(p));
  const resto = partes.filter(p => !chipsNotas().includes(p));
  return { chips, custom: [...resto, custom.trim()].filter(Boolean).join(', ') };
}

function vibrar(patron) { if (navigator.vibrate) navigator.vibrate(patron || 60); }

function beep(frec, dur) {
  try {
    const ctx = beep._ctx || (beep._ctx = new (window.AudioContext || window.webkitAudioContext)());
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = frec || 880;
    g.gain.setValueAtTime(0.12, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (dur || 0.15));
    o.start(); o.stop(ctx.currentTime + (dur || 0.15) + 0.01);
  } catch {}
}

const PANTALLAS = {
  entrada: { paso: '1', titulo: 'Entradas', secciones: [['entrada', null, 'entrada']] },
  proteina: { paso: '2', titulo: 'Proteínas', secciones: [['proteina_dia', 'Del día', 'proteina'], ['proteina_especial', 'Especiales', 'proteina']] },
  extras: {
    paso: '3', titulo: 'Bebida y extras', secciones: [
      ['bebida', 'Bebida incluida (del almuerzo)', 'bebida'],
      ['solo', '🍛 Del día, vendidos SOLOS', 'solo'],
      ['extra', 'Extras (se cobran aparte)', 'extra']
    ]
  }
};

// Platos de cada sección: 'solo' es virtual (los del día con precio_solo configurado)
function platosDeSeccion(tipo) {
  if (tipo === 'solo') {
    return state.platos.filter(p => p.disponible && p.precio_solo > 0 && p.tipo !== 'extra');
  }
  return state.platos.filter(p => p.tipo === tipo && p.disponible);
}

// Búsqueda tolerante a tildes y mayúsculas: con 150 proteínas en el menú,
// desplazarse hasta el plato es más lento que escribir dos letras.
function normalizar(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function filaPlato(p, listaKey) {
  const enSel = state.sel[listaKey].filter(it => it.platoId === p.id).length;
  const precio = listaKey === 'solo' ? p.precio_solo : p.precio;
  return `
    <div class="pr-wrap" data-wrap="${listaKey}-${p.id}">
      <button class="plato-row ${enSel ? 'en-orden' : ''}" data-plato="${p.id}" data-lista="${listaKey}">
        <span class="pr-nombre">${esc(p.nombre)}</span>
        <span class="pr-precio">${precio ? fmt(precio) : ''}</span>
        <span class="pb-badge" ${enSel ? '' : 'hidden'}>${enSel}</span>
      </button>
      <button class="pr-menos" ${enSel ? '' : 'hidden'} data-menos-plato="${p.id}" data-lista="${listaKey}">−</button>
    </div>`;
}

// Solo se redibuja la lista de platos (no la pantalla entera): así el buscador
// no pierde el cursor y con 300 platos se siente instantáneo.
function pintarListas() {
  const cont = $('#listas-platos');
  if (!cont) return;
  const q = normalizar(state.busqueda);
  let html = '';
  for (const [tipo, subtitulo, listaKey] of PANTALLAS[state.pantalla].secciones) {
    let platos = platosDeSeccion(tipo);
    if (q) platos = platos.filter(p => normalizar(p.nombre).includes(q) || normalizar(p.acronimo).includes(q));
    if (!platos.length) continue;
    html += `${subtitulo ? `<div class="cat-titulo">${esc(subtitulo)}</div>` : ''}
      <div class="lista-platos">${platos.map(p => filaPlato(p, listaKey)).join('')}</div>`;
  }
  cont.innerHTML = html || `<div class="tarjeta suave">Ningún plato coincide con "${esc(state.busqueda)}"</div>`;
}

// Actualiza SOLO la fila tocada y los contadores, sin volver a dibujar la lista
function actualizarFilaPlato(platoId, listaKey) {
  const wrap = document.querySelector(`[data-wrap="${listaKey}-${platoId}"]`);
  if (!wrap) return;
  const n = state.sel[listaKey].filter(it => it.platoId === platoId).length;
  const badge = wrap.querySelector('.pb-badge');
  const menos = wrap.querySelector('.pr-menos');
  const fila = wrap.querySelector('.plato-row');
  if (badge) { badge.textContent = n; badge.hidden = !n; }
  if (menos) menos.hidden = !n;
  if (fila) fila.classList.toggle('en-orden', !!n);
}

function actualizarBarraPedido() {
  const resumen = $('#resumen-sel');
  if (resumen) {
    resumen.textContent = `🥣${state.sel.entrada.length} · 🍗${state.sel.proteina.length} · ` +
      `🥤${state.sel.bebida.length} · 🧃${state.sel.extra.length + state.sel.solo.length}`;
  }
  const btn = $('#btn-ver-ticket');
  if (btn) {
    btn.classList.toggle('nav-bloqueado', !estadoTicket().ok);
    btn.textContent = `🧾 TICKET · ${fmt(totalCarrito())}`;
  }
}

function renderTomar() {
  if (state.ticketAbierto) return renderTicket();
  const def = PANTALLAS[state.pantalla];
  const est = estadoTicket();
  const nE = state.sel.entrada.length, nP = state.sel.proteina.length,
        nB = state.sel.bebida.length, nXS = state.sel.extra.length + state.sel.solo.length;
  const totalPantalla = def.secciones.reduce((n, [tipo]) => n + platosDeSeccion(tipo).length, 0);

  $('#vista').innerHTML = `
  <div class="pantalla-pedido">
    ${state.editandoId ? `<div class="banda-edicion">✏️ Editando comanda ${esc(String(state.editandoNumero || ''))}
      <button class="btn-mini" id="btn-cancelar-edicion">Descartar</button></div>` : ''}
    <div class="paso-titulo">
      <span class="paso-num">${def.paso}</span> ${def.titulo}
      <span class="der resumen-sel" id="resumen-sel">🥣${nE} · 🍗${nP} · 🥤${nB} · 🧃${nXS}</span>
    </div>
    ${totalPantalla > 12 ? `<input id="buscar-plato" class="input-buscar" type="search"
      placeholder="🔎 Buscar entre ${totalPantalla} platos..." value="${esc(state.busqueda)}"
      autocomplete="off" autocorrect="off" enterkeyhint="search">` : ''}
    <div id="listas-platos"></div>
    <div style="height:8px"></div>
  </div>
  <div class="barra-envio">
    <div class="nav-pantallas">
      ${state.pantalla === 'entrada' ? `
        <button class="btn gris btn-nav" id="btn-solo-extras">🧃 Solo extras</button>
        <button class="btn btn-nav" id="btn-ir-proteina">Proteínas →</button>` : ''}
      ${state.pantalla === 'proteina' ? `
        <button class="btn gris btn-nav" id="btn-ir-entrada">← Entradas</button>
        <button class="btn btn-nav" id="btn-ir-extras">Bebida y extras →</button>` : ''}
      ${state.pantalla === 'extras' ? `
        <button class="btn gris btn-nav" id="btn-volver-proteina">← Anterior</button>
        <button class="btn ok btn-nav ${est.ok ? '' : 'nav-bloqueado'}" id="btn-ver-ticket">
          🧾 TICKET · ${fmt(totalCarrito())}</button>` : ''}
    </div>
  </div>`;

  pintarListas();

  // Un solo manejador para toda la lista (con 300 platos, poner 300 escuchas
  // en cada toque es justo lo que hacía sentir lenta la pantalla)
  $('#listas-platos').onclick = (e) => {
    const menos = e.target.closest('[data-menos-plato]');
    if (menos) {
      const lista = state.sel[menos.dataset.lista];
      const id = Number(menos.dataset.menosPlato);
      for (let i = lista.length - 1; i >= 0; i--) {
        if (lista[i].platoId === id) { delete state.notas[lista[i].uid]; lista.splice(i, 1); break; }
      }
      vibrar(25);
      actualizarFilaPlato(id, menos.dataset.lista);
      actualizarBarraPedido();
      return;
    }
    const b = e.target.closest('[data-plato]');
    if (!b) return;
    const id = Number(b.dataset.plato);
    state.sel[b.dataset.lista].push({ uid: state.uidSeq++, platoId: id });
    vibrar(25);
    actualizarFilaPlato(id, b.dataset.lista);
    actualizarBarraPedido();
  };
  if ($('#buscar-plato')) $('#buscar-plato').oninput = (e) => { state.busqueda = e.target.value; pintarListas(); };
  if ($('#btn-cancelar-edicion')) $('#btn-cancelar-edicion').onclick = () => { limpiarFormulario(); renderTomar(); };
  const ir = (id, pantalla) => {
    if ($(id)) $(id).onclick = () => { state.pantalla = pantalla; state.busqueda = ''; renderTomar(); };
  };
  ir('#btn-solo-extras', 'extras');
  ir('#btn-ir-proteina', 'proteina');
  ir('#btn-ir-entrada', 'entrada');
  ir('#btn-ir-extras', 'extras');
  ir('#btn-volver-proteina', 'proteina');
  if ($('#btn-ver-ticket')) $('#btn-ver-ticket').onclick = () => {
    const e = estadoTicket();
    if (!e.ok) { vibrar([60, 40, 60]); return toast(e.motivo, true); }
    state.ticketAbierto = true;
    renderTomar();
  };
}

// La pantalla del ticket: un bloque por almuerzo (como se imprime en cocina);
// tocar un PLATO abre sus cambios rápidos y observaciones propias.
function renderTicket() {
  const llevar = state.tipoEntrega === 'llevar';
  const est = estadoTicket();
  const { bloques, sobrantes } = derivarBloques();
  const puedeConfirmar = state.editandoId || state.pagoMetodo;
  const recTarjeta = state.pagoMetodo === 'tarjeta' ? recargoTarjetaCliente(totalCarrito()) : 0;

  const notaDe = (uid) => {
    if (!state.notas[uid]) state.notas[uid] = { chips: [], custom: '' };
    return state.notas[uid];
  };

  const filaItem = (it) => {
    const p = platoDe(it.platoId);
    const nota = notaDe(it.uid);
    const abierto = state.itemAbierto === it.uid;
    const notaTxt = [(nota.chips || []).join(', '), (nota.custom || '').trim()].filter(Boolean).join(' · ');
    const precioItem = it.esSolo ? (p ? p.precio_solo : 0) : (p ? p.precio : 0);
    return `
    <div class="lt-item ${abierto ? 'abierta' : ''}">
      <div class="lt-item-fila">
        <button class="lt-item-btn" data-item="${it.uid}">
          <span class="lt-item-nombre">${esc(p ? p.nombre.toUpperCase() : '?')}${it.esSolo ? ' <span class="chip">SOLO</span>' : ''}</span>
          ${notaTxt ? `<span class="lt-nota">${esc(notaTxt)}</span>` : ''}
          <span class="lt-flecha">${abierto ? '▲' : '▼'}</span>
        </button>
        <span class="lt-precio">${precioItem ? fmt(precioItem) : ''}</span>
        <button class="btn-mini peligro lt-x" data-quitar-uid="${it.uid}">✕</button>
      </div>
      ${abierto ? `
      <div class="lt-detalle">
        <div class="chips">
          ${chipsNotas().map(ch => `<button class="chip-nota ${nota.chips.includes(ch) ? 'sel' : ''}"
            data-chip="${esc(ch)}" data-chip-uid="${it.uid}">${esc(ch)}</button>`).join('')}
        </div>
        <input class="nota-inline" data-obs-uid="${it.uid}" placeholder="Observaciones (ej: mas arroz en vez de platano)"
          value="${esc(nota.custom || '')}" autocomplete="off">
      </div>` : ''}
    </div>`;
  };

  const cardBloque = (titulo, items) => `
    <div class="linea-ticket">
      <div class="lt-cab">${esc(titulo)}</div>
      ${items.map(filaItem).join('')}
    </div>`;

  $('#vista').innerHTML = `
  <div class="pantalla-pedido">
    <div class="ticket-cab">
      <button class="btn-mini" id="btn-volver">← Volver</button>
      <h2 style="margin:0">🧾 Ticket${state.editandoId ? ` · editando ${esc(String(state.editandoNumero || ''))}` : ''}</h2>
    </div>

    <div class="lineas-ticket">
      ${bloques.map((b, i) => cardBloque(`Almuerzo ${i + 1}`, b.items)).join('')}
      ${sobrantes.length ? cardBloque('Sueltos y extras', sobrantes) : ''}
    </div>

    <div class="top-pedido" style="margin-top:10px">
      <input id="in-comensal" class="input-nombre" placeholder="Nombre del cliente"
        value="${esc(state.comensal)}" autocomplete="off" autocapitalize="words" enterkeyhint="done">
      <button id="btn-llevar" class="switch-llevar ${llevar ? 'on' : ''}" aria-pressed="${llevar}">
        <span class="sw-track"><span class="sw-thumb"></span></span>
        <span class="sw-texto">🛵 Domicilio</span>
      </button>
    </div>

    ${llevar ? `<input id="in-domicilio" class="nota-inline" type="text" inputmode="numeric" pattern="[0-9]*"
      placeholder="Valor del domicilio (vacío = ${fmt(Number(state.config.recargo_empaque || 0))})"
      value="${esc(state.valorDomicilio)}" style="margin-top:8px">` : ''}

    <div class="tarjeta" style="margin-top:10px">
      ${llevar ? `<div class="fila suave"><span>🛵 Domicilio</span><span class="der" id="linea-dom">${fmt(recargoDomicilioActual())}</span></div>` : ''}
      <div class="fila grande" style="font-size:18px"><span>Total</span><span class="der" id="total-ticket">${fmt(totalCarrito())}</span></div>
      ${recTarjeta ? `<div class="fila suave" style="color:var(--alerta)"><span>Recargo tarjeta</span><span class="der">+${fmt(recTarjeta)} → ${fmt(totalCarrito() + recTarjeta)}</span></div>` : ''}
    </div>

    ${!state.editandoId && est.modo === 'extras' ? `
    <button id="btn-imprimir-extras" class="btn-mini ${state.imprimirExtras ? 'primario' : ''}" style="margin-top:10px;width:100%">
      ${state.imprimirExtras ? '🖨 Se imprimirá comanda en cocina' : '🔕 Sin comanda en cocina (solo registrar la venta)'}</button>` : ''}

    ${!state.editandoId ? `
    <div class="cat-titulo">Forma de pago</div>
    <div class="pago-grid">
      ${METODOS_COBRO.map(([k, nombre]) =>
        `<button class="pago-btn ${state.pagoMetodo === k ? 'sel' : ''}" data-pago="${k}">${nombre}</button>`).join('')}
    </div>
    ${state.pagoMetodo === 'efectivo' ? `
      <input id="in-recibido" class="input-nombre" type="text" inputmode="numeric" pattern="[0-9]*"
        placeholder="¿Recibido? (vacío = pago exacto)" value="${esc(state.pagoRecibido)}" style="margin-top:8px;width:100%">
      <div id="aviso-vueltas" class="aviso-vueltas"></div>` : ''}
    ` : ''}
    <div style="height:8px"></div>
  </div>

  <div class="barra-envio">
    <button id="btn-confirmar" class="btn-enviar ${puedeConfirmar ? '' : 'vacio'} ${state.enviandoPedido ? 'enviando' : ''}">
      <span>${state.enviandoPedido ? 'ENVIANDO...' : (state.editandoId ? 'GUARDAR Y REIMPRIMIR' : 'CONFIRMAR PEDIDO')}</span>
      <span class="be-total">
        ${llevar ? '<span class="badge-llevar">DOMICILIO</span>' : ''}
        <span id="total-boton">${fmt(totalCarrito() + recTarjeta)}</span>
      </span>
    </button>
    ${!state.editandoId ? `<button id="btn-pagar-despues" class="enlace-suave">Enviar sin pago (cobrar en caja después)</button>` : ''}
  </div>`;

  // --- Eventos ---
  $('#btn-volver').onclick = () => { state.ticketAbierto = false; state.itemAbierto = null; renderTomar(); };
  $('#in-comensal').oninput = (e) => { state.comensal = e.target.value; };
  $('#btn-llevar').onclick = () => { state.tipoEntrega = llevar ? 'mesa' : 'llevar'; vibrar(30); renderTicket(); };
  // El valor del domicilio actualiza los totales EN SU SITIO (re-dibujar rompe el cursor)
  if ($('#in-domicilio')) $('#in-domicilio').oninput = (e) => {
    state.valorDomicilio = e.target.value.replace(/[^0-9]/g, '');
    if (e.target.value !== state.valorDomicilio) e.target.value = state.valorDomicilio;
    const rt = state.pagoMetodo === 'tarjeta' ? recargoTarjetaCliente(totalCarrito()) : 0;
    if ($('#linea-dom')) $('#linea-dom').textContent = fmt(recargoDomicilioActual());
    if ($('#total-ticket')) $('#total-ticket').textContent = fmt(totalCarrito());
    if ($('#total-boton')) $('#total-boton').textContent = fmt(totalCarrito() + rt);
    actualizarVueltasTicket();
  };
  if ($('#btn-imprimir-extras')) $('#btn-imprimir-extras').onclick = () => {
    state.imprimirExtras = !state.imprimirExtras;
    vibrar(25); renderTicket();
  };

  $('#vista').querySelectorAll('[data-item]').forEach(b => b.onclick = () => {
    const uid = Number(b.dataset.item);
    state.itemAbierto = state.itemAbierto === uid ? null : uid;
    vibrar(20); renderTicket();
  });
  $('#vista').querySelectorAll('[data-chip]').forEach(b => b.onclick = () => {
    const nota = notaDe(Number(b.dataset.chipUid));
    const ch = b.dataset.chip;
    const i = nota.chips.indexOf(ch);
    if (i >= 0) nota.chips.splice(i, 1); else nota.chips.push(ch);
    vibrar(25); renderTicket();
  });
  $('#vista').querySelectorAll('[data-obs-uid]').forEach(inp => inp.oninput = () => {
    notaDe(Number(inp.dataset.obsUid)).custom = inp.value;
  });
  $('#vista').querySelectorAll('[data-quitar-uid]').forEach(b => b.onclick = () => {
    const uid = Number(b.dataset.quitarUid);
    for (const lista of Object.values(state.sel)) {
      const i = lista.findIndex(it => it.uid === uid);
      if (i >= 0) { lista.splice(i, 1); break; }
    }
    delete state.notas[uid];
    state.itemAbierto = null;
    vibrar(25);
    const quedan = state.sel.entrada.length + state.sel.proteina.length + state.sel.bebida.length +
                   state.sel.extra.length + state.sel.solo.length;
    if (!quedan) { state.ticketAbierto = false; state.pantalla = 'entrada'; renderTomar(); }
    else if (!estadoTicket().ok) {
      state.ticketAbierto = false; state.pantalla = 'extras';
      toast(estadoTicket().motivo, true);
      renderTomar();
    } else renderTicket();
  });
  $('#vista').querySelectorAll('[data-pago]').forEach(b => b.onclick = () => {
    state.pagoMetodo = state.pagoMetodo === b.dataset.pago ? null : b.dataset.pago;
    vibrar(25); renderTicket();
  });
  // Al escribir el recibido SOLO se actualiza el texto de las vueltas (el cursor se rompe si se re-dibuja)
  if ($('#in-recibido')) $('#in-recibido').oninput = (e) => {
    state.pagoRecibido = e.target.value.replace(/[^0-9]/g, '');
    if (e.target.value !== state.pagoRecibido) e.target.value = state.pagoRecibido;
    actualizarVueltasTicket();
  };
  actualizarVueltasTicket();
  $('#btn-confirmar').onclick = () => {
    if (!state.editandoId && !state.pagoMetodo) {
      vibrar([60, 40, 60]);
      return toast('Elija la forma de pago (o use "Enviar sin pago")', true);
    }
    enviarPedido(!!state.pagoMetodo);
  };
  if ($('#btn-pagar-despues')) $('#btn-pagar-despues').onclick = () => enviarPedido(false);
}

function actualizarVueltasTicket() {
  const div = $('#aviso-vueltas');
  if (!div) return;
  const recibido = Number(state.pagoRecibido || 0);
  if (!recibido) { div.textContent = ''; return; }
  const vueltas = recibido - totalCarrito();
  div.className = vueltas < 0 ? 'aviso-vueltas mal' : 'aviso-vueltas';
  div.textContent = vueltas >= 0 ? `Vueltas: ${fmt(vueltas)}` : 'El monto recibido es menor al total';
}

function limpiarFormulario() {
  state.sel = { entrada: [], proteina: [], bebida: [], extra: [], solo: [] };
  state.notas = {}; state.notaExtras = { chips: [], custom: '' };
  state.pantalla = 'entrada'; state.itemAbierto = null; state.ticketAbierto = false; state.busqueda = '';
  state.comensal = ''; state.tipoEntrega = 'mesa';
  state.editandoId = null; state.editandoNumero = null;
  state.pagoMetodo = null; state.pagoRecibido = '';
  state.valorDomicilio = ''; state.imprimirExtras = false;
}

function tomarBorrador() {
  return {
    sel: {
      entrada: state.sel.entrada.map(x => ({ ...x })),
      proteina: state.sel.proteina.map(x => ({ ...x })),
      bebida: state.sel.bebida.map(x => ({ ...x })),
      extra: state.sel.extra.map(x => ({ ...x })),
      solo: state.sel.solo.map(x => ({ ...x }))
    },
    notas: JSON.parse(JSON.stringify(state.notas)),
    notaExtras: JSON.parse(JSON.stringify(state.notaExtras)),
    comensal: state.comensal, tipoEntrega: state.tipoEntrega,
    pagoMetodo: state.pagoMetodo, pagoRecibido: state.pagoRecibido,
    valorDomicilio: state.valorDomicilio, imprimirExtras: state.imprimirExtras
  };
}

async function enviarPedido(conPago) {
  if (state.enviandoPedido) return;
  if (!state.comensal.trim()) { vibrar([60, 40, 60]); return toast('Falta el nombre del cliente', true); }
  const est = estadoTicket();
  if (!est.ok) { vibrar([60, 40, 60]); return toast(est.motivo, true); }

  // Cada unidad viaja como item individual con su número de almuerzo (bloque)
  const { bloques, sobrantes } = derivarBloques();
  const items = [];
  bloques.forEach((b, i) => {
    for (const it of b.items) {
      items.push({ plato_id: it.platoId, cantidad: 1, bloque: i, nota: componerNota(state.notas[it.uid]) });
    }
  });
  sobrantes.forEach((it) => {
    items.push({ plato_id: it.platoId, cantidad: 1, bloque: bloques.length,
      nota: componerNota(state.notas[it.uid]), solo: it.esSolo || undefined });
  });

  const cuerpo = { comensal: state.comensal.trim(), tipo_entrega: state.tipoEntrega, items };
  if (state.tipoEntrega === 'llevar' && String(state.valorDomicilio).trim() !== '') {
    cuerpo.recargo_domicilio = Number(state.valorDomicilio);
  }
  if (!state.editandoId && est.modo === 'extras' && !state.imprimirExtras) cuerpo.imprimir = false;
  if (!state.editandoId && conPago && state.pagoMetodo) {
    if (state.pagoMetodo === 'efectivo' && state.pagoRecibido && Number(state.pagoRecibido) < totalCarrito()) {
      vibrar([60, 40, 60]); return toast('El monto recibido es menor al total', true);
    }
    cuerpo.pago_express = { metodo: state.pagoMetodo, recibido: state.pagoRecibido || undefined };
  }

  const editando = state.editandoId;
  const borrador = tomarBorrador();

  if (editando) {
    state.enviandoPedido = true; renderTicket();
    try {
      await api(`/pedidos/${editando}`, { method: 'PUT', body: cuerpo });
      beep(880); vibrar(80);
      toast('Comanda actualizada y reenviada a cocina');
      limpiarFormulario();
    } catch (e) { toast(e.message, true); }
    finally { state.enviandoPedido = false; renderTomar(); }
    return;
  }

  // El formulario se reinicia de inmediato y el envío sigue en segundo plano;
  // si el servidor lo rechaza, se restaura el borrador para no perder el pedido.
  cuerpo.uuid = uuid();
  state.uuidsPropios.add(cuerpo.uuid);
  limpiarFormulario();
  beep(660, 0.08); vibrar(40);
  renderTomar();
  try {
    const creado = await enviarConReintentos(cuerpo);
    beep(990, 0.12); vibrar(80);
    toast(`✅ Comanda ${String(creado.numero_comanda).padStart(3, '0')} registrada` +
      (creado.impreso === false ? ' (sin comanda en cocina)' : '') +
      (creado.recargo_tarjeta ? ` · Con recargo tarjeta: ${fmt(creado.total_cobrado)}` : '') +
      (creado.vueltas ? ` · Vueltas: ${fmt(creado.vueltas)}` : ''));
  } catch (e) {
    Object.assign(state, borrador);
    state.ticketAbierto = true;
    vibrar([80, 50, 80]);
    toast(`⚠️ No se envió: ${e.message}. El ticket se restauró.`, true);
    if (state.vista === 'tomar') renderTomar();
  }
}

async function enviarConReintentos(cuerpo) {
  for (let intento = 1; ; intento++) {
    try {
      return await api('/pedidos', { method: 'POST', body: cuerpo });
    } catch (e) {
      // Errores de red (WiFi caído): reintentar con el mismo uuid. Errores del negocio: no.
      const esRed = e instanceof TypeError || /fetch|network|conexión/i.test(e.message);
      if (!esRed || intento >= 5) throw e;
      toast(`Sin conexión, reintentando (${intento}/5)...`, true);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ---------------- Vista: historial de comandas ----------------
function tarjetaPedido(p, botones) {
  return `
    <div class="tarjeta">
      <div class="pedido-cab">
        <span class="num-comanda">#${String(p.numero_comanda).padStart(3, '0')}</span>
        <span class="grande" style="font-size:16px">${esc(p.comensal)}</span>
        ${p.tipo_entrega === 'llevar' ? '<span class="chip llevar">DOMICILIO</span>' : ''}
        ${p.estado === 'cancelado' ? '<span class="chip porcobrar">ANULADA</span>'
          : (p.pagado ? '<span class="chip pagado">PAGADO</span>' : '<span class="chip porcobrar">POR COBRAR</span>')}
        <span class="der suave">${esc((p.creado_en || '').slice(11, 16))}</span>
      </div>
      <div class="suave" style="margin:6px 0">
        ${p.items.map(i => `${i.cantidad > 1 ? i.cantidad + 'x ' : ''}${esc(i.plato_nombre)}${i.nota ? ` <em>(${esc(i.nota)})</em>` : ''}`).join(' · ')}
      </div>
      <div class="fila">
        <span class="suave">Vendedor: ${esc(p.vendedor)}</span>
        <span class="der grande" style="font-size:16px">${fmt(p.total)}</span>
      </div>
      ${botones ? `<div class="acciones">${botones}</div>` : ''}
    </div>`;
}

// Con comandas físicas en cocina no hay estado de "terminado": el papel es el control.
// Aquí queda el historial completo del día para consultar, corregir, reimprimir o cobrar.
function renderHistorial() {
  const comandas = state.pedidos.filter(p => p.estado !== 'cancelado');
  const anuladas = state.pedidos.filter(p => p.estado === 'cancelado');
  const bloqueada = state.jornadaCerrada;
  const puedeCobrar = state.usuario.rol !== 'mesero';

  $('#vista').innerHTML = `
    <div class="fila" style="margin-bottom:6px">
      <h2 style="margin:0" class="crece">Historial de hoy (${comandas.length})</h2>
      <button class="btn-mini primario" id="btn-excel-hist">📥 Excel del día</button>
    </div>
    ${comandas.length === 0 ? '<div class="tarjeta suave">Aún no hay comandas en esta jornada.</div>' : ''}
    ${comandas.map(p => tarjetaPedido(p, bloqueada ? '' : `
      ${!p.pagado && puedeCobrar ? `<button class="btn-mini ok" data-cobrar="${p.id}">💰 Cobrar</button>` : ''}
      ${!p.pagado ? `<button class="btn-mini primario" data-editar="${p.id}">✏️ Editar</button>` : ''}
      <button class="btn-mini peligro" data-cancelar="${p.id}">✕ Anular</button>
      <button class="btn-mini" data-reimprimir="${p.id}">🖨️ Reimprimir</button>
      <button class="btn-mini" data-factura="${p.id}">🧾 Factura</button>
    `)).join('')}
    ${anuladas.length ? `<h3>Anuladas (${anuladas.length})</h3>${anuladas.map(p => tarjetaPedido(p, '')).join('')}` : ''}`;

  if ($('#btn-excel-hist')) $('#btn-excel-hist').onclick = async () => {
    try {
      await descargarArchivo(`/api/reportes/excel?jornada=${state.jornada}`, `resumen-${state.jornada}.xlsx`);
      toast('📥 Excel del día descargado');
    } catch (e) { toast(e.message, true); }
  };
  conectarBotonesPedidos();
}

function conectarBotonesPedidos() {
  const v = $('#vista');
  v.querySelectorAll('[data-cancelar]').forEach(b => b.onclick = async () => {
    const p = state.pedidos.find(x => x.id === Number(b.dataset.cancelar));
    const aviso = p.pagado
      ? `¿Anular la comanda #${String(p.numero_comanda).padStart(3, '0')} YA PAGADA?\nEl pago se descuenta de la caja (devolución) y se imprime ANULADO en cocina.`
      : `¿Anular la comanda #${String(p.numero_comanda).padStart(3, '0')}?\nSe imprimirá un aviso de ANULADO en cocina.`;
    if (!confirm(aviso)) return;
    try {
      await api(`/pedidos/${b.dataset.cancelar}/cancelar`, { method: 'POST' });
      toast(p.pagado ? 'Comanda anulada y pago devuelto' : 'Comanda anulada; aviso enviado a cocina');
    } catch (e) { toast(e.message, true); }
  });
  v.querySelectorAll('[data-reimprimir]').forEach(b => b.onclick = async () => {
    try { await api(`/pedidos/${b.dataset.reimprimir}/reimprimir`, { method: 'POST' }); toast('Reimpresión enviada'); }
    catch (e) { toast(e.message, true); }
  });
  v.querySelectorAll('[data-factura]').forEach(b => b.onclick = async () => {
    try {
      const r = await api(`/pedidos/${b.dataset.factura}/factura`, { method: 'POST' });
      toast(`🧾 Factura No. ${String(r.consecutivo).padStart(6, '0')} impresa`);
    } catch (e) { toast(e.message, true); }
  });
  v.querySelectorAll('[data-editar]').forEach(b => b.onclick = () => cargarParaEditar(Number(b.dataset.editar)));
  v.querySelectorAll('[data-cobrar]').forEach(b => b.onclick = () => {
    state.cobrandoId = Number(b.dataset.cobrar);
    state.cobroMetodo = 'efectivo'; state.cobroRecibido = '';
    cambiarVista('caja');
  });
}

function cargarParaEditar(pedidoId) {
  const p = state.pedidos.find(x => x.id === pedidoId);
  if (!p) return;
  state.editandoId = p.id;
  state.editandoNumero = '#-' + String(p.numero_comanda).padStart(3, '0');
  state.comensal = p.comensal;
  state.tipoEntrega = p.tipo_entrega;
  state.valorDomicilio = p.tipo_entrega === 'llevar' ? String(p.recargo) : '';
  state.sel = { entrada: [], proteina: [], bebida: [], extra: [], solo: [] };
  state.notas = {}; state.notaExtras = { chips: [], custom: '' };
  state.itemAbierto = null;
  const sinMatch = [];
  // Reconstruir en orden de bloque para que el pareo entrada[i]-proteína[i]-extra[i] se conserve
  const items = [...p.items].sort((a, b) => (a.bloque ?? 999) - (b.bloque ?? 999) || a.id - b.id);
  for (const it of items) {
    const plato = state.platos.find(pl => pl.nombre === it.plato_nombre);
    if (!plato) { sinMatch.push(it.plato_nombre); continue; }
    const listaKey = it.solo ? 'solo' : claveListaDeTipo(plato.tipo);
    for (let i = 0; i < it.cantidad; i++) {
      const uid = state.uidSeq++;
      state.sel[listaKey].push({ uid, platoId: plato.id });
      if (it.nota && i === 0) state.notas[uid] = parsearNota(it.nota);
    }
  }
  if (sinMatch.length) toast(`Ojo: "${sinMatch.join(', ')}" ya no está en el menú; agréguelo de nuevo si aplica`, true);
  state.pantalla = 'extras';
  state.ticketAbierto = true;
  cambiarVista('tomar');
}

// Pantalla propia para rectificar métodos de pago (con 100 ventas, dentro de
// la Caja quedaba demasiado abajo)
function renderRectificar() {
  $('#vista').innerHTML = `
    <div class="ticket-cab">
      <button class="btn-mini" id="btn-rect-volver">← Volver a Caja</button>
      <h2 style="margin:0">🔁 Rectificar pagos</h2>
    </div>
    <div class="tarjeta">
      <div class="fila">
        <input id="rect-fecha" type="date" value="${state.jornada}" style="flex:1">
        <select id="rect-metodo" style="flex:1">
          <option value="">Todos los métodos</option>
          ${METODOS_COBRO.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
        </select>
      </div>
      <div class="suave" style="margin-top:6px">Elija el método para ver sus pagos del día y corrija el que esté mal con el selector de cada fila.</div>
    </div>
    <div class="tarjeta">
      <b>Corregir el TOTAL del día por método</b>
      <div class="suave" style="margin:4px 0 6px">Para cuadrar contra el extracto (Nequi, datáfono) sin tocar pago por pago. Ojo: al corregir un total, los almuerzos de ese método pasan a ser un <b>aproximado</b> en los reportes. Vacío = volver a lo registrado.</div>
      <div id="ajustes-rect"><span class="suave">Cargando...</span></div>
    </div>
    <div class="suave" style="margin:2px 0 6px">O corrija pago por pago (esto sí conserva el conteo exacto de almuerzos):</div>
    <div id="lista-rect"><span class="suave">Cargando...</span></div>`;

  $('#btn-rect-volver').onclick = () => { state.enRectificar = false; renderCaja(); };
  const cargarAjustes = async () => {
    const cont = $('#ajustes-rect');
    if (!cont) return;
    try {
      const fecha = $('#rect-fecha').value || state.jornada;
      const a = await api(`/pagos/ajustes?jornada=${fecha}`);
      const ajustables = a.ajustables || [];
      cont.innerHTML = METODOS_COBRO.map(([k, v]) => {
        const reg = a.registrado[k] || 0, real = a.real[k] || 0;
        const alm = a.almuerzos[k] || { cantidad: 0, aproximado: false };
        const d = (a.detalle || {})[k];
        // El efectivo no se corrige aquí: se cuadra contando la caja
        if (!ajustables.includes(k)) {
          return `<div class="fila" style="padding:4px 0;border-bottom:1px dashed var(--borde)">
            <span class="crece">${v}<br><span class="suave">registrado ${fmt(reg)} · ${alm.cantidad} almuerzo(s)</span></span>
            <span class="suave" style="width:120px;text-align:right">se cuadra contando la caja</span>
          </div>`;
        }
        return `<div class="fila" style="padding:4px 0;border-bottom:1px dashed var(--borde)">
          <span class="crece">${v}<br><span class="suave">registrado ${fmt(reg)} · ${alm.cantidad} almuerzo(s)${alm.aproximado ? ' <b style="color:var(--alerta)">aprox.</b>' : ''}${d && d.cambiaronPagos ? '<br><b style="color:var(--alerta)">hubo pagos nuevos o anulados después de corregir</b>' : ''}</span></span>
          <input data-ajuste="${k}" type="text" inputmode="numeric" value="${a.ajustados[k] ? real : ''}"
            placeholder="${fmt(reg)}" ${a.cerrada ? 'disabled' : ''} style="width:120px">
        </div>`;
      }).join('');
      // Solo dígitos: el teclado de Android ofrece el punto y "12.000" se
      // guardaría como 12
      cont.querySelectorAll('[data-ajuste]').forEach(inp => inp.oninput = () => {
        const limpio = inp.value.replace(/[^0-9]/g, '');
        if (inp.value !== limpio) inp.value = limpio;
      });
      cont.querySelectorAll('[data-ajuste]').forEach(inp => inp.onchange = async () => {
        try {
          const r = await api('/pagos/ajustes', { method: 'PUT', body: { jornada: fecha, metodo: inp.dataset.ajuste, total_real: inp.value } });
          toast(r.ajustado ? `${METODOS[inp.dataset.ajuste]}: total corregido a ${fmt(r.real)} (almuerzos aproximados)` : `${METODOS[inp.dataset.ajuste]}: sin corrección, vuelve a lo registrado`);
          cargarAjustes();
        } catch (e) { toast(e.message, true); cargarAjustes(); }
      });
    } catch (e) { cont.innerHTML = `<div class="suave">${esc(e.message)}</div>`; }
  };
  const cargarRect = async () => {
    const cont = $('#lista-rect');
    if (!cont) return;
    try {
      const fecha = $('#rect-fecha').value || state.jornada;
      const metodo = $('#rect-metodo').value;
      const r = await api(`/pagos?jornada=${fecha}${metodo ? '&metodo=' + metodo : ''}`);
      if (!r.pagos.length) { cont.innerHTML = '<div class="tarjeta suave">No hay pagos con ese filtro.</div>'; return; }
      const totalFiltro = r.pagos.reduce((s, pg) => s + pg.monto, 0);
      cont.innerHTML = (r.cerrada ? '<div class="tarjeta suave" style="color:var(--alerta)">⚠️ Día con cierre: solo consulta (el admin puede reabrir el día desde la Caja)</div>' : '') +
        `<div class="tarjeta"><div class="fila"><b class="crece">${r.pagos.length} pago(s)</b><b>${fmt(totalFiltro)}</b></div></div>` +
        r.pagos.map(pg => `
        <div class="tarjeta">
          <div class="fila">
            <span class="num-comanda" style="font-size:15px">#-${String(pg.numero_comanda).padStart(3, '0')}</span>
            <span class="suave">${esc((pg.creado_en || '').slice(11, 16))}</span>
            <span class="crece" style="text-align:right;font-weight:800">${fmt(pg.monto)}</span>
            <select data-rect-pedido="${pg.pedido_id}" ${r.cerrada ? 'disabled' : ''} style="width:140px">
              ${METODOS_COBRO.map(([k, v]) => `<option value="${k}" ${pg.metodo === k ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
          </div>
        </div>`).join('');
      cont.querySelectorAll('[data-rect-pedido]').forEach(sel => {
        const original = sel.value;
        sel.onchange = async () => {
          const nuevo = sel.value;
          if (!confirm(`¿Cambiar el pago de la comanda a ${METODOS[nuevo] || nuevo}?\n(Si pasa a tarjeta se suma el recargo; si deja de ser tarjeta, se quita.)`)) {
            sel.value = original; return;
          }
          try {
            const resp = await api(`/pagos/${sel.dataset.rectPedido}/metodo`, { method: 'PUT', body: { metodo: nuevo } });
            toast(`Pago rectificado: ${METODOS[nuevo] || nuevo} por ${fmt(resp.monto)}`);
            cargarRect();
          } catch (e) { toast(e.message, true); sel.value = original; }
        };
      });
    } catch (e) { cont.innerHTML = `<div class="tarjeta suave">${esc(e.message)}</div>`; }
  };
  $('#rect-fecha').onchange = () => { cargarRect(); cargarAjustes(); };
  $('#rect-metodo').onchange = cargarRect;
  cargarRect();
  cargarAjustes();
}

async function descargarArchivo(ruta, nombre) {
  const r = await fetch(ruta, { headers: { 'Authorization': 'Bearer ' + state.token } });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || 'No se pudo generar el archivo');
  }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nombre;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------------- Vista: caja ----------------
function renderCaja() {
  if (state.enRectificar) return renderRectificar();
  if (state.enNomina) return renderNomina();
  const sinPagar = state.pedidos.filter(p => p.estado !== 'cancelado' && !p.pagado);
  const cobrando = state.cobrandoId ? state.pedidos.find(p => p.id === state.cobrandoId) : null;

  let htmlCobro = '';
  if (cobrando) {
    const recTCobro = state.cobroMetodo === 'tarjeta' ? recargoTarjetaCliente(cobrando.total) : 0;
    htmlCobro = `
      <div class="tarjeta" style="border-color: var(--primario)">
        <h3 style="margin-top:0">Cobrar comanda #${String(cobrando.numero_comanda).padStart(3, '0')} — ${esc(cobrando.comensal)}</h3>
        <div class="grande" style="margin-bottom:10px">${fmt(cobrando.total)}</div>
        <div class="pago-grid">
          ${METODOS_COBRO.map(([k, v]) =>
            `<button class="pago-btn ${state.cobroMetodo === k ? 'sel' : ''}" data-metodo="${k}">${v}</button>`).join('')}
        </div>
        ${recTCobro ? `<div class="aviso-vueltas" style="color:var(--alerta);font-size:15px">
          Recargo tarjeta +${fmt(recTCobro)} · Total a cobrar: ${fmt(cobrando.total + recTCobro)}</div>` : ''}
        ${state.cobroMetodo === 'efectivo' ? `
          <label>Recibido en efectivo</label>
          <input id="in-recibido" type="text" inputmode="numeric" pattern="[0-9]*" placeholder="Ej: 50000" value="${esc(state.cobroRecibido)}">
          <div id="aviso-vueltas-caja" class="aviso-vueltas"></div>` : ''}
        <div class="fila" style="margin-top:10px">
          <button class="btn gris" id="btn-cerrar-cobro" style="width:auto;flex:1">Cancelar</button>
          <button class="btn ok" id="btn-confirmar-pago" style="flex:2">Registrar pago</button>
        </div>
      </div>`;
  }

  $('#vista').innerHTML = `
    <h2>Caja</h2>
    ${htmlCobro}
    <div class="tarjeta" id="base-caja">
      <div class="fila"><b class="crece">💵 Dinero con el que arrancó el día</b><b id="base-actual">...</b></div>
      <div class="suave" id="base-origen" style="margin:2px 0 6px"></div>
      ${state.jornadaCerrada ? '' : `
      <div class="fila">
        <input id="in-base" type="text" inputmode="numeric" pattern="[0-9]*" placeholder="Corregir (vacío = usar el de ayer)" style="flex:2">
        <button class="btn-mini ok" id="btn-base" style="flex:1">Registrar</button>
      </div>
      <div class="suave" style="margin-top:4px">Opcional: si lo que hay en la caja no coincide con lo que contó el cajero de ayer, escriba aquí lo que hay de verdad.</div>`}
    </div>
    <h3>Resumen del día</h3>
    <div class="tarjeta" id="resumen-dia"><span class="suave">Cargando...</span></div>
    <div class="fila" style="margin:8px 0 4px">
      <input id="excel-fecha" type="date" value="${state.jornada}" style="flex:1">
      <button class="btn-mini primario" id="btn-excel" style="flex:1">📥 Descargar Excel</button>
    </div>
    <div class="fila" style="margin:4px 0 8px">
      <input id="excel-mes" type="month" value="${state.jornada.slice(0, 7)}" style="flex:1">
      <button class="btn-mini primario" id="btn-excel-mes" style="flex:1">📥 Excel del mes</button>
    </div>
    <div class="tarjeta">
      <div class="suave">📊 Qué se vendió entre dos fechas (para decidir las compras)</div>
      <div class="fila" style="margin-top:6px">
        <input id="pl-desde" type="date" value="${state.jornada.slice(0, 8)}01" style="flex:1">
        <input id="pl-hasta" type="date" value="${state.jornada}" style="flex:1">
      </div>
      <button class="btn-mini primario" id="btn-excel-platos" style="margin-top:8px;width:100%">
        📊 Excel de platos y tipos vendidos</button>
    </div>

    <button class="btn gris" id="btn-ir-rect" style="margin:8px 0">🔁 Rectificar métodos de pago →</button>

    <h3>Cuentas por cobrar (${sinPagar.length})</h3>
    ${sinPagar.length === 0 ? '<div class="tarjeta suave">Todo está cobrado. 🎉</div>' : ''}
    ${sinPagar.map(p => tarjetaPedido(p, state.jornadaCerrada ? '' :
      `<button class="btn-mini ok" data-cobrar2="${p.id}">💰 Cobrar</button>`)).join('')}

    <h3>💸 Gastos del local</h3>
    <div class="tarjeta">
      <textarea id="ga-concepto" rows="2" placeholder="Concepto (puede usar Enter para listar los productos de una factura:&#10;guantes 5.000&#10;esponjas 3.000...)"></textarea>
      <div class="fila" style="margin-top:8px">
        <input id="ga-valor" type="text" inputmode="numeric" pattern="[0-9]*" placeholder="Valor" style="flex:1">
        <button class="btn-mini ok" id="btn-gasto" style="flex:1">Registrar gasto</button>
      </div>
      <div id="lista-gastos" style="margin-top:8px"><span class="suave">Cargando...</span></div>
    </div>

    <h3>👥 Nómina</h3>
    <div class="tarjeta">
      <div class="suave">Registrar turnos (qué día vino cada quien y qué hizo), pagar el acumulado, y corregir días pasados.</div>
      <button class="btn gris" id="btn-ir-nomina" style="margin-top:8px">👥 Turnos y pagos de nómina →</button>
    </div>

    <h3>Cierre de caja</h3>
    <div class="tarjeta">
      ${state.jornadaCerrada ? `<div class="suave">La jornada ya tiene cierre registrado.</div>
      ${state.usuario.rol === 'admin' ? '<button class="btn peligro" id="btn-reabrir" style="margin-top:10px">🔓 Reabrir el día (deshacer el cierre)</button>' : ''}` : `
      <label>Efectivo físico contado en caja (opcional)</label>
      <input id="in-efectivo-contado" type="number" inputmode="numeric" placeholder="Cuente los billetes y monedas">
      <button class="btn peligro" id="btn-cierre" style="margin-top:10px">Ejecutar cierre de caja</button>
      <div class="suave" style="margin-top:6px">Tras el cierre no se podrán registrar más pedidos ni pagos hoy.</div>`}
    </div>`;

  if (cobrando) {
    // Actualiza SOLO el texto de vueltas y el botón, sin re-dibujar (el cursor se rompe si no)
    const actualizarVueltasCobro = () => {
      const div = $('#aviso-vueltas-caja');
      const btn = $('#btn-confirmar-pago');
      if (!div || !btn) return;
      const recibido = Number(state.cobroRecibido || 0);
      const vueltas = recibido - cobrando.total;
      const mal = state.cobroMetodo === 'efectivo' && (!recibido || vueltas < 0);
      btn.disabled = mal;
      if (!recibido) { div.textContent = ''; return; }
      div.className = vueltas < 0 ? 'aviso-vueltas mal' : 'aviso-vueltas';
      div.textContent = vueltas >= 0 ? `Vueltas: ${fmt(vueltas)}` : 'El monto recibido es menor al total';
    };
    $('#vista').querySelectorAll('[data-metodo]').forEach(b => b.onclick = () => {
      state.cobroMetodo = b.dataset.metodo; renderCaja();
    });
    if ($('#in-recibido')) $('#in-recibido').oninput = (e) => {
      state.cobroRecibido = e.target.value.replace(/[^0-9]/g, '');
      if (e.target.value !== state.cobroRecibido) e.target.value = state.cobroRecibido;
      actualizarVueltasCobro();
    };
    actualizarVueltasCobro();
    $('#btn-cerrar-cobro').onclick = () => { state.cobrandoId = null; renderCaja(); };
    $('#btn-confirmar-pago').onclick = async () => {
      try {
        const r = await api(`/pedidos/${cobrando.id}/pago`, {
          method: 'POST',
          body: { metodo: state.cobroMetodo, recibido: state.cobroMetodo === 'efectivo' ? Number(state.cobroRecibido) : undefined }
        });
        toast('Pago registrado' +
          (r.recargo_tarjeta ? ` (cobrado ${fmt(r.total_cobrado)} con recargo tarjeta)` : '') +
          (r.vueltas != null ? ` · Vueltas: ${fmt(r.vueltas)}` : ''));
        state.cobrandoId = null;
      } catch (e) { toast(e.message, true); }
    };
  }
  $('#vista').querySelectorAll('[data-cobrar2]').forEach(b => b.onclick = () => {
    state.cobrandoId = Number(b.dataset.cobrar2);
    state.cobroMetodo = 'efectivo'; state.cobroRecibido = '';
    renderCaja();
  });
  if ($('#btn-ir-rect')) $('#btn-ir-rect').onclick = () => { state.enRectificar = true; renderRectificar(); };
  if ($('#btn-reabrir')) $('#btn-reabrir').onclick = async () => {
    if (!confirm('¿Reabrir la jornada de hoy?\nEl cierre se borra y podrán registrarse ventas de nuevo.\n(Ojo: los nombres de clientes borrados por el cierre no se recuperan.)')) return;
    try {
      await api('/cierre/reabrir', { method: 'POST' });
      state.jornadaCerrada = false;
      toast('🔓 Día reabierto: pueden seguir vendiendo');
      renderBanner(); renderCaja();
    } catch (e) { toast(e.message, true); }
  };
  if ($('#btn-cierre')) $('#btn-cierre').onclick = async () => {
    const val = $('#in-efectivo-contado').value;
    if (!confirm('¿Ejecutar el cierre de caja? La jornada quedará bloqueada.')) return;
    try {
      const r = await api('/cierre', { method: 'POST', body: { efectivo_contado: val === '' ? null : Number(val) } });
      state.jornadaCerrada = true;
      const d = r.descuadre;
      const msjCierre = d === null ? 'Cierre registrado' :
        d === 0 ? 'Cierre registrado: caja cuadrada ✅' :
        `Cierre registrado: ${d > 0 ? 'sobran' : 'faltan'} ${fmt(Math.abs(d))}`;
      const msjReporte = r.reporteCorreo === 'enviado'
        ? ' · 📨 Reporte enviado al dueño'
        : ' · Reporte en cola (revise la configuración de Gmail en Admin)';
      toast(msjCierre + msjReporte);
      renderCaja();
    } catch (e) { toast(e.message, true); }
  };

  if ($('#btn-excel')) $('#btn-excel').onclick = async () => {
    const fecha = $('#excel-fecha').value || state.jornada;
    try {
      await descargarArchivo(`/api/reportes/excel?jornada=${fecha}`, `resumen-${fecha}.xlsx`);
      toast('📥 Excel del día descargado: revise Descargas');
    } catch (e) { toast(e.message, true); }
  };
  if ($('#btn-excel-platos')) $('#btn-excel-platos').onclick = async () => {
    const desde = $('#pl-desde').value || state.jornada;
    const hasta = $('#pl-hasta').value || state.jornada;
    try {
      await descargarArchivo(`/api/reportes/platos-excel?desde=${desde}&hasta=${hasta}`, `platos-${desde}_a_${hasta}.xlsx`);
      toast('📊 Excel de platos vendidos descargado');
    } catch (e) { toast(e.message, true); }
  };
  if ($('#btn-excel-mes')) $('#btn-excel-mes').onclick = async () => {
    const mes = $('#excel-mes').value || state.jornada.slice(0, 7);
    try {
      await descargarArchivo(`/api/reportes/excel-mes?mes=${mes}`, `resumen-${mes}.xlsx`);
      toast('📥 Excel del mes descargado (resumen día por día + todas las ventas)');
    } catch (e) { toast(e.message, true); }
  };
  if ($('#in-base')) $('#in-base').oninput = (e) => {
    const limpio = e.target.value.replace(/[^0-9]/g, ''); // "120.000" -> 120000
    if (e.target.value !== limpio) e.target.value = limpio;
  };
  if ($('#btn-base')) $('#btn-base').onclick = async () => {
    const valor = $('#in-base').value.trim();
    try {
      const r = await api('/caja/base', { method: 'PUT', body: { valor } });
      $('#in-base').value = '';
      toast(valor === '' ? 'Base de caja: vuelve a usarse la del cierre anterior' : `Base de caja registrada: ${fmt(r.base.valor)}`);
      cargarResumenDia();
    } catch (e) { toast(e.message, true); }
  };
  if ($('#btn-excel-nomina')) $('#btn-excel-nomina').onclick = async () => {
    const anio = $('#excel-anio').value || state.jornada.slice(0, 4);
    try {
      await descargarArchivo(`/api/nomina/excel?anio=${anio}`, `nomina-${anio}.xlsx`);
      toast('📥 Excel de nómina descargado (una hoja por empleado)');
    } catch (e) { toast(e.message, true); }
  };
  if ($('#btn-gasto')) $('#btn-gasto').onclick = async () => {
    try {
      await api('/gastos', { method: 'POST', body: { concepto: $('#ga-concepto').value, valor: $('#ga-valor').value } });
      toast('Gasto registrado (se descuenta del efectivo esperado)');
      $('#ga-concepto').value = ''; $('#ga-valor').value = '';
      cargarGastos(); cargarResumenDia();
    } catch (e) { toast(e.message, true); }
  };

  if ($('#btn-ir-nomina')) $('#btn-ir-nomina').onclick = () => { state.enNomina = true; renderNomina(); };
  cargarGastos();
  cargarResumenDia();
}

async function cargarGastos() {
  try {
    const gastos = await api('/gastos');
    const cont = $('#lista-gastos');
    if (!cont) return;
    const total = gastos.reduce((s, g) => s + g.valor, 0);
    cont.innerHTML = gastos.length ? gastos.map(g => {
      const lineas = String(g.concepto).split('\n');
      const multi = lineas.length > 1;
      const abierto = state.gastoAbierto === g.id;
      return `
      <div style="padding:3px 0;border-bottom:1px dashed var(--borde)">
        <div class="fila suave">
          ${multi ? `<button class="btn-mini" data-gasto-exp="${g.id}">${abierto ? '▾' : '▸'}</button>` : ''}
          <span class="crece">${esc(lineas[0])}${multi && !abierto ? '…' : ''} <em>(${esc(g.usuario)})</em></span>
          <span style="font-weight:700">${fmt(g.valor)}</span>
          ${state.usuario.rol !== 'mesero' ? `<button class="btn-mini peligro" data-gasto-borrar="${g.id}">✕</button>` : ''}
        </div>
        ${abierto ? `<div class="suave" style="white-space:pre-wrap;padding:4px 0 4px 34px">${esc(g.concepto)}</div>` : ''}
      </div>`;
    }).join('') + `<div class="fila" style="margin-top:6px"><b class="crece">Total gastos hoy</b><b>${fmt(total)}</b></div>`
      : '<span class="suave">Sin gastos registrados hoy</span>';
    cont.querySelectorAll('[data-gasto-exp]').forEach(b => b.onclick = () => {
      const id = Number(b.dataset.gastoExp);
      state.gastoAbierto = state.gastoAbierto === id ? null : id;
      cargarGastos();
    });
    cont.querySelectorAll('[data-gasto-borrar]').forEach(b => b.onclick = async () => {
      if (!confirm('¿Eliminar este gasto?')) return;
      try { await api(`/gastos/${b.dataset.gastoBorrar}`, { method: 'DELETE' }); cargarGastos(); cargarResumenDia(); }
      catch (e) { toast(e.message, true); }
    });
  } catch { /* la vista pudo cambiar */ }
}

// ---------------- Vista: nómina (submenú de Caja) ----------------
// Como el Kardex de papel: por un lado los TURNOS (qué día vino y qué hizo),
// por otro los PAGOS (cuándo se le pagó el acumulado). El admin puede
// corregir o borrar cualquiera, también de días pasados.
const DIAS_CORTOS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const diaCorto = (f) => DIAS_CORTOS[new Date(f + 'T12:00:00').getDay()];
const fechaCorta = (f) => `${diaCorto(f)} ${Number(f.slice(8, 10))}/${Number(f.slice(5, 7))}`;

// Mismo cálculo que el servidor: cada día de la semana tiene su valor
function valorCargoCliente(cargos, cargo, fecha) {
  const c = (cargos || []).find(x => x.nombre === cargo);
  if (!c || !Array.isArray(c.dias)) return 0;
  return Number(c.dias[new Date(fechaTurnoValida(fecha) + 'T12:00:00').getDay()]) || 0;
}

// --- Roles de nómina y valor del turno por día (los editan admin y cajero) ---
// Sin "valor por defecto": cada día de la semana lleva el suyo, para que
// nadie tenga que adivinar de dónde sale el valor de un turno.
const DIAS_ROL = [[1, 'Lun'], [2, 'Mar'], [3, 'Mié'], [4, 'Jue'], [5, 'Vie'], [6, 'Sáb'], [0, 'Dom']];
const DIAS_PLURAL = ['los domingos', 'los lunes', 'los martes', 'los miércoles', 'los jueves', 'los viernes', 'los sábados'];
const ROL_POR_ACCESO = { admin: 'Administrador', cajero: 'Cajero', mesero: 'Mesero', cocinera: 'Cocinera' };
function filaRol(c) {
  const dias = Array.isArray(c.dias) ? c.dias : [];
  return `<div class="rol-fila">
    <div class="fila" style="flex-wrap:nowrap">
      <input data-rol-nombre value="${esc(c.nombre || '')}" placeholder="Nombre del rol (ej: Auxiliar de caja)" style="flex:1">
      <button class="btn-mini peligro" data-rol-quitar style="width:38px;padding:7px 0" title="Borrar rol">🗑</button>
    </div>
    <div class="rol-dias">
      ${DIAS_ROL.map(([d, n]) => `<div><label>${n}</label><input type="text" inputmode="numeric" data-rol-dia="${d}" value="${dias[d] || ''}" placeholder="0"></div>`).join('')}
    </div>
  </div>`;
}
function htmlRoles(cargos) {
  return `
    <div class="suave">Qué se paga por un turno de cada rol, día por día. Un mismo empleado puede ser cajero un día y auxiliar de cocina otro: al registrar el turno se elige el rol que hizo ese día y el valor sale de aquí. Un día en 0 no se puede registrar con ese rol.</div>
    <div id="roles-lista">${(cargos || []).map(filaRol).join('')}</div>
    <div class="fila" style="margin-top:8px">
      <button class="btn-mini" id="btn-rol-agregar">＋ Agregar rol</button>
      <button class="btn-mini ok" id="btn-roles-guardar">💾 Guardar roles</button>
    </div>`;
}
function leerRoles(cont) {
  return [...cont.querySelectorAll('.rol-fila')].map(f => {
    const dias = [0, 0, 0, 0, 0, 0, 0];
    f.querySelectorAll('[data-rol-dia]').forEach(i => { dias[Number(i.dataset.rolDia)] = Number(i.value) || 0; });
    return { nombre: f.querySelector('[data-rol-nombre]').value.trim(), dias };
  }).filter(r => r.nombre);
}
function conectarRoles(cont, alGuardar) {
  const enganchar = () => {
    cont.querySelectorAll('[data-rol-quitar]').forEach(b => b.onclick = () => {
      const fila = b.closest('.rol-fila');
      const nombre = fila.querySelector('[data-rol-nombre]').value.trim();
      if (nombre && !confirm(`¿Quitar el rol "${nombre}"?\nSe borra al tocar "Guardar roles". Los turnos ya registrados con ese rol no cambian.`)) return;
      fila.remove();
    });
    cont.querySelectorAll('[data-rol-dia]').forEach(i => i.oninput = () => { const l = i.value.replace(/[^0-9]/g, ''); if (i.value !== l) i.value = l; });
  };
  enganchar();
  cont.querySelector('#btn-rol-agregar').onclick = () => {
    cont.querySelector('#roles-lista').insertAdjacentHTML('beforeend', filaRol({ nombre: '', dias: [] }));
    enganchar();
    const nombres = cont.querySelectorAll('[data-rol-nombre]');
    nombres[nombres.length - 1].focus();
  };
  cont.querySelector('#btn-roles-guardar').onclick = async () => {
    const lista = leerRoles(cont);
    if (!lista.length && !confirm('¿Guardar sin ningún rol? No se podrán registrar turnos hasta crear uno.')) return;
    try {
      const r = await api('/cargos', { method: 'PUT', body: { cargos: lista } });
      toast(`${r.cargos.length} rol(es) guardado(s)`);
      if (alGuardar) alGuardar(r.cargos);
    } catch (e) { toast(e.message, true); }
  };
}
// Tarjeta plegable de roles en la pantalla de nómina
function pintarRoles(r) {
  const cont = $('#nom-roles');
  if (!cont) return;
  const firma = JSON.stringify(r.cargos);
  // Con el editor abierto no se redibuja (se perdería lo escrito), salvo que
  // otro teléfono haya guardado roles distintos
  if (state.rolesAbierto && cont.dataset.firma === firma) return;
  cont.dataset.firma = firma;
  const resumen = r.cargos.length ? r.cargos.map(c => c.nombre).join(', ') : 'ninguno todavía';
  cont.innerHTML = `
    <div class="fila" id="nom-roles-cab" style="cursor:pointer"><b class="crece">👔 Roles y valor del turno por día</b><span class="suave" style="font-size:18px">${state.rolesAbierto ? '▾' : '▸'}</span></div>
    ${state.rolesAbierto ? htmlRoles(r.cargos) : `<div class="suave" style="margin-top:2px">${esc(resumen)}. Toque para crear, borrar o cambiar valores.</div>`}`;
  $('#nom-roles-cab').onclick = () => { state.rolesAbierto = !state.rolesAbierto; delete cont.dataset.firma; pintarRoles(r); };
  if (state.rolesAbierto) conectarRoles(cont, () => { state.rolesAbierto = false; cargarNominaDatos(); });
}

function renderNomina() {
  const esAdmin = state.usuario.rol === 'admin';
  if (!state.nominaMes) state.nominaMes = state.jornada.slice(0, 7);
  $('#vista').innerHTML = `
    <div class="ticket-cab">
      <button class="btn-mini" id="btn-nom-volver">← Volver a Caja</button>
      <h2 style="margin:0">👥 Nómina</h2>
    </div>
    <div class="tarjeta" id="nom-registrar"><span class="suave">Cargando...</span></div>
    <div class="tarjeta" id="nom-roles"></div>
    <div id="nom-sin-pagar"></div>
    <div id="nom-pendientes"></div>
    <div class="tarjeta">
      <div class="fila"><b class="crece">📅 Historial del mes</b>
        <input type="month" id="nom-mes" value="${esc(state.nominaMes)}" style="width:175px"></div>
      <div class="suave" style="margin:4px 0 6px">Días trabajados y pagos.${esAdmin ? ' Como administrador puede corregir o borrar cualquier día, también de meses pasados.' : ''}</div>
      <div id="nom-historial"><span class="suave">Cargando...</span></div>
    </div>
    <div class="tarjeta" id="nom-totales"><span class="suave">Cargando...</span></div>
    <div class="fila" style="margin:8px 0 4px">
      <input id="excel-anio" type="number" min="2026" max="2100" value="${state.jornada.slice(0, 4)}" style="flex:1">
      <button class="btn-mini primario" id="btn-excel-nomina" style="flex:2">📥 Excel de nómina (hoja por mes)</button>
    </div>`;
  $('#btn-nom-volver').onclick = () => { state.enNomina = false; renderCaja(); };
  $('#nom-mes').onchange = () => { state.nominaMes = $('#nom-mes').value || state.jornada.slice(0, 7); cargarNominaDatos(); };
  $('#btn-excel-nomina').onclick = async () => {
    const anio = $('#excel-anio').value || state.jornada.slice(0, 4);
    try {
      await descargarArchivo(`/api/nomina/excel?anio=${anio}`, `nomina-${anio}.xlsx`);
      toast('📥 Excel de nómina descargado (una hoja por mes)');
    } catch (e) { toast(e.message, true); }
  };
  cargarNominaDatos();
}

async function cargarNominaDatos() {
  let r;
  try { r = await api(`/nomina/resumen?mes=${state.nominaMes || state.jornada.slice(0, 7)}`); }
  catch (e) { return toast(e.message, true); }
  if (!state.enNomina || !$('#nom-registrar')) return; // la vista cambió
  state.nominaDatos = r;
  pintarRegistrarTurno(r);
  pintarRoles(r);
  pintarSinPagar(r);
  pintarPendientesNomina(r);
  pintarHistorialNomina(r);
  pintarTotalesNomina(r);
}

// --- Registrar un turno: quién, qué día, qué rol hizo ---
function pintarRegistrarTurno(r) {
  const cont = $('#nom-registrar');
  const esAdmin = state.usuario.rol === 'admin';
  if (!r.empleados.length) { cont.innerHTML = '<span class="suave">No hay empleados activos.</span>'; return; }
  if (!r.cargos.length) {
    cont.innerHTML = '<b>📝 Registrar turno</b><div class="suave" style="margin-top:4px">Todavía no hay roles. Créelos abajo en 👔 Roles y valor del turno por día (cajero, auxiliar de caja, auxiliar de cocina...).</div>';
    return;
  }
  const empSel = r.empleados.find(e => e.id === state.nomEmpleado) || r.empleados[0];
  cont.innerHTML = `
    <b>📝 Registrar turno</b>
    <div class="suave" style="margin:2px 0 6px">Quién vino, qué día y qué rol hizo ese día. Se paga después, por acumulado.</div>
    <div class="fila">
      <div class="crece"><label>Empleado</label>
        <select id="tu-emp">${r.empleados.map(e => `<option value="${e.id}" ${e.id === empSel.id ? 'selected' : ''}>${esc(e.nombre)}</option>`).join('')}</select></div>
      <div class="crece"><label>Día</label><input id="tu-fecha" type="date" value="${r.hoy}" max="${r.hoy}"></div>
    </div>
    <div class="fila" style="margin-top:6px">
      <div class="crece"><label>Rol que hizo ese día</label>
        <select id="tu-cargo">${r.cargos.map(c => `<option value="${esc(c.nombre)}">${esc(c.nombre)}</option>`).join('')}</select></div>
      <div class="crece"><label>Valor del turno${esAdmin ? '' : ' (según rol y día)'}</label>
        <input id="tu-valor" type="text" inputmode="numeric" ${esAdmin ? '' : 'readonly style="opacity:.65"'}></div>
    </div>
    <div class="suave" id="tu-aviso" style="color:var(--alerta);margin-top:4px" hidden></div>
    <input id="tu-nota" placeholder="Nota (opcional: ej. medio turno, reemplazo)" autocomplete="off" style="margin-top:6px">
    <button class="btn ok" id="btn-turno" style="margin-top:8px">Registrar turno</button>`;

  // Rol preseleccionado: el habitual del empleado (o el de su acceso en la app)
  const elegirRolHabitual = () => {
    const emp = r.empleados.find(e => e.id === Number($('#tu-emp').value));
    if (emp && emp.cargo_default && r.cargos.some(c => c.nombre === emp.cargo_default)) $('#tu-cargo').value = emp.cargo_default;
  };
  let valorAuto = null;
  const actualizarValor = (forzar) => {
    const campo = $('#tu-valor');
    const escritoAMano = valorAuto !== null && campo.value !== String(valorAuto);
    if (forzar || !escritoAMano || !esAdmin) {
      valorAuto = valorCargoCliente(r.cargos, $('#tu-cargo').value, $('#tu-fecha').value);
      campo.value = valorAuto || '';
    }
    // Un rol sin valor ese día de la semana no se puede registrar: se avisa aquí mismo
    const aviso = $('#tu-aviso');
    const dia = new Date(fechaTurnoValida($('#tu-fecha').value) + 'T12:00:00').getDay();
    aviso.hidden = valorAuto > 0 || (esAdmin && Number(campo.value) > 0);
    aviso.textContent = aviso.hidden ? '' :
      `El rol "${$('#tu-cargo').value}" no tiene valor para ${DIAS_PLURAL[dia]}: póngalo abajo en 👔 Roles y valor del turno por día${esAdmin ? ', o escriba aquí el valor a mano' : ''}.`;
  };
  $('#tu-emp').onchange = () => { state.nomEmpleado = Number($('#tu-emp').value); elegirRolHabitual(); actualizarValor(true); };
  $('#tu-cargo').onchange = () => actualizarValor(true);
  $('#tu-fecha').onchange = () => actualizarValor(false);
  $('#tu-valor').oninput = (e) => { const l = e.target.value.replace(/[^0-9]/g, ''); if (e.target.value !== l) e.target.value = l; actualizarValor(false); };
  elegirRolHabitual();
  actualizarValor(true);

  $('#btn-turno').onclick = async (ev, repetir) => {
    const cuerpo = {
      empleado_id: Number($('#tu-emp').value), jornada: $('#tu-fecha').value, cargo: $('#tu-cargo').value,
      nota: $('#tu-nota').value, repetir: !!repetir
    };
    if (esAdmin) cuerpo.valor = $('#tu-valor').value;
    try {
      const resp = await api('/turnos', { method: 'POST', body: cuerpo });
      beep(880, 0.08); vibrar(40);
      toast(`Turno registrado: ${fechaCorta(cuerpo.jornada)} · ${cuerpo.cargo} · ${fmt(resp.valor)}`);
      $('#tu-nota').value = '';
    } catch (e) {
      if (/ya tiene un turno/.test(e.message) && !repetir) {
        if (confirm(`${e.message}.\n\n¿Registrar otro turno igual ese mismo día (por ejemplo, doble turno)?`)) return $('#btn-turno').onclick(null, true);
        return;
      }
      toast(e.message, true);
    }
  };
}

// Fila de un turno, con edición en línea para el admin
function filaTurno(t, r, opciones = {}) {
  const esAdmin = state.usuario.rol === 'admin';
  const editando = state.turnoEditando === t.id;
  const pagado = !!t.pago_id;
  const estado = pagado
    ? `<span class="chip pagado">pagado ${t.pagado_en ? fechaCorta(t.pagado_en) : ''}</span>`
    : '<span class="chip porcobrar">sin pagar</span>';
  return `
    <div class="turno-fila">
      <div class="fila" style="flex-wrap:nowrap">
        ${opciones.seleccionable ? `<input type="checkbox" class="turno-check" data-turno-check="${t.id}" data-valor="${t.valor}" checked style="width:20px;height:20px;flex:none">` : ''}
        <span class="crece"><b>${fechaCorta(t.jornada)}</b> · ${esc(t.cargo)}${opciones.conEmpleado ? ` · <b>${esc(t.empleado)}</b>` : ''}${t.nota ? ` <span class="suave">(${esc(t.nota)})</span>` : ''}</span>
        <span style="font-weight:700;white-space:nowrap">${fmt(t.valor)}</span>
        ${opciones.conEstado ? estado : ''}
        ${esAdmin && !pagado ? `<button class="btn-mini" data-turno-editar="${t.id}">✏️</button><button class="btn-mini peligro" data-turno-borrar="${t.id}">🗑</button>` : ''}
      </div>
      ${editando ? `
      <div class="lt-detalle" style="margin-top:6px">
        <div class="fila">
          <div class="crece"><label>Día</label><input type="date" data-te-fecha="${t.id}" value="${t.jornada}" max="${r.hoy}"></div>
          <div class="crece"><label>Rol</label><select data-te-cargo="${t.id}">${r.cargos.map(c => `<option value="${esc(c.nombre)}" ${c.nombre === t.cargo ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select></div>
        </div>
        <div class="fila" style="margin-top:6px">
          <div class="crece"><label>Valor</label><input type="text" inputmode="numeric" data-te-valor="${t.id}" value="${t.valor}"></div>
          <div class="crece"><label>Nota</label><input data-te-nota="${t.id}" value="${esc(t.nota || '')}"></div>
        </div>
        <div class="fila" style="margin-top:8px">
          <button class="btn-mini" data-te-cancelar="${t.id}">Cancelar</button>
          <button class="btn-mini ok" data-te-guardar="${t.id}">💾 Guardar</button>
        </div>
      </div>` : ''}
    </div>`;
}

function conectarBotonesTurno(cont, r) {
  cont.querySelectorAll('[data-turno-editar]').forEach(b => b.onclick = () => {
    const id = Number(b.dataset.turnoEditar);
    state.turnoEditando = state.turnoEditando === id ? null : id;
    cargarNominaDatos();
  });
  cont.querySelectorAll('[data-te-cancelar]').forEach(b => b.onclick = () => { state.turnoEditando = null; cargarNominaDatos(); });
  cont.querySelectorAll('[data-te-guardar]').forEach(b => b.onclick = async () => {
    const id = b.dataset.teGuardar;
    try {
      await api(`/turnos/${id}`, { method: 'PUT', body: {
        jornada: cont.querySelector(`[data-te-fecha="${id}"]`).value, cargo: cont.querySelector(`[data-te-cargo="${id}"]`).value,
        valor: cont.querySelector(`[data-te-valor="${id}"]`).value, nota: cont.querySelector(`[data-te-nota="${id}"]`).value
      }});
      state.turnoEditando = null;
      toast('Turno corregido');
    } catch (e) { toast(e.message, true); }
  });
  cont.querySelectorAll('[data-turno-borrar]').forEach(b => b.onclick = async () => {
    if (!confirm('¿Borrar este turno? (No se puede deshacer.)')) return;
    try { await api(`/turnos/${b.dataset.turnoBorrar}`, { method: 'DELETE' }); toast('Turno borrado'); }
    catch (e) { toast(e.message, true); }
  });
}

// --- Turnos sin pagar, por empleado, con el formulario de pago ---
function pintarSinPagar(r) {
  const cont = $('#nom-sin-pagar');
  const conDeuda = r.empleados.filter(e => e.sinPagar.length);
  if (!conDeuda.length) { cont.innerHTML = '<div class="tarjeta suave">💵 No hay turnos sin pagar. Para pagarle a alguien, primero registre arriba sus turnos (los días que vino y el rol que hizo): aquí aparecen para marcarlos y registrar el pago.</div>'; return; }
  cont.innerHTML = conDeuda.map(e => `
    <div class="tarjeta" style="border-color:var(--alerta)">
      <div class="fila"><b class="crece">💵 ${esc(e.nombre)}: ${e.sinPagar.length} turno(s) sin pagar</b><b>${fmt(e.totalSinPagar)}</b></div>
      <div class="suave" style="margin-bottom:4px">Desmarque los turnos que no entren en este pago.</div>
      ${e.sinPagar.map(t => filaTurno(t, r, { seleccionable: true })).join('')}
      <div class="fila" style="margin-top:8px">
        <div class="crece"><label>Descuento</label><input type="text" inputmode="numeric" data-pg-desc="${e.id}" placeholder="0"></div>
        <div class="crece"><label>Bono</label><input type="text" inputmode="numeric" data-pg-bono="${e.id}" placeholder="0"></div>
      </div>
      <input data-pg-concepto="${e.id}" placeholder="Concepto (opcional: motivo del bono o descuento)" autocomplete="off" style="margin-top:6px">
      <button class="btn ok" data-pagar="${e.id}" style="margin-top:8px">Pagar <span data-pg-total="${e.id}">${fmt(e.totalSinPagar)}</span> (${esc(e.nombre)} confirma en su app)</button>
    </div>`).join('');

  const totalDe = (id) => {
    let suma = 0;
    cont.querySelectorAll(`[data-pagar="${id}"]`).forEach(() => {});
    const tarjeta = cont.querySelector(`[data-pagar="${id}"]`).closest('.tarjeta');
    tarjeta.querySelectorAll('.turno-check:checked').forEach(c => { suma += Number(c.dataset.valor); });
    const t = suma - (Number(tarjeta.querySelector(`[data-pg-desc="${id}"]`).value) || 0) + (Number(tarjeta.querySelector(`[data-pg-bono="${id}"]`).value) || 0);
    cont.querySelector(`[data-pg-total="${id}"]`).textContent = fmt(t);
  };
  cont.querySelectorAll('.turno-check').forEach(c => c.onchange = () => totalDe(Number(c.closest('.tarjeta').querySelector('[data-pagar]').dataset.pagar)));
  cont.querySelectorAll('[data-pg-desc],[data-pg-bono]').forEach(i => i.oninput = () => {
    const l = i.value.replace(/[^0-9]/g, ''); if (i.value !== l) i.value = l;
    totalDe(Number(i.dataset.pgDesc || i.dataset.pgBono));
  });
  conectarBotonesTurno(cont, r);
  cont.querySelectorAll('[data-pagar]').forEach(b => b.onclick = async () => {
    const id = Number(b.dataset.pagar);
    const tarjeta = b.closest('.tarjeta');
    const ids = [...tarjeta.querySelectorAll('.turno-check:checked')].map(c => Number(c.dataset.turnoCheck));
    if (!ids.length) return toast('Marque al menos un turno para pagar', true);
    const emp = r.empleados.find(e => e.id === id);
    if (!confirm(`¿Registrar el pago de ${ids.length} turno(s) a ${emp.nombre} por ${cont.querySelector(`[data-pg-total="${id}"]`).textContent}?\n${emp.nombre} debe confirmarlo en su teléfono.`)) return;
    try {
      await api('/nomina', { method: 'POST', body: {
        empleado_id: id, turno_ids: ids,
        descuento: tarjeta.querySelector(`[data-pg-desc="${id}"]`).value || 0, bono: tarjeta.querySelector(`[data-pg-bono="${id}"]`).value || 0,
        concepto: tarjeta.querySelector(`[data-pg-concepto="${id}"]`).value
      }});
      beep(990, 0.12); vibrar(80);
      toast(`Pago registrado: ${emp.nombre} debe confirmarlo en su teléfono`);
    } catch (e) { toast(e.message, true); }
  });
}

function resumenTurnosPago(n) {
  if (!n.turnos || !n.turnos.length) return `turno ${fmt(n.valor_turno)}`;
  return `${n.turnos.length} turno(s): ${n.turnos.map(t => `${fechaCorta(t.jornada)} ${t.cargo}`).join(', ')}`;
}

function pintarPendientesNomina(r) {
  const cont = $('#nom-pendientes');
  if (!r.pendientes.length) { cont.innerHTML = ''; return; }
  const esAdmin = state.usuario.rol === 'admin';
  cont.innerHTML = `<div class="tarjeta"><b>⏳ Pendientes de confirmación por el empleado</b>
    ${r.pendientes.map(n => `
    <div class="fila suave" style="padding:6px 0;border-bottom:1px dashed var(--borde)">
      <span class="crece"><b>${esc(n.empleado)}</b> · ${esc(resumenTurnosPago(n))}${n.concepto ? ` · <em>${esc(n.concepto)}</em>` : ''}</span>
      <b>${fmt(n.total)}</b>
      ${esAdmin || (state.usuario.rol === 'cajero' && n.empleado_rol === 'cocinera') ? `<button class="btn-mini ok" data-nomina-conf="${n.id}">✓</button>` : ''}
      ${esAdmin ? `<button class="btn-mini peligro" data-pago-borrar="${n.id}">🗑</button>` : ''}
    </div>`).join('')}</div>`;
  cont.querySelectorAll('[data-nomina-conf]').forEach(b => b.onclick = async () => {
    if (!confirm('¿Confirmar este pago en nombre del empleado? (para quien no usa la app)')) return;
    try { await api(`/nomina/${b.dataset.nominaConf}/confirmar`, { method: 'POST' }); toast('Pago confirmado'); }
    catch (e) { toast(e.message, true); }
  });
  conectarBorrarPago(cont);
}

function conectarBorrarPago(cont) {
  cont.querySelectorAll('[data-pago-borrar]').forEach(b => b.onclick = async () => {
    if (!confirm('¿Borrar este pago?\nSus turnos vuelven a quedar SIN PAGAR (no se pierden) y el dinero deja de contarse como salido de la caja ese día.')) return;
    try { await api(`/nomina/${b.dataset.pagoBorrar}`, { method: 'DELETE' }); toast('Pago borrado: sus turnos quedaron sin pagar'); }
    catch (e) { toast(e.message, true); }
  });
  cont.querySelectorAll('[data-pago-editar]').forEach(b => b.onclick = async () => {
    const id = b.dataset.pagoEditar;
    const n = (state.nominaDatos.pagosMes || []).find(x => x.id === Number(id)) || (state.nominaDatos.pendientes || []).find(x => x.id === Number(id));
    const desc = prompt('Descuento:', n ? n.descuento : 0); if (desc === null) return;
    const bono = prompt('Bono:', n ? n.bono : 0); if (bono === null) return;
    const concepto = prompt('Concepto:', n ? (n.concepto || '') : ''); if (concepto === null) return;
    try { const x = await api(`/nomina/${id}`, { method: 'PUT', body: { descuento: desc, bono, concepto } }); toast(`Pago corregido: total ${fmt(x.total)}`); }
    catch (e) { toast(e.message, true); }
  });
}

// --- Historial del mes: días trabajados y pagos ---
function pintarHistorialNomina(r) {
  const cont = $('#nom-historial');
  const esAdmin = state.usuario.rol === 'admin';
  const porEmpleado = new Map();
  for (const t of r.turnosMes) { if (!porEmpleado.has(t.empleado)) porEmpleado.set(t.empleado, []); porEmpleado.get(t.empleado).push(t); }
  const turnosHtml = porEmpleado.size ? [...porEmpleado.entries()].map(([nombre, lista]) => `
    <div style="margin-top:8px"><b>${esc(nombre)}</b> <span class="suave">· ${lista.length} día(s) · ${fmt(lista.reduce((s, t) => s + t.valor, 0))}</span></div>
    ${lista.map(t => filaTurno(t, r, { conEstado: true })).join('')}`).join('')
    : '<div class="suave">Sin turnos registrados este mes.</div>';
  const pagosHtml = r.pagosMes.length ? r.pagosMes.map(n => `
    <div class="fila" style="padding:6px 0;border-bottom:1px dashed var(--borde)">
      <span class="crece"><b>${fechaCorta(n.jornada)}</b> · ${esc(n.empleado)} <span class="suave">· ${esc(resumenTurnosPago(n))}${n.descuento ? ` · desc. -${fmt(n.descuento)}` : ''}${n.bono ? ` · bono +${fmt(n.bono)}` : ''}${n.concepto ? ` · ${esc(n.concepto)}` : ''}</span></span>
      <b style="white-space:nowrap">${fmt(n.total)}</b>
      <span class="chip ${n.estado === 'confirmado' ? 'pagado' : n.estado === 'anulado' ? '' : 'porcobrar'}">${n.estado}</span>
      ${esAdmin ? `<button class="btn-mini" data-pago-editar="${n.id}">✏️</button><button class="btn-mini peligro" data-pago-borrar="${n.id}">🗑</button>` : ''}
    </div>`).join('') : '<div class="suave">Sin pagos este mes.</div>';
  cont.innerHTML = `
    <div class="suave" style="font-weight:700;margin-top:4px">📆 Días trabajados</div>${turnosHtml}
    <div class="suave" style="font-weight:700;margin-top:12px">💵 Pagos</div>${pagosHtml}`;
  conectarBotonesTurno(cont, r);
  conectarBorrarPago(cont);
}

function pintarTotalesNomina(r) {
  $('#nom-totales').innerHTML = `
    <b>Totales pagados (confirmados)</b>
    <div style="overflow-x:auto;margin-top:6px"><table>
      <tr><th>Empleado</th><th class="num">Hoy</th><th class="num">Semana</th><th class="num">Quincena</th><th class="num">Mes</th><th class="num">Sin pagar</th></tr>
      ${r.empleados.map(e => `
      <tr><td>${esc(e.nombre)}</td><td class="num">${fmt(e.dia)}</td><td class="num">${fmt(e.semana)}</td>
      <td class="num">${fmt(e.quincena)}</td><td class="num">${fmt(e.mes)}</td><td class="num" style="${e.totalSinPagar ? 'color:var(--alerta);font-weight:700' : ''}">${fmt(e.totalSinPagar)}</td></tr>`).join('')}
    </table></div>`;
}

async function cargarResumenDia() {
  try {
    const r = await api('/reportes/dia');
    const cont = $('#resumen-dia');
    if (!cont) return;
    cont.innerHTML = `
      <div class="fila"><span>🍛 Almuerzos completos (${r.numAlmuerzos})</span><span class="der grande" style="font-size:16px">${fmt(r.totalAlmuerzos)}</span></div>
      <div class="fila suave"><span>🧃 Extras vendidos</span><span class="der">${fmt(r.totalExtras)}</span></div>
      <div class="fila"><span><b>Total general</b> (${r.numPedidos} pedidos)</span><span class="der grande" style="font-size:16px">${fmt(r.totalVentas)}</span></div>
      ${(r.porGrupo || []).length ? `<hr class="sep">
        <div class="suave" style="margin-bottom:4px">🍗 Almuerzos por tipo (para las compras)</div>
        ${r.porGrupo.map(g => `<div class="fila suave"><span>${esc(g.grupo)}</span>
          <span class="der"><b>${g.cantidad}</b>${g.solos ? ` (${g.solos} sin entrada)` : ''}</span></div>`).join('')}` : ''}
      ${(r.porPlato || []).some(p => p.tipo === 'proteina_dia' || p.tipo === 'proteina_especial') ? `<hr class="sep">
        <div class="suave" style="margin-bottom:4px">🍽️ Platos vendidos hoy</div>
        ${r.porPlato.filter(p => p.tipo === 'proteina_dia' || p.tipo === 'proteina_especial')
          .map(p => `<div class="fila suave"><span>${esc(p.nombre)}${p.grupo ? ` <span class="chip">${esc(p.grupo)}</span>` : ''}</span>
            <span class="der"><b>${p.cantidad}</b></span></div>`).join('')}` : ''}
      <hr class="sep">
      <div class="fila suave"><span>Cobrado</span><span class="der">${fmt(r.totalCobrado)}</span></div>
      <div class="fila suave"><span>Domicilios cobrados</span><span class="der">${fmt(r.totalRecargos)}</span></div>
      <div class="fila suave"><span>Cancelados (${r.numCancelados})</span><span class="der">${fmt(r.totalCancelado)}</span></div>
      <hr class="sep">
      ${Object.entries(r.porMetodo).map(([m, v]) => {
        const a = (r.almuerzosPorMetodo || {})[m] || { cantidad: 0, aproximado: false };
        const ajustado = (r.ajustados || {})[m];
        return `<div class="fila suave"><span>${METODOS[m] || m}${ajustado ? ' <span class="chip llevar">TOTAL CORREGIDO</span>' : ''}</span>
          <span class="der">${fmt(v)}</span></div>
          <div class="fila suave" style="font-size:12px;padding-left:12px"><span>${a.cantidad} almuerzo(s)${a.aproximado ? ' · <b style="color:var(--alerta)">APROXIMADO</b>' : ''}${ajustado ? ` · pago a pago sumaba ${fmt((r.porMetodoRegistrado || {})[m] || 0)}` : ''}</span></div>`;
      }).join('') || '<div class="suave">Sin pagos aún</div>'}
      <hr class="sep">
      ${Object.entries(r.porVendedor).map(([v, d]) =>
        `<div class="fila suave"><span>👤 ${esc(v)} (${d.pedidos} pedidos)</span><span class="der">${fmt(d.total)}</span></div>`).join('')}
      <hr class="sep">
      <div class="fila suave"><span>💵 Base de caja (inicio del día)</span><span class="der">${fmt(r.baseCaja ? r.baseCaja.valor : 0)}</span></div>
      <div class="fila suave"><span>+ Ventas en efectivo</span><span class="der">${fmt(r.ventasEfectivo || 0)}</span></div>
      <div class="fila suave"><span>💸 − Gastos del local</span><span class="der">-${fmt(r.totalGastos)}</span></div>
      <div class="fila suave"><span>👥 − Nómina pagada</span><span class="der">-${fmt(r.totalNomina)}</span></div>
      ${r.totalRecargoTarjeta ? `<div class="fila suave"><span>Recargos tarjeta cobrados</span><span class="der">${fmt(r.totalRecargoTarjeta)}</span></div>` : ''}
      <div class="fila" style="font-weight:800"><span>= Efectivo esperado en caja</span><span class="der">${fmt(r.efectivoEsperado)}</span></div>`;
    // La tarjeta de base de caja de arriba se llena con el mismo resumen
    const b = r.baseCaja || { valor: 0, origen: 'ninguna' };
    if ($('#base-actual')) $('#base-actual').textContent = fmt(b.valor);
    if ($('#base-origen')) {
      const texto = {
        registrada: `Registrado hoy${b.usuario ? ` por ${b.usuario}` : ''}`,
        contado_anterior: `Lo que contó el cajero en el cierre del ${b.jornadaOrigen}`,
        esperado_anterior: `Según el sistema al cierre del ${b.jornadaOrigen} (ese día no se contó el efectivo)`,
        ninguna: 'No hay cierre anterior: se asume que se arrancó en $0'
      }[b.origen] || '';
      const aviso = b.incierta && b.diasSinCierre && b.diasSinCierre.length
        ? `<br><b style="color:var(--alerta)">⚠️ ${b.diasSinCierre.join(', ')} tuvo(tuvieron) ventas sin cierre: ese efectivo no está contado. Cuente la caja y registre la base.</b>`
        : '';
      $('#base-origen').innerHTML = esc(texto) + aviso;
    }
  } catch { /* la vista pudo cambiar */ }
}

// ---------------- Vista: menú ----------------
const TIPOS_UI = [
  ['entrada', '🥣 Entradas (incluidas en el almuerzo)'],
  ['proteina_dia', '🍗 Proteínas del día (precio del almuerzo completo)'],
  ['proteina_especial', '⭐ Especiales (precio propio, no llevan principio)'],
  ['bebida', '🥤 Bebidas incluidas (del almuerzo)'],
  ['extra', '🧃 Extras (se cobran aparte)']
];
const OPCIONES_TIPO = [
  ['entrada', 'Entrada'], ['proteina_dia', 'Proteína del día'],
  ['proteina_especial', 'Especial'], ['bebida', 'Bebida incluida'], ['extra', 'Extra']
];

// Tipos de plato para el reporte de compras (pollo, carne, cerdo...).
// En la base se llaman "grupo" para no chocar con el tipo de estructura.
function gruposPlato() { return (state.config && state.config.grupos_plato) || []; }
function preciosDefault() {
  return (state.config && state.config.precios_default) ||
    { proteina_dia: { precio: 0, solo: 0 }, proteina_especial: { precio: 0, solo: 0 }, entrada: { precio: 0, solo: 0 } };
}
// El tipo para el reporte de compras (pollo, carne...) es solo de proteínas;
// el precio por defecto también lo tienen las entradas (la sopa vendida sola)
const LLEVA_GRUPO = (tipo) => tipo === 'proteina_dia' || tipo === 'proteina_especial';
const TIENE_DEFAULT = (tipo) => !!preciosDefault()[tipo];
// Cómo se lee el precio por defecto de cada clase
function textoDefault(tipo) {
  const def = preciosDefault()[tipo];
  if (!def) return '';
  return tipo === 'entrada'
    ? `${fmt(def.solo)} vendida sola · incluida en el almuerzo`
    : `${fmt(def.precio)} con entrada · ${fmt(def.solo)} solo`;
}
const MAX_LISTA_MENU = 40; // con ~150 proteínas, pintarlas todas hace lenta la pestaña

function selectGrupos(id, sel) {
  return `<select id="${id}">
    <option value="">— sin tipo —</option>
    ${gruposPlato().map(g => `<option value="${esc(g)}" ${g === sel ? 'selected' : ''}>${esc(g)}</option>`).join('')}
  </select>`;
}

function renderMenu() {
  const pd = preciosDefault();
  const q = normalizar(state.busquedaMenu);
  // La clase/tipo del formulario vive en el estado: así cargar 150 platos
  // seguidos no obliga a re-elegirlos, ni siquiera cuando otro teléfono
  // cambia el menú y esta pestaña se vuelve a dibujar sola.
  const nuevo = state.nuevoPlato || (state.nuevoPlato = { tipo: 'proteina_dia', grupo: '', usaDefault: true });
  // Guardar la posición: al asignar tipos en fila, el menú se redibuja solo y
  // saltar al principio de la lista cada vez sería insufrible
  const zona = document.querySelector('main');
  const scrollPrevio = zona ? zona.scrollTop : 0;
  const nSinDefault = (tipo) => state.platos.filter(p => p.tipo === tipo && !p.usa_default).length;

  $('#vista').innerHTML = `
    <h2>Menú del día</h2>
    <input id="buscar-menu" class="input-buscar buscador-pegado" type="search"
      placeholder="🔎 Buscar entre ${state.platos.length} platos (nombre, acrónimo o tipo)"
      value="${esc(state.busquedaMenu)}" autocomplete="off" autocorrect="off">
    <div class="tarjeta">
      <h3 style="margin-top:0">Agregar plato</h3>
      <input id="np-nombre" placeholder="Nombre del plato" autocomplete="off">
      <input id="np-acronimo" placeholder="Acrónimo para la comanda (opcional, ej: CREMA)" autocomplete="off" style="margin-top:8px">
      <div class="fila" style="margin-top:8px">
        <div class="crece"><label>Clase</label>
          <select id="np-tipo">
            ${OPCIONES_TIPO.map(([v, n]) => `<option value="${v}" ${v === nuevo.tipo ? 'selected' : ''}>${n}</option>`).join('')}
          </select></div>
        <div class="crece" id="np-grupo-caja"><label>Tipo (para compras)</label>${selectGrupos('np-grupo', nuevo.grupo)}</div>
      </div>
      <label class="check-linea" id="np-default-caja">
        <input type="checkbox" id="np-default" ${nuevo.usaDefault ? 'checked' : ''}>
        <span>Usar el precio por defecto (<b id="np-default-txt"></b>) — no hay que escribir precio</span>
      </label>
      <div class="fila" id="np-precios" style="margin-top:8px">
        <div class="crece"><label>Precio con entrada</label>
          <input id="np-precio" type="number" inputmode="numeric" placeholder="Ej: 17500"></div>
        <div class="crece"><label>Precio vendido solo</label>
          <input id="np-solo" type="number" inputmode="numeric" placeholder="Ej: 17000"></div>
      </div>
      <button class="btn" id="btn-nuevo-plato" style="margin-top:10px">Agregar al menú</button>
    </div>

    <div class="tarjeta">
      <h3 style="margin-top:0">💲 Precio del almuerzo (por defecto)</h3>
      <div class="suave">Casi todas las proteínas valen lo mismo y cambia cada año: cámbielo aquí una vez y todos los platos marcados con "precio por defecto" quedan actualizados. Las ventas ya registradas no se tocan.</div>
      <div class="fila" style="margin-top:8px">
        <div class="crece"><label>🍗 Del día, con entrada</label>
          <input id="pd-dia-entrada" type="number" inputmode="numeric" value="${pd.proteina_dia.precio || ''}"></div>
        <div class="crece"><label>🍗 Del día, solo</label>
          <input id="pd-dia-solo" type="number" inputmode="numeric" value="${pd.proteina_dia.solo || ''}"></div>
      </div>
      <div class="fila" style="margin-top:8px">
        <div class="crece"><label>⭐ Especial, con entrada</label>
          <input id="pd-esp-entrada" type="number" inputmode="numeric" value="${pd.proteina_especial.precio || ''}"></div>
        <div class="crece"><label>⭐ Especial, solo</label>
          <input id="pd-esp-solo" type="number" inputmode="numeric" value="${pd.proteina_especial.solo || ''}"></div>
      </div>
      <label>🥣 Entrada vendida sola (ej: piden solo una sopa)</label>
      <input id="pd-entrada-sola" type="number" inputmode="numeric" value="${(pd.entrada || {}).solo || ''}"
        placeholder="Ej: 7500 — dentro del almuerzo va incluida">
      <button class="btn-mini ok" id="btn-precios-default" style="margin-top:10px">💾 Guardar precios</button>
      ${nSinDefault('proteina_dia') ? `<button class="btn-mini" data-aplicar="proteina_dia" style="margin-top:8px;width:100%">
        Poner el precio por defecto a las ${nSinDefault('proteina_dia')} proteínas del día que tienen precio propio</button>` : ''}
      ${nSinDefault('proteina_especial') ? `<button class="btn-mini" data-aplicar="proteina_especial" style="margin-top:6px;width:100%">
        Poner el precio por defecto a los ${nSinDefault('proteina_especial')} especiales con precio propio</button>` : ''}
      ${nSinDefault('entrada') ? `<button class="btn-mini" data-aplicar="entrada" style="margin-top:6px;width:100%">
        Poner el precio por defecto a las ${nSinDefault('entrada')} entradas con precio propio</button>` : ''}
    </div>

    <div class="tarjeta">
      <h3 style="margin-top:0">🏷️ Tipos de plato (para saber qué comprar)</h3>
      <div class="suave">Ej: "pollo a la jardinera" es del tipo <b>Pollo</b>, "chuleta" es <b>Cerdo</b>. El reporte dice cuántos almuerzos se vendieron de cada tipo.</div>
      <div class="chips" style="margin-top:8px">${gruposPlato().map(g =>
        `<button class="chip-nota" data-grupo-borrar="${esc(g)}">${esc(g)} ✕</button>`).join('') || '<span class="suave">No hay tipos aún</span>'}</div>
      <div class="fila" style="margin-top:8px">
        <input id="grupo-nuevo" placeholder="Nuevo tipo (ej: Pescado)" style="flex:2" autocomplete="off">
        <button class="btn-mini ok" id="btn-grupo-agregar" style="flex:1">Agregar</button>
      </div>
    </div>

    <div class="tarjeta">
      <h3 style="margin-top:0">⚡ Cambios rápidos (notas de 1 toque en el ticket)</h3>
      <div class="chips">${chipsNotas().map(c =>
        `<button class="chip-nota" data-chip-borrar="${esc(c)}">${esc(c)} ✕</button>`).join('') || '<span class="suave">No hay cambios rápidos aún</span>'}</div>
      <div class="fila" style="margin-top:8px">
        <input id="chip-nuevo" placeholder="Nuevo (ej: Sin cebolla)" style="flex:2" autocomplete="off">
        <button class="btn-mini ok" id="btn-chip-agregar" style="flex:1">Agregar</button>
      </div>
    </div>

    ${TIPOS_UI.map(([tipo, titulo]) => seccionMenu(tipo, titulo)).join('')}`;

  function tarjetaPlato(p) {
    return `
      <div class="tarjeta ${p.disponible ? '' : 'plato-oculto'}">
        <div class="fila">
          <div class="crece">
            <div class="plato-nombre">${esc(p.nombre)}
              ${p.disponible ? '' : '<span class="chip">OCULTO</span>'}
              ${p.grupo ? `<span class="chip">${esc(p.grupo)}</span>` : ''}</div>
            <div class="plato-precio">${p.precio ? fmt(p.precio) : 'Incluido'}${p.precio_solo ? ` · solo ${fmt(p.precio_solo)}` : ''}${p.usa_default ? ' · por defecto' : ''}${p.acronimo ? ` · 🖨 ${esc(p.acronimo)}` : ''}</div>
          </div>
          <button class="btn-mini ${p.disponible ? '' : 'ok'}" data-visible="${p.id}">
            ${p.disponible ? '🚫 Ocultar' : '👁 Mostrar'}</button>
          <button class="btn-mini primario" data-editar-plato="${p.id}">✏️</button>
          <button class="btn-mini peligro" data-borrar="${p.id}">🗑</button>
        </div>
        ${LLEVA_GRUPO(p.tipo) && gruposPlato().length ? `
        <div class="fila" style="margin-top:6px">
          <span class="suave">Tipo:</span>
          <select data-grupo-de="${p.id}" style="flex:1">
            <option value="">— sin tipo —</option>
            ${gruposPlato().map(g => `<option value="${esc(g)}" ${g === p.grupo ? 'selected' : ''}>${esc(g)}</option>`).join('')}
          </select>
        </div>` : ''}
        ${state.editandoPlatoId === p.id ? `
        <div class="lt-detalle" style="border-top:1px dashed var(--borde);margin-top:8px">
          <label>Nombre</label>
          <input id="ep-nombre" value="${esc(p.nombre)}" autocomplete="off">
          <div class="fila" style="margin-top:8px">
            <div class="crece"><label>Clase</label>
              <select id="ep-tipo">
                ${OPCIONES_TIPO.map(([v, n]) => `<option value="${v}" ${p.tipo === v ? 'selected' : ''}>${n}</option>`).join('')}
              </select></div>
            <div class="crece"><label>Tipo (para compras)</label>${selectGrupos('ep-grupo', p.grupo || '')}</div>
          </div>
          ${TIENE_DEFAULT(p.tipo) ? `<label class="check-linea">
            <input type="checkbox" id="ep-default" ${p.usa_default ? 'checked' : ''}>
            <span>Usar el precio por defecto (${esc(textoDefault(p.tipo))})</span>
          </label>` : ''}
          <div class="fila" style="margin-top:8px">
            <div class="crece"><label>Precio (en almuerzo)</label>
              <input id="ep-precio" type="number" inputmode="numeric" value="${p.precio}"></div>
            <div class="crece"><label>Precio vendido SOLO</label>
              <input id="ep-solo" type="number" inputmode="numeric" value="${p.precio_solo || ''}" placeholder="vacío = no se vende suelto"></div>
          </div>
          <label>Acrónimo para la comanda (vacío = nombre completo)</label>
          <input id="ep-acronimo" value="${esc(p.acronimo || '')}" placeholder="Ej: CREMA" autocomplete="off">
          <div class="fila" style="margin-top:10px">
            <button class="btn-mini" id="ep-cancelar">Cancelar</button>
            <button class="btn-mini ok" id="ep-guardar">💾 Guardar cambios</button>
          </div>
        </div>` : ''}
      </div>`;
  }

  // Un plato coincide por nombre, por acrónimo o por su tipo de compras:
  // escribir "pollo" saca todos los de pollo aunque no lo lleven en el nombre
  function coincide(p) {
    return !q || normalizar(p.nombre).includes(q) || normalizar(p.acronimo).includes(q) || normalizar(p.grupo).includes(q);
  }

  function recorte(lista) {
    if (lista.length <= MAX_LISTA_MENU) return lista.map(tarjetaPlato).join('');
    return lista.slice(0, MAX_LISTA_MENU).map(tarjetaPlato).join('') +
      `<div class="tarjeta suave">…y ${lista.length - MAX_LISTA_MENU} más. Use el buscador para encontrarlos.</div>`;
  }

  // Las proteínas se separan por tipo (Pollo, Carne, Cerdo...). Con muchas,
  // los tipos arrancan plegados: se ve la lista de tipos con su cantidad y se
  // abre el que interese, en vez de desplazarse por 150 platos.
  function seccionMenu(tipo, titulo) {
    const filtrados = state.platos.filter(p => p.tipo === tipo && coincide(p));
    if (!filtrados.length) return '';
    const cabecera = `<h3>${titulo} (${filtrados.length})</h3>`;
    if (!LLEVA_GRUPO(tipo)) return cabecera + recorte(filtrados);

    const porGrupo = new Map();
    for (const p of filtrados) {
      const g = p.grupo || 'Sin tipo';
      if (!porGrupo.has(g)) porGrupo.set(g, []);
      porGrupo.get(g).push(p);
    }
    // En el orden en que están configurados los tipos; "Sin tipo" de último
    const orden = [...gruposPlato(), 'Sin tipo'];
    const claves = [...porGrupo.keys()].sort((a, b) => {
      const ia = orden.indexOf(a), ib = orden.indexOf(b);
      return (ia < 0 ? 998 : ia) - (ib < 0 ? 998 : ib) || a.localeCompare(b);
    });
    // Buscando, todo abierto: lo que se busca es ver los resultados
    const plegar = !q && filtrados.length > 25 && claves.length > 1;
    return cabecera + claves.map(g => {
      const lista = porGrupo.get(g);
      const clave = tipo + '|' + g;
      const abierto = !plegar || !!state.gruposAbiertos[clave];
      return `<button class="grupo-cab" data-grupo-toggle="${esc(clave)}">
          <span>${plegar ? (abierto ? '▾' : '▸') + ' ' : ''}${esc(g)}</span>
          <span class="chip">${lista.length}</span></button>` +
        (abierto ? recorte(lista) : '');
    }).join('');
  }

  // El tipo de compras y el precio por defecto solo aplican a proteínas
  const sincronizarFormNuevo = (cambioDeClase) => {
    nuevo.tipo = $('#np-tipo').value;
    nuevo.grupo = $('#np-grupo') ? $('#np-grupo').value : '';
    const lleva = LLEVA_GRUPO(nuevo.tipo);
    const conDefault = TIENE_DEFAULT(nuevo.tipo);
    // Al cambiar de clase, el precio por defecto vuelve a quedar marcado si esa
    // clase lo tiene. Antes, pasar por una clase sin defecto lo dejaba
    // desmarcado para siempre y volvía a pedir el precio de cada almuerzo.
    if (cambioDeClase) $('#np-default').checked = conDefault;
    else if (!conDefault) $('#np-default').checked = false;
    nuevo.usaDefault = $('#np-default').checked;
    $('#np-grupo-caja').style.display = lleva ? '' : 'none';
    $('#np-default-caja').style.display = conDefault ? '' : 'none';
    if (conDefault) $('#np-default-txt').textContent = textoDefault(nuevo.tipo);
    $('#np-precios').style.display = nuevo.usaDefault ? 'none' : '';
  };
  $('#np-tipo').onchange = () => sincronizarFormNuevo(true);
  $('#np-default').onchange = () => sincronizarFormNuevo(false);
  if ($('#np-grupo')) $('#np-grupo').onchange = () => sincronizarFormNuevo(false);
  sincronizarFormNuevo(false);
  if (zona) zona.scrollTop = scrollPrevio;
  // Tras agregar un plato el menú se redibuja solo: hay que devolver el cursor
  if (state.enfocarNuevoPlato) { state.enfocarNuevoPlato = false; $('#np-nombre').focus(); }

  $('#buscar-menu').oninput = (e) => {
    state.busquedaMenu = e.target.value;
    clearTimeout(renderMenu._t);
    renderMenu._t = setTimeout(() => {
      const foco = document.activeElement === $('#buscar-menu');
      renderMenu();
      if (foco && $('#buscar-menu')) {
        const inp = $('#buscar-menu');
        inp.focus();
        inp.setSelectionRange(inp.value.length, inp.value.length);
      }
    }, 180);
  };

  $('#btn-nuevo-plato').onclick = async () => {
    // Se abre el tipo ANTES de guardar: al volver el servidor, el menú se
    // redibuja solo y el plato nuevo tiene que quedar a la vista
    if (LLEVA_GRUPO(nuevo.tipo)) state.gruposAbiertos[`${nuevo.tipo}|${nuevo.grupo || 'Sin tipo'}`] = true;
    try {
      await api('/platos', { method: 'POST', body: {
        nombre: $('#np-nombre').value, precio: $('#np-precio').value || 0, tipo: $('#np-tipo').value,
        precio_solo: $('#np-solo').value, acronimo: $('#np-acronimo').value,
        grupo: $('#np-grupo') ? $('#np-grupo').value : '', usa_default: $('#np-default').checked
      }});
      toast('Plato agregado; visible en todos los teléfonos');
      // El formulario queda listo para el siguiente (se cargan de a 150)
      $('#np-nombre').value = ''; $('#np-acronimo').value = '';
      state.enfocarNuevoPlato = true;
      $('#np-nombre').focus();
    } catch (e) { toast(e.message, true); }
  };
  // Enter agrega el plato: cargar el menú de la semana es escribir y dar Enter
  for (const sel of ['#np-nombre', '#np-acronimo']) {
    $(sel).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#btn-nuevo-plato').click(); } };
  }
  $('#btn-precios-default').onclick = async () => {
    try {
      const r = await api('/precios-default', { method: 'PUT', body: {
        precio_dia_entrada: $('#pd-dia-entrada').value || 0, precio_dia_solo: $('#pd-dia-solo').value || 0,
        precio_especial_entrada: $('#pd-esp-entrada').value || 0, precio_especial_solo: $('#pd-esp-solo').value || 0,
        precio_entrada_sola: $('#pd-entrada-sola').value || 0
      }});
      state.config.precios_default = r.precios;
      toast('Precios guardados: aplican a todos los platos con precio por defecto');
    } catch (e) { toast(e.message, true); }
  };
  $('#vista').querySelectorAll('[data-aplicar]').forEach(b => b.onclick = async () => {
    const tipo = b.dataset.aplicar;
    const def = preciosDefault()[tipo];
    const afectados = state.platos.filter(p => p.tipo === tipo && !p.usa_default);
    // Aviso explícito de los que HOY valen otra cosa (ej: la bandeja paisa):
    // esos son los que cambiarían de precio sin querer. En las entradas lo que
    // cambia es el precio de venderlas solas.
    const propio = (p) => tipo === 'entrada' ? (p.precio_solo || 0) : p.precio;
    const esperado = tipo === 'entrada' ? def.solo : def.precio;
    const distintos = afectados.filter(p => propio(p) !== esperado);
    const aviso = distintos.length
      ? `\n\n⚠️ OJO: ${distintos.length} tienen hoy otro precio y pasarían a ${fmt(esperado)}:\n` +
        distintos.slice(0, 8).map(p => `  · ${p.nombre} (${fmt(propio(p))})`).join('\n') +
        (distintos.length > 8 ? `\n  · ...y ${distintos.length - 8} más` : '') +
        '\n\nSi alguno debe conservar su precio, cancele y desmárquelo después con ✏️.'
      : '';
    if (!confirm(`¿Poner el precio por defecto (${textoDefault(tipo)}) a ${afectados.length} plato(s)?${aviso}`)) return;
    try {
      const r = await api('/platos/aplicar-default', { method: 'POST', body: { tipo } });
      toast(`${r.cambiados} plato(s) quedaron con el precio por defecto`);
    } catch (e) { toast(e.message, true); }
  });
  $('#btn-grupo-agregar').onclick = async () => {
    const v = $('#grupo-nuevo').value.trim();
    if (!v) return;
    try {
      const r = await api('/grupos', { method: 'PUT', body: { grupos: [...gruposPlato(), v] } });
      state.config.grupos_plato = r.grupos;
      toast('Tipo agregado en todos los teléfonos');
      renderMenu();
    } catch (e) { toast(e.message, true); }
  };
  $('#vista').querySelectorAll('[data-grupo-borrar]').forEach(b => b.onclick = async () => {
    const g = b.dataset.grupoBorrar;
    const usados = state.platos.filter(p => p.grupo === g).length;
    if (!confirm(`¿Quitar el tipo "${g}"?${usados ? `\n${usados} plato(s) lo tienen asignado y quedarán sin tipo en los reportes nuevos.` : ''}`)) return;
    try {
      const r = await api('/grupos', { method: 'PUT', body: { grupos: gruposPlato().filter(x => x !== g) } });
      state.config.grupos_plato = r.grupos;
      renderMenu();
    } catch (e) { toast(e.message, true); }
  });
  $('#btn-chip-agregar').onclick = async () => {
    const v = $('#chip-nuevo').value.trim();
    if (!v) return;
    try { await api('/chips', { method: 'PUT', body: { chips: [...chipsNotas(), v] } }); toast('Cambio rápido agregado en todos los teléfonos'); }
    catch (e) { toast(e.message, true); }
  };
  $('#vista').querySelectorAll('[data-chip-borrar]').forEach(b => b.onclick = async () => {
    const c = b.dataset.chipBorrar;
    if (!confirm(`¿Quitar el cambio rápido "${c}"?`)) return;
    try { await api('/chips', { method: 'PUT', body: { chips: chipsNotas().filter(x => x !== c) } }); toast('Cambio rápido eliminado'); }
    catch (e) { toast(e.message, true); }
  });
  $('#vista').querySelectorAll('[data-visible]').forEach(b => b.onclick = async () => {
    const p = state.platos.find(x => x.id === Number(b.dataset.visible));
    try {
      await api(`/platos/${p.id}`, { method: 'PUT', body: { disponible: !p.disponible } });
      toast(p.disponible ? `"${p.nombre}" oculto: ya no aparece al tomar pedidos` : `"${p.nombre}" visible de nuevo`);
    } catch (e) { toast(e.message, true); }
  });
  $('#vista').querySelectorAll('[data-editar-plato]').forEach(b => b.onclick = () => {
    const id = Number(b.dataset.editarPlato);
    state.editandoPlatoId = state.editandoPlatoId === id ? null : id;
    renderMenu();
  });
  // Abrir/cerrar un tipo de proteína en la lista
  $('#vista').querySelectorAll('[data-grupo-toggle]').forEach(b => b.onclick = () => {
    const clave = b.dataset.grupoToggle;
    state.gruposAbiertos[clave] = !state.gruposAbiertos[clave];
    renderMenu();
  });
  // Asignar el tipo desde la misma lista: son ~150 proteínas por clasificar
  $('#vista').querySelectorAll('[data-grupo-de]').forEach(sel => sel.onchange = async () => {
    try { await api(`/platos/${sel.dataset.grupoDe}`, { method: 'PUT', body: { grupo: sel.value } }); }
    catch (e) { toast(e.message, true); }
  });
  if ($('#ep-guardar')) $('#ep-guardar').onclick = async () => {
    try {
      await api(`/platos/${state.editandoPlatoId}`, { method: 'PUT', body: {
        nombre: $('#ep-nombre').value, precio: $('#ep-precio').value || 0, tipo: $('#ep-tipo').value,
        precio_solo: $('#ep-solo').value, acronimo: $('#ep-acronimo').value,
        grupo: $('#ep-grupo') ? $('#ep-grupo').value : '',
        usa_default: $('#ep-default') ? $('#ep-default').checked : false
      }});
      state.editandoPlatoId = null;
      toast('Plato actualizado en todos los teléfonos');
    } catch (e) { toast(e.message, true); }
  };
  if ($('#ep-cancelar')) $('#ep-cancelar').onclick = () => { state.editandoPlatoId = null; renderMenu(); };
  $('#vista').querySelectorAll('[data-borrar]').forEach(b => b.onclick = async () => {
    const p = state.platos.find(x => x.id === Number(b.dataset.borrar));
    if (!confirm(`¿Eliminar "${p.nombre}" del catálogo definitivamente?\n(Si el plato vuelve otro día, mejor use "Ocultar")`)) return;
    try { await api(`/platos/${p.id}`, { method: 'DELETE' }); toast('Plato eliminado'); }
    catch (e) { toast(e.message, true); }
  });
}

// ---------------- Vista: estación de impresión (teléfono puente) ----------------
function renderImpresora() {
  const imp = state.impresion;
  const est = state.estacion;
  $('#vista').innerHTML = `
    <h2>Impresión</h2>
    <div class="tarjeta">
      <div class="fila">
        <span><span class="estado-punto ${imp.puenteConectado || imp.modo !== 'puente' ? 'on' : 'off'}"></span>
        Modo actual: <b>${esc(nombreModo(imp.modo))}</b></span>
      </div>
      ${imp.modo === 'puente' ? `<div class="suave" style="margin-top:6px">
        ${imp.puenteConectado ? 'Hay una estación de impresión activa.' : 'Nadie tiene activa la estación: las comandas quedan en cola.'}</div>` : ''}
    </div>
    ${state.usuario.rol === 'admin' ? '<div id="cfg-tamanos"></div>' : ''}

    ${imp.modo === 'puente' ? `
    <div class="tarjeta">
      <h3 style="margin-top:0">📡 Usar ESTE teléfono como estación de impresión</h3>
      <div class="suave">Este teléfono debe estar emparejado con la impresora Bluetooth y quedarse con la app abierta.</div>
      <label>Vía de impresión</label>
      <select id="sel-via">
        <option value="rawbt" ${est.via === 'rawbt' ? 'selected' : ''}>App RawBT (impresoras Bluetooth clásicas - recomendado)</option>
        <option value="ble" ${est.via === 'ble' ? 'selected' : ''}>Web Bluetooth (solo impresoras BLE, Chrome Android)</option>
      </select>
      ${est.via === 'ble' ? `
        <button class="btn gris" id="btn-ble" style="margin-top:8px">
          ${est.bleChar ? `✅ Conectada: ${esc(est.bleNombre)}` : '🔗 Conectar impresora BLE'}</button>` : `
        <div class="suave" style="margin-top:8px">Instale la app gratuita <b>RawBT</b> desde Play Store y vincule allí la impresora. Los tickets se enviarán a RawBT automáticamente.</div>`}
      <button class="btn ${est.activa ? 'peligro' : 'ok'}" id="btn-activar" style="margin-top:10px">
        ${est.activa ? '⏹ Desactivar estación en este teléfono' : '▶️ Activar estación en este teléfono'}</button>
    </div>` : ''}

    <h3>Cola de impresión</h3>
    ${(imp.trabajos || []).some(t => t.estado !== 'impreso') ? `
      <button class="btn-mini peligro" id="btn-descartar-todo" style="margin-bottom:8px">
        🧹 Descartar todo lo no impreso (${(imp.trabajos || []).filter(t => t.estado !== 'impreso').length})</button>` : ''}
    ${(imp.trabajos || []).slice(0, 15).map(t => `
      <div class="tarjeta">
        <div class="fila">
          <span>${t.numero_comanda ? `#${String(t.numero_comanda).padStart(3, '0')} ${esc(t.comensal || '')}` : 'Ticket'} · ${esc(t.tipo)}</span>
          <span class="der chip ${t.estado === 'impreso' ? 'pagado' : t.estado === 'error' ? 'porcobrar' : ''}">${t.estado.toUpperCase()}</span>
        </div>
        ${t.error ? `<div class="suave" style="color:var(--peligro)">${esc(t.error)}</div>` : ''}
        ${t.estado !== 'impreso' ? `<div class="acciones">
          ${t.estado === 'error' ? `<button class="btn-mini primario" data-reintentar="${t.id}">🔁 Reintentar</button>` : ''}
          <button class="btn-mini peligro" data-descartar="${t.id}">✕ Descartar</button>
        </div>` : ''}
      </div>`).join('') || '<div class="tarjeta suave">Sin trabajos de impresión todavía.</div>'}
    ${est.log.length ? `<h3>Registro de esta estación</h3><div class="tarjeta suave">${est.log.slice(-8).map(esc).join('<br>')}</div>` : ''}`;

  // Tamaños de letra del ticket (solo admin): platos y observaciones, de x1 a x3
  if ($('#cfg-tamanos')) {
    api('/config').then(cfg => {
      const cont = $('#cfg-tamanos');
      if (!cont) return; // la vista pudo cambiar
      const opciones = (sel) => ['1', '1.5', '2', '2.5', '3'].map(v =>
        `<option value="${v}" ${String(sel) === v ? 'selected' : ''}>x${v}</option>`).join('');
      cont.innerHTML = `
        <div class="tarjeta">
          <h3 style="margin-top:0">🔠 Tamaño de letra del ticket</h3>
          <div class="fila">
            <div class="crece"><label>Platos (pollo, sopa...)</label>
              <select id="tam-platos">${opciones(cfg.tamano_platos)}</select></div>
            <div class="crece"><label>Observaciones</label>
              <select id="tam-obs">${opciones(cfg.tamano_obs)}</select></div>
          </div>
          <div class="suave" style="margin-top:6px">Más pequeño = menos papel por comanda. x1 y x2 usan la letra de la impresora; los demás se imprimen como imagen.</div>
          <div class="fila" style="margin-top:10px">
            <button class="btn-mini ok" id="btn-guardar-tamanos">💾 Guardar</button>
            <button class="btn-mini primario" id="btn-prueba-tamanos">🖨 Ticket de prueba</button>
          </div>
        </div>`;
      $('#btn-guardar-tamanos').onclick = async () => {
        try {
          await api('/config', { method: 'PUT', body: { tamano_platos: $('#tam-platos').value, tamano_obs: $('#tam-obs').value } });
          toast('Tamaños guardados: aplican desde la próxima comanda');
        } catch (e) { toast(e.message, true); }
      };
      $('#btn-prueba-tamanos').onclick = async () => {
        try { await api('/impresion/prueba', { method: 'POST' }); toast('Ticket de prueba enviado'); }
        catch (e) { toast(e.message, true); }
      };
    }).catch(() => {});
  }

  if ($('#sel-via')) $('#sel-via').onchange = (e) => { state.estacion.via = e.target.value; renderImpresora(); };
  if ($('#btn-ble')) $('#btn-ble').onclick = conectarBLE;
  if ($('#btn-activar')) $('#btn-activar').onclick = () => {
    est.activa = !est.activa;
    if (est.activa) {
      socket.emit('impresora:registrar');
      logEstacion('Estación activada: esperando comandas...');
      // Mantener pantalla encendida si el navegador lo permite
      if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {});
    } else {
      socket.disconnect(); socket.connect();
      logEstacion('Estación desactivada');
    }
    renderImpresora();
  };
  $('#vista').querySelectorAll('[data-reintentar]').forEach(b => b.onclick = async () => {
    try { await api(`/impresion/${b.dataset.reintentar}/reintentar`, { method: 'POST' }); toast('Reintentando impresión'); }
    catch (e) { toast(e.message, true); }
  });
  $('#vista').querySelectorAll('[data-descartar]').forEach(b => b.onclick = async () => {
    if (!confirm('¿Descartar este trabajo de impresión?\n(La comanda no se borra: puede reimprimirla desde el Historial.)')) return;
    try { await api(`/impresion/${b.dataset.descartar}/descartar`, { method: 'POST' }); toast('Trabajo descartado'); }
    catch (e) { toast(e.message, true); }
  });
  if ($('#btn-descartar-todo')) $('#btn-descartar-todo').onclick = async () => {
    if (!confirm('¿Descartar TODOS los trabajos pendientes y con error?\n(Las comandas no se borran: se pueden reimprimir desde el Historial.)')) return;
    try {
      const r = await api('/impresion/descartar-fallidos', { method: 'POST' });
      toast(`🧹 ${r.descartados} trabajo(s) descartado(s); la alerta desaparece`);
    } catch (e) { toast(e.message, true); }
  };
}

function nombreModo(m) {
  return { simulado: 'Simulado (pruebas)', usb: 'USB en el PC', com: 'Bluetooth del PC (puerto COM)', puente: 'Teléfono puente Bluetooth' }[m] || m;
}

function logEstacion(msg) {
  state.estacion.log.push(`[${new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}] ${msg}`);
  if (state.vista === 'impresora') renderImpresora();
}

async function manejarTrabajoImpresion(trabajo) {
  if (!state.estacion.activa) return;
  logEstacion(`Comanda recibida (trabajo ${trabajo.id}, ${trabajo.tipo})`);
  try {
    if (state.estacion.via === 'ble') await imprimirPorBLE(trabajo);
    else imprimirPorRawBT(trabajo);
    socket.emit('trabajo:resultado', { id: trabajo.id, ok: true });
    logEstacion(`✅ Trabajo ${trabajo.id} impreso`);
  } catch (e) {
    socket.emit('trabajo:resultado', { id: trabajo.id, ok: false, error: e.message });
    logEstacion(`❌ Trabajo ${trabajo.id} falló: ${e.message}`);
  }
}

// Vía A: Web Bluetooth (impresoras BLE)
async function conectarBLE() {
  if (!navigator.bluetooth) {
    return toast('Web Bluetooth no está disponible aquí (requiere HTTPS y Chrome Android). Use la vía RawBT, que funciona igual.', true);
  }
  try {
    const serviciosComunes = ['000018f0-0000-1000-8000-00805f9b34fb', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '49535343-fe7d-4ae5-8fa9-9fafd205e455'];
    const dispositivo = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: serviciosComunes });
    const gatt = await dispositivo.gatt.connect();
    let caracteristica = null;
    for (const servicio of await gatt.getPrimaryServices()) {
      for (const c of await servicio.getCharacteristics()) {
        if (c.properties.write || c.properties.writeWithoutResponse) { caracteristica = c; break; }
      }
      if (caracteristica) break;
    }
    if (!caracteristica) throw new Error('La impresora no expone un canal de escritura BLE');
    state.estacion.bleChar = caracteristica;
    state.estacion.bleNombre = dispositivo.name || 'impresora BLE';
    dispositivo.addEventListener('gattserverdisconnected', () => {
      state.estacion.bleChar = null;
      logEstacion('⚠️ La impresora BLE se desconectó');
    });
    toast(`Impresora conectada: ${state.estacion.bleNombre}`);
    renderImpresora();
  } catch (e) { toast('No se pudo conectar: ' + e.message, true); }
}

async function imprimirPorBLE(trabajo) {
  const c = state.estacion.bleChar;
  if (!c) throw new Error('No hay impresora BLE conectada');
  const bytes = Uint8Array.from(atob(trabajo.raw), ch => ch.charCodeAt(0));
  const TAM = 100; // trocear: los buffers BLE son pequeños
  for (let i = 0; i < bytes.length; i += TAM) {
    const trozo = bytes.slice(i, i + TAM);
    if (c.properties.writeWithoutResponse) await c.writeValueWithoutResponse(trozo);
    else await c.writeValue(trozo);
    await new Promise(r => setTimeout(r, 30));
  }
}

// Vía B: app RawBT (impresoras Bluetooth clásicas SPP)
function imprimirPorRawBT(trabajo) {
  // RawBT registra el esquema rawbt: ; le entregamos los bytes ESC/POS en base64
  const enlace = document.createElement('a');
  enlace.href = 'rawbt:base64,' + trabajo.raw;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
}

// ---------------- Vista: admin ----------------
// usarCache: para abrir/cerrar el editor de turnos sin volver a pedir los datos
// al servidor (así no se pierde lo que esté escrito en el formulario de arriba
// ni se queda la vista en "Cargando..." si falla una de las tres consultas)
function horasReporte(cfg) {
  try { const h = JSON.parse(cfg.horas_reporte || '[]'); return Array.isArray(h) && h.length === 7 ? h : ['', '', '', '', '', '', '']; }
  catch { return ['', '', '', '', '', '', '']; }
}

async function renderAdmin(usarCache) {
  let cfg, usuarios, sync;
  const escritos = {};
  let cargos;
  if (usarCache && state.adminCache) {
    ({ cfg, usuarios, sync, cargos } = state.adminCache);
    // Conservar lo que el admin tenga escrito y sin guardar en la configuración
    $('#vista').querySelectorAll('input[id^="cf-"], textarea[id^="cf-"], select[id^="cf-"]')
      .forEach(el => { escritos[el.id] = el.type === 'checkbox' ? el.checked : el.value; });
  } else {
    $('#vista').innerHTML = '<h2>Administración</h2><div class="tarjeta suave">Cargando...</div>';
    try { [cfg, usuarios, sync, cargos] = await Promise.all([api('/config'), api('/usuarios'), api('/sync/estado'), api('/cargos')]); }
    catch (e) { return toast(e.message, true); }
    state.adminCache = { cfg, usuarios, sync, cargos };
  }
  if (state.vista !== 'admin') return;

  $('#vista').innerHTML = `
    <h2>Administración</h2>

    <div class="tarjeta">
      <h3 style="margin-top:0">🖨️ Impresora</h3>
      <label>Modo de conexión</label>
      <select id="cf-modo">
        <option value="simulado" ${cfg.modo_impresion === 'simulado' ? 'selected' : ''}>Simulado (pruebas, sin impresora)</option>
        <option value="usb" ${cfg.modo_impresion === 'usb' ? 'selected' : ''}>USB conectada a este PC</option>
        <option value="com" ${cfg.modo_impresion === 'com' ? 'selected' : ''}>Bluetooth emparejada con este PC (puerto COM)</option>
        <option value="puente" ${cfg.modo_impresion === 'puente' ? 'selected' : ''}>Bluetooth en un teléfono (estación puente)</option>
      </select>
      <label>Nombre compartido de la impresora USB (Windows)</label>
      <input id="cf-share" value="${esc(cfg.impresora_share)}" placeholder="POS58">
      <label>Puerto COM del Bluetooth del PC</label>
      <input id="cf-com" value="${esc(cfg.puerto_com)}" placeholder="COM4">
      <label>Ancho del ticket (caracteres: 32 para papel 58mm, 48 para 80mm)</label>
      <input id="cf-ancho" type="number" value="${esc(cfg.ancho_ticket)}">
      <div class="fila" style="margin-top:10px">
        <button class="btn-mini primario" id="btn-prueba">🖨 Ticket de prueba</button>
        <button class="btn-mini" id="btn-qr">📱 Imprimir QR de acceso</button>
      </div>
    </div>

    <div class="tarjeta">
      <h3 style="margin-top:0">🧾 Factura (datos del negocio)</h3>
      <label>Título del documento</label>
      <input id="cf-fac-titulo" value="${esc(cfg.factura_titulo)}">
      <label>Razón social / nombre</label>
      <input id="cf-fac-razon" value="${esc(cfg.factura_razon_social)}" placeholder="Restaurante Doña...">
      <label>NIT o cédula</label>
      <input id="cf-fac-nit" value="${esc(cfg.factura_nit)}" placeholder="123456789-0">
      <div class="fila" style="margin-top:8px">
        <div class="crece"><label>Dirección</label><input id="cf-fac-dir" value="${esc(cfg.factura_direccion)}"></div>
        <div class="crece"><label>Teléfono</label><input id="cf-fac-tel" value="${esc(cfg.factura_telefono)}"></div>
      </div>
      <label>Leyenda al pie (régimen)</label>
      <textarea id="cf-fac-leyenda" rows="2">${esc(cfg.factura_leyenda)}</textarea>
    </div>

    <div class="tarjeta">
      <h3 style="margin-top:0">🏪 General</h3>
      <label>Nombre del restaurante</label>
      <input id="cf-nombre" value="${esc(cfg.nombre_restaurante)}">
      <label>Recargo de domicilio (lo que cobra el domiciliario)</label>
      <input id="cf-recargo" type="number" inputmode="numeric" value="${esc(cfg.recargo_empaque)}">
    </div>

    <div class="tarjeta">
      <h3 style="margin-top:0">📧 Reporte diario por correo</h3>
      <label>Hora general del reporte automático (abajo se puede poner una distinta por día)</label>
      <input id="cf-hora" type="time" value="${esc(cfg.hora_reporte)}">
      <label>Correo del dueño (recibe el reporte)</label>
      <input id="cf-correo" type="email" value="${esc(cfg.correo_dueno)}">
      <label>Cuenta Gmail que envía (usuario)</label>
      <input id="cf-gmail" value="${esc(cfg.gmail_usuario)}">
      <label>Contraseña de aplicación de Gmail</label>
      <input id="cf-gmailpass" type="password" value="${esc(cfg.gmail_app_password)}" placeholder="16 letras, se genera en la cuenta de Google">
      <div class="suave" style="margin-top:10px">
        ${sync.correo_configurado ? '✅ Correo configurado' : '⚠️ Falta configurar el Gmail que envía'}
        ${sync.correos_pendientes ? ` · ${sync.correos_pendientes} reporte(s) en cola` : ''}
      </div>
      <div class="fila" style="margin-top:10px">
        <button class="btn-mini primario" id="btn-reporte-ahora">📨 Enviar reporte ahora</button>
      </div>
      <div class="fila" style="margin-top:8px">
        <input id="cf-mes-reporte" type="month" value="${state.jornada.slice(0, 7)}" style="flex:1">
        <button class="btn-mini primario" id="btn-reporte-mes" style="flex:1.4">📅 Enviar reportes del mes</button>
      </div>
      <div class="suave" style="margin-top:4px">Los dos correos del mes (nómina y resumen con todas las ventas) salen solos en el cierre del último día; con este botón se reenvían cuando quiera.</div>
    </div>

    <div class="tarjeta">
      <h3 style="margin-top:0">📊 Excel en tiempo real (Google Sheets) — opcional</h3>
      <label class="check-linea" style="margin-top:4px"><input type="checkbox" id="cf-sheets-activo" ${cfg.sheets_activo === '1' ? 'checked' : ''}> Activar: cada venta pagada se anota sola en la hoja de Google</label>
      <label>URL del webhook de Google Sheets (Apps Script)</label>
      <input id="cf-sheets" value="${esc(cfg.sheets_webhook_url)}" placeholder="https://script.google.com/macros/s/.../exec">
      <div class="suave" style="margin-top:8px">
        ${cfg.sheets_activo === '1'
          ? (sync.sheets_configurado ? '✅ Activado: arriba de la app se ve si está al día o en espera' : '⚠️ Activado, pero falta pegar la URL')
          : '⏸ Desactivado: no se envía nada ni se avisa nada. El Excel del correo diario y los de Descargar siguen igual.'}
        ${sync.sheets_pendientes ? ` · ${sync.sheets_pendientes} venta(s) en espera` : ''}
      </div>
      <div class="suave" style="margin-top:4px">La casilla se guarda con el botón "Guardar configuración" de abajo.</div>
      <div class="fila" style="margin-top:10px">
        <button class="btn-mini primario" id="btn-sheets-diag">🔎 Revisar Google Sheets</button>
      </div>
      <div id="sheets-diag"></div>
    </div>

    <div class="tarjeta" id="admin-roles">
      <h3 style="margin-top:0">👔 Roles de nómina y valor del turno por día</h3>
      ${htmlRoles(cargos)}
      <div class="suave" style="margin-top:6px">También se editan desde Caja → Turnos y pagos de nómina (el cajero también puede).</div>
    </div>

    <div class="tarjeta">
      <h3 style="margin-top:0">🕐 Hora de cierre por día</h3>
      <div class="suave">Si ese día se olvida el cierre de caja, a esta hora sale solo el reporte del día. No todos los días se cierra a la misma hora. Vacío = la hora general (${esc(cfg.hora_reporte)}).</div>
      <div class="turnos-grid">
        ${DIAS_TURNO.map(([dia, nombre]) => `<div><label>${nombre}</label><input type="time" data-hora-dia="${dia}" value="${esc((horasReporte(cfg))[dia] || '')}"></div>`).join('')}
      </div>
      <button class="btn-mini ok" id="btn-horas-guardar" style="margin-top:10px">💾 Guardar horas</button>
    </div>

    <button class="btn ok" id="btn-guardar-cfg">💾 Guardar configuración</button>

    <h3>Usuarios</h3>
    <div class="tarjeta">
      <input id="nu-nombre" placeholder="Nombre" autocomplete="off">
      <div class="fila" style="margin-top:8px">
        <input id="nu-pin" type="number" inputmode="numeric" placeholder="PIN (4 dígitos)" style="flex:1">
        <select id="nu-rol" style="flex:1">
          <option value="mesero">Mesero</option>
          <option value="cajero">Cajero</option>
          <option value="admin">Administrador</option>
          <option value="cocinera">Cocinera (sin acceso a la app, solo nómina)</option>
        </select>
      </div>
      <button class="btn" id="btn-nuevo-usuario" style="margin-top:10px">Crear usuario</button>
    </div>
    ${usuarios.map(u => `
      <div class="tarjeta">
        <div class="fila">
          <div class="crece">
            <b>${esc(u.nombre)}</b> <span class="chip">${esc(u.rol)}</span>
            ${u.activo ? '' : '<span class="chip porcobrar">INACTIVO</span>'}
          </div>
          <button class="btn-mini" data-upin="${u.id}">🔑 PIN</button>
          <button class="btn-mini ${u.activo ? 'peligro' : 'ok'}" data-uactivo="${u.id}" data-estado="${u.activo}">
            ${u.activo ? 'Desactivar' : 'Reactivar'}</button>
          <button class="btn-mini peligro" data-uborrar="${u.id}">🗑</button>
        </div>
        <div class="fila" style="margin-top:6px">
          <span class="suave">Rol habitual en nómina:</span>
          <select data-cargo-habitual="${u.id}" style="flex:1">
            <option value="">— según su acceso (${esc(ROL_POR_ACCESO[u.rol] || u.rol)}) —</option>
            ${cargos.map(c => `<option value="${esc(c.nombre)}" ${c.nombre === u.cargo_habitual ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}
          </select>
        </div>
      </div>`).join('')}`;

  $('#btn-guardar-cfg').onclick = async () => {
    try {
      await api('/config', { method: 'PUT', body: {
        modo_impresion: $('#cf-modo').value, impresora_share: $('#cf-share').value, puerto_com: $('#cf-com').value,
        ancho_ticket: $('#cf-ancho').value, nombre_restaurante: $('#cf-nombre').value, recargo_empaque: $('#cf-recargo').value,
        hora_reporte: $('#cf-hora').value, correo_dueno: $('#cf-correo').value,
        gmail_usuario: $('#cf-gmail').value, gmail_app_password: $('#cf-gmailpass').value,
        sheets_webhook_url: $('#cf-sheets').value, sheets_activo: $('#cf-sheets-activo').checked ? '1' : '0',
        factura_titulo: $('#cf-fac-titulo').value, factura_razon_social: $('#cf-fac-razon').value,
        factura_nit: $('#cf-fac-nit').value, factura_direccion: $('#cf-fac-dir').value,
        factura_telefono: $('#cf-fac-tel').value, factura_leyenda: $('#cf-fac-leyenda').value
      }});
      toast('Configuración guardada (aplica de inmediato)');
      state.config.nombre_restaurante = $('#cf-nombre').value;
      state.config.recargo_empaque = Number($('#cf-recargo').value);
      $('#titulo-app').textContent = state.config.nombre_restaurante;
    } catch (e) { toast(e.message, true); }
  };
  // Roles de nómina: mismo editor que en la pantalla de nómina
  conectarRoles($('#admin-roles'), () => { state.adminCache = null; renderAdmin(); });
  $('#btn-horas-guardar').onclick = async () => {
    const horas = ['', '', '', '', '', '', ''];
    $('#vista').querySelectorAll('[data-hora-dia]').forEach(i => { horas[Number(i.dataset.horaDia)] = i.value || ''; });
    try { await api('/config', { method: 'PUT', body: { horas_reporte: JSON.stringify(horas) } }); toast('Horas de cierre guardadas'); }
    catch (e) { toast(e.message, true); }
  };
  $('#btn-prueba').onclick = async () => {
    try { await api('/impresion/prueba', { method: 'POST' }); toast('Ticket de prueba encolado'); }
    catch (e) { toast(e.message, true); }
  };
  $('#btn-qr').onclick = async () => {
    try { const r = await api('/impresion/qr-acceso', { method: 'POST' }); toast(`QR encolado (${r.url})`); }
    catch (e) { toast(e.message, true); }
  };
  $('#btn-reporte-ahora').onclick = async () => {
    try { await api('/reportes/enviar-ahora', { method: 'POST' }); toast('Reporte encolado para envío (con el Excel del día adjunto)'); }
    catch (e) { toast(e.message, true); }
  };
  $('#btn-reporte-mes').onclick = async () => {
    const mes = String($('#cf-mes-reporte').value || '').trim();
    // En navegadores sin selector de mes el campo es texto libre
    if (!/^\d{4}-\d{2}$/.test(mes)) return toast('Escriba el mes como 2026-09', true);
    const enCurso = mes === state.jornada.slice(0, 7);
    if (!confirm(`¿Enviar los dos correos del mes ${mes} (nómina y resumen con todas las ventas)?` +
      (enCurso ? '\n\nOjo: es el mes en curso, así que el reporte va hasta hoy (parcial).' : ''))) return;
    try { const r = await api('/reportes/enviar-mes', { method: 'POST', body: { mes } }); toast(`Reportes de ${r.mes} encolados para envío`); }
    catch (e) { toast(e.message, true); }
  };
  // Solucionador: revisa paso por paso y dice qué corregir
  $('#btn-sheets-diag').onclick = async () => {
    const caja = $('#sheets-diag');
    caja.innerHTML = '<div class="suave" style="margin-top:10px">🔎 Revisando (puede tardar unos segundos)...</div>';
    let d;
    try { d = await api('/sheets/diagnostico', { method: 'POST' }); }
    catch (e) { caja.innerHTML = `<div class="suave" style="margin-top:10px;color:var(--peligro)">${esc(e.message)}</div>`; return; }
    if (state.vista !== 'admin') return;
    caja.innerHTML = `
      <div class="tarjeta" style="margin-top:10px;border-color:${d.resumen.startsWith('✅') ? 'var(--ok)' : 'var(--alerta)'}">
        <b>${esc(d.resumen)}</b>
        ${d.pasos.map(p => `
          <div style="margin-top:8px;padding-top:6px;border-top:1px dashed var(--borde)">
            <div class="fila"><span>${p.ok ? '✅' : '❌'} <b>${esc(p.paso)}</b></span></div>
            <div class="suave" style="word-break:break-all">${esc(p.detalle)}</div>
            ${p.consejo ? `<div class="suave" style="color:var(--alerta);margin-top:3px">→ ${esc(p.consejo)}</div>` : ''}
          </div>`).join('')}
        ${d.ultimoOk ? `<div class="suave" style="margin-top:8px">Última venta subida: ${esc(d.ultimoOk)}</div>` : ''}
        ${d.ultimoError ? `<div class="suave" style="color:var(--peligro)">Último error: ${esc(d.ultimoError)}</div>` : ''}
      </div>`;
  };
  $('#btn-nuevo-usuario').onclick = async () => {
    try {
      await api('/usuarios', { method: 'POST', body: { nombre: $('#nu-nombre').value, pin: $('#nu-pin').value, rol: $('#nu-rol').value } });
      toast('Usuario creado'); renderAdmin();
    } catch (e) { toast(e.message, true); }
  };
  // Devolver lo que estuviera escrito y sin guardar en la configuración
  for (const [id, valor] of Object.entries(escritos)) {
    const el = document.getElementById(id);
    if (el) { if (el.type === 'checkbox') el.checked = !!valor; else el.value = valor; }
  }

  // Rol habitual en nómina: lo que suele hacer, para que el turno salga preseleccionado
  $('#vista').querySelectorAll('[data-cargo-habitual]').forEach(sel => sel.onchange = async () => {
    try { await api(`/usuarios/${sel.dataset.cargoHabitual}`, { method: 'PUT', body: { cargo_habitual: sel.value } }); toast('Rol habitual guardado'); }
    catch (e) { toast(e.message, true); }
  });
  $('#vista').querySelectorAll('[data-uborrar]').forEach(b => b.onclick = async () => {
    const u = usuarios.find(x => x.id === Number(b.dataset.uborrar));
    if (!confirm(`¿Eliminar a "${u.nombre}" definitivamente?\n\nYa no aparecerá en ninguna lista y su PIN queda libre para otro empleado.\nSi tiene ventas o nómina registradas, esos reportes viejos conservan su nombre.\n\n(Si solo es temporal — vacaciones, retiro con posible regreso — mejor use "Desactivar".)`)) return;
    try {
      const r = await api(`/usuarios/${u.id}`, { method: 'DELETE' });
      toast(r.borrado ? `"${u.nombre}" eliminado` : `"${u.nombre}" eliminado (sus ventas y nómina viejas se conservan en los reportes)`);
      renderAdmin();
    } catch (e) { toast(e.message, true); }
  });
  $('#vista').querySelectorAll('[data-upin]').forEach(b => b.onclick = async () => {
    const pin = prompt('Nuevo PIN de 4 dígitos:');
    if (!pin) return;
    try { await api(`/usuarios/${b.dataset.upin}`, { method: 'PUT', body: { pin } }); toast('PIN actualizado'); }
    catch (e) { toast(e.message, true); }
  });
  $('#vista').querySelectorAll('[data-uactivo]').forEach(b => b.onclick = async () => {
    try {
      await api(`/usuarios/${b.dataset.uactivo}`, { method: 'PUT', body: { activo: b.dataset.estado !== '1' } });
      toast('Usuario actualizado'); renderAdmin();
    } catch (e) { toast(e.message, true); }
  });
}

// ---------------- Inicio ----------------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
if (state.token) iniciarApp(); else renderLogin();

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
  sel: { entrada: [], proteina: [], bebida: [], extra: [] }, uidSeq: 1,
  notas: {},                                // uid de proteína -> {chips, custom} (nota del almuerzo)
  notaExtras: { chips: [], custom: '' },    // nota del bloque de extras sueltos
  pantalla: 'entrada', itemAbierto: null, ticketAbierto: false,
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
      <button class="btn gris" id="btn-cerrar-red" style="margin-top:14px">Cerrar</button>
    </div>`;
  document.body.appendChild(div);
  dibujarQR($('#red-qr'), red.url);
  $('#btn-cerrar-red').onclick = () => div.remove();
  div.onclick = (e) => { if (e.target === div) div.remove(); };
}

const ES_PC_SERVIDOR = ['localhost', '127.0.0.1'].includes(location.hostname);

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
      ${ES_PC_SERVIDOR ? `
      <div class="tarjeta" style="text-align:center">
        <div class="suave">📶 Conectar teléfonos — escanee:</div>
        <div class="red-qr" id="login-qr"></div>
        <div class="red-url" id="login-url"></div>
      </div>` : ''}
    </div>`;
  if (ES_PC_SERVIDOR) {
    fetch('/api/red').then(r => r.json()).then(red => {
      const qrEl = $('#login-qr'), urlEl = $('#login-url');
      if (!qrEl || !urlEl) return; // la vista pudo cambiar
      dibujarQR(qrEl, red.url);
      urlEl.textContent = red.url;
    }).catch(() => {});
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
      <div class="suave" style="margin:6px 0">Fecha del turno: ${esc(n.jornada)}</div>
      <div class="fila suave"><span>Turno</span><span class="der">${fmt(n.valor_turno)}</span></div>
      ${n.descuento ? `<div class="fila suave"><span>Descuento</span><span class="der">-${fmt(n.descuento)}</span></div>` : ''}
      ${n.bono ? `<div class="fila suave"><span>Bono</span><span class="der">+${fmt(n.bono)}</span></div>` : ''}
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
  socket.on('menu:actualizado', (platos) => { state.platos = platos; refrescarVistaEnVivo(); });
  socket.on('pedidos:actualizado', (pedidos) => { state.pedidos = pedidos; refrescarVistaEnVivo(); });
  socket.on('impresion:estado', (imp) => { state.impresion = imp; renderBanner(); refrescarVistaEnVivo(['impresora', 'admin']); });
  socket.on('jornada:cerrada', () => { state.jornadaCerrada = true; renderBanner(); refrescarVistaEnVivo(); });
  socket.on('pedido:guardado', (d) => {
    // El PC recibió y guardó un pedido: avisar en todos los teléfonos
    // (excepto en el que lo creó, que ya ve su propia confirmación)
    if (d.uuid && state.uuidsPropios.has(d.uuid)) return;
    beep(700, 0.1); vibrar(50);
    toast(`🔔 Comanda ${String(d.numero_comanda).padStart(3, '0')} guardada — ${d.comensal} (${d.vendedor})`);
  });
  socket.on('chips:actualizados', (chips) => { state.config.chips_notas = chips; refrescarVistaEnVivo(['tomar', 'menu']); });
  socket.on('caja:actualizada', () => refrescarVistaEnVivo(['caja']));
  socket.on('nomina:actualizada', () => refrescarVistaEnVivo(['caja']));
  socket.on('nomina:pendiente', (n) => { state.nominaPendientes.push(n); mostrarConfirmacionNomina(); });
  socket.on('trabajo:imprimir', manejarTrabajoImpresion);
  socket.on('connect', renderBanner);
  socket.on('disconnect', renderBanner);
}

function refrescarVistaEnVivo(soloVistas) {
  if (soloVistas && !soloVistas.includes(state.vista)) return;
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
  for (const lista of Object.values(state.sel)) {
    for (const it of lista) { const p = platoDe(it.platoId); if (p) total += p.precio; }
  }
  if (state.tipoEntrega === 'llevar') total += recargoDomicilioActual();
  return total;
}

function recargoDomicilioActual() {
  if (state.tipoEntrega !== 'llevar') return 0;
  const v = String(state.valorDomicilio).trim();
  return v === '' ? Number(state.config.recargo_empaque || 0) : Math.max(0, Math.round(Number(v) || 0));
}

// Regla acordada: el ticket solo se habilita con SOLO extras, o con almuerzos
// completos (misma cantidad de entradas y proteinas).
function estadoTicket() {
  const nE = state.sel.entrada.length, nP = state.sel.proteina.length,
        nB = state.sel.bebida.length, nX = state.sel.extra.length;
  if (!nE && !nP && !nB && !nX) return { ok: false, motivo: 'Toque los platos para armar el pedido' };
  if (!nE && !nP) {
    if (nB) return { ok: false, motivo: 'Las bebidas incluidas van con un almuerzo (para vender bebida sola, créela como Extra)' };
    return { ok: true, modo: 'extras' };
  }
  if (nE !== nP) return { ok: false, motivo: `Almuerzos incompletos: ${nE} entrada(s) y ${nP} proteína(s)` };
  if (nB > nE) return { ok: false, motivo: `Hay ${nB} bebida(s) incluida(s) para solo ${nE} almuerzo(s)` };
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
  return { bloques, sobrantes: state.sel.extra.slice(n) };
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
  entrada: { paso: '1', titulo: 'Entradas', secciones: [['entrada', null]] },
  proteina: { paso: '2', titulo: 'Proteínas', secciones: [['proteina_dia', 'Del día'], ['proteina_especial', 'Especiales']] },
  extras: { paso: '3', titulo: 'Bebida y extras', secciones: [['bebida', 'Bebida incluida (del almuerzo)'], ['extra', 'Extras (se cobran aparte)']] }
};

function renderTomar() {
  if (state.ticketAbierto) return renderTicket();
  const def = PANTALLAS[state.pantalla];
  const est = estadoTicket();
  const nE = state.sel.entrada.length, nP = state.sel.proteina.length,
        nB = state.sel.bebida.length, nX = state.sel.extra.length;

  const filaPlato = (p) => {
    const enSel = state.sel[claveListaDeTipo(p.tipo)].filter(it => it.platoId === p.id).length;
    return `
    <div class="pr-wrap">
      <button class="plato-row ${enSel ? 'en-orden' : ''}" data-plato="${p.id}">
        <span class="pr-nombre">${esc(p.nombre)}</span>
        <span class="pr-precio">${p.precio ? fmt(p.precio) : ''}</span>
        ${enSel ? `<span class="pb-badge">${enSel}</span>` : ''}
      </button>
      ${enSel ? `<button class="pr-menos" data-menos-plato="${p.id}">−</button>` : ''}
    </div>`;
  };

  $('#vista').innerHTML = `
  <div class="pantalla-pedido">
    ${state.editandoId ? `<div class="banda-edicion">✏️ Editando comanda ${esc(String(state.editandoNumero || ''))}
      <button class="btn-mini" id="btn-cancelar-edicion">Descartar</button></div>` : ''}
    <div class="paso-titulo">
      <span class="paso-num">${def.paso}</span> ${def.titulo}
      <span class="der resumen-sel">🥣${nE} · 🍗${nP} · 🥤${nB} · 🧃${nX}</span>
    </div>
    ${def.secciones.map(([tipo, subtitulo]) => {
      const platos = state.platos.filter(p => p.tipo === tipo && p.disponible);
      if (!platos.length) return '';
      return `${subtitulo ? `<div class="cat-titulo">${esc(subtitulo)}</div>` : ''}
        <div class="lista-platos">${platos.map(filaPlato).join('')}</div>`;
    }).join('')}
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

  $('#vista').querySelectorAll('[data-plato]').forEach(b => b.onclick = () => {
    const plato = platoDe(Number(b.dataset.plato));
    if (!plato) return;
    state.sel[claveListaDeTipo(plato.tipo)].push({ uid: state.uidSeq++, platoId: plato.id });
    vibrar(25); renderTomar();
  });
  $('#vista').querySelectorAll('[data-menos-plato]').forEach(b => b.onclick = () => {
    const plato = platoDe(Number(b.dataset.menosPlato));
    if (!plato) return;
    const lista = state.sel[claveListaDeTipo(plato.tipo)];
    // quitar la ULTIMA unidad de ese plato
    for (let i = lista.length - 1; i >= 0; i--) {
      if (lista[i].platoId === plato.id) {
        delete state.notas[lista[i].uid];
        lista.splice(i, 1);
        break;
      }
    }
    vibrar(25); renderTomar();
  });
  if ($('#btn-cancelar-edicion')) $('#btn-cancelar-edicion').onclick = () => { limpiarFormulario(); renderTomar(); };
  const ir = (id, pantalla) => { if ($(id)) $(id).onclick = () => { state.pantalla = pantalla; renderTomar(); }; };
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
    return `
    <div class="lt-item ${abierto ? 'abierta' : ''}">
      <div class="lt-item-fila">
        <button class="lt-item-btn" data-item="${it.uid}">
          <span class="lt-item-nombre">${esc(p ? p.nombre.toUpperCase() : '?')}</span>
          ${notaTxt ? `<span class="lt-nota">${esc(notaTxt)}</span>` : ''}
          <span class="lt-flecha">${abierto ? '▲' : '▼'}</span>
        </button>
        <span class="lt-precio">${p && p.precio ? fmt(p.precio) : ''}</span>
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
      ${sobrantes.length ? cardBloque('Extras', sobrantes) : ''}
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
    const quedan = state.sel.entrada.length + state.sel.proteina.length + state.sel.bebida.length + state.sel.extra.length;
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
  state.sel = { entrada: [], proteina: [], bebida: [], extra: [] };
  state.notas = {}; state.notaExtras = { chips: [], custom: '' };
  state.pantalla = 'entrada'; state.itemAbierto = null; state.ticketAbierto = false;
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
      extra: state.sel.extra.map(x => ({ ...x }))
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
    items.push({ plato_id: it.platoId, cantidad: 1, bloque: bloques.length, nota: componerNota(state.notas[it.uid]) });
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
    <h2>Historial de hoy (${comandas.length})</h2>
    ${comandas.length === 0 ? '<div class="tarjeta suave">Aún no hay comandas en esta jornada.</div>' : ''}
    ${comandas.map(p => tarjetaPedido(p, bloqueada ? '' : `
      ${!p.pagado && puedeCobrar ? `<button class="btn-mini ok" data-cobrar="${p.id}">💰 Cobrar</button>` : ''}
      ${!p.pagado ? `<button class="btn-mini primario" data-editar="${p.id}">✏️ Editar</button>` : ''}
      <button class="btn-mini peligro" data-cancelar="${p.id}">✕ Anular</button>
      <button class="btn-mini" data-reimprimir="${p.id}">🖨️ Reimprimir</button>
    `)).join('')}
    ${anuladas.length ? `<h3>Anuladas (${anuladas.length})</h3>${anuladas.map(p => tarjetaPedido(p, '')).join('')}` : ''}`;

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
  state.sel = { entrada: [], proteina: [], bebida: [], extra: [] };
  state.notas = {}; state.notaExtras = { chips: [], custom: '' };
  state.itemAbierto = null;
  const sinMatch = [];
  // Reconstruir en orden de bloque para que el pareo entrada[i]-proteína[i]-extra[i] se conserve
  const items = [...p.items].sort((a, b) => (a.bloque ?? 999) - (b.bloque ?? 999) || a.id - b.id);
  for (const it of items) {
    const plato = state.platos.find(pl => pl.nombre === it.plato_nombre);
    if (!plato) { sinMatch.push(it.plato_nombre); continue; }
    const listaKey = claveListaDeTipo(plato.tipo);
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

// ---------------- Vista: caja ----------------
function renderCaja() {
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
    <h3>Cuentas por cobrar (${sinPagar.length})</h3>
    ${sinPagar.length === 0 ? '<div class="tarjeta suave">Todo está cobrado. 🎉</div>' : ''}
    ${sinPagar.map(p => tarjetaPedido(p, state.jornadaCerrada ? '' :
      `<button class="btn-mini ok" data-cobrar2="${p.id}">💰 Cobrar</button>`)).join('')}
    <h3>💸 Gastos del local</h3>
    <div class="tarjeta">
      <input id="ga-concepto" placeholder="Concepto (ej: guantes para cocina, proveedor verduras)" autocomplete="off">
      <div class="fila" style="margin-top:8px">
        <input id="ga-valor" type="text" inputmode="numeric" pattern="[0-9]*" placeholder="Valor" style="flex:1">
        <button class="btn-mini ok" id="btn-gasto" style="flex:1">Registrar gasto</button>
      </div>
      <div id="lista-gastos" style="margin-top:8px"><span class="suave">Cargando...</span></div>
    </div>

    <h3>👥 Nómina</h3>
    <div class="tarjeta" id="zona-nomina"><span class="suave">Cargando...</span></div>

    <h3>Resumen del día</h3>
    <div class="tarjeta" id="resumen-dia"><span class="suave">Cargando...</span></div>
    <h3>Cierre de caja</h3>
    <div class="tarjeta">
      ${state.jornadaCerrada ? '<div class="suave">La jornada ya tiene cierre registrado.</div>' : `
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

  if ($('#btn-gasto')) $('#btn-gasto').onclick = async () => {
    try {
      await api('/gastos', { method: 'POST', body: { concepto: $('#ga-concepto').value, valor: $('#ga-valor').value } });
      toast('Gasto registrado (se descuenta del efectivo esperado)');
      $('#ga-concepto').value = ''; $('#ga-valor').value = '';
      cargarGastos(); cargarResumenDia();
    } catch (e) { toast(e.message, true); }
  };

  cargarGastos();
  cargarNomina();
  cargarResumenDia();
}

async function cargarGastos() {
  try {
    const gastos = await api('/gastos');
    const cont = $('#lista-gastos');
    if (!cont) return;
    const total = gastos.reduce((s, g) => s + g.valor, 0);
    cont.innerHTML = gastos.length ? gastos.map(g => `
      <div class="fila suave" style="padding:3px 0">
        <span class="crece">${esc(g.concepto)} <em>(${esc(g.usuario)})</em></span>
        <span>${fmt(g.valor)}</span>
        ${state.usuario.rol === 'admin' ? `<button class="btn-mini peligro" data-gasto-borrar="${g.id}">✕</button>` : ''}
      </div>`).join('') + `<div class="fila" style="margin-top:4px"><b class="crece">Total gastos hoy</b><b>${fmt(total)}</b></div>`
      : '<span class="suave">Sin gastos registrados hoy</span>';
    cont.querySelectorAll('[data-gasto-borrar]').forEach(b => b.onclick = async () => {
      if (!confirm('¿Eliminar este gasto?')) return;
      try { await api(`/gastos/${b.dataset.gastoBorrar}`, { method: 'DELETE' }); cargarGastos(); cargarResumenDia(); }
      catch (e) { toast(e.message, true); }
    });
  } catch { /* la vista pudo cambiar */ }
}

async function cargarNomina() {
  try {
    const r = await api('/nomina/resumen');
    const cont = $('#zona-nomina');
    if (!cont) return;
    const hoy = new Date().toLocaleDateString('sv-SE');
    cont.innerHTML = `
      <label>Empleado</label>
      <select id="no-emp">${r.empleados.map(e =>
        `<option value="${e.id}" data-turno="${e.valor_turno}">${esc(e.nombre)} (turno ${fmt(e.valor_turno)})</option>`).join('')}</select>
      <div class="fila" style="margin-top:8px">
        <div class="crece"><label>Fecha del turno</label><input id="no-fecha" type="date" value="${hoy}"></div>
        <div class="crece"><label>Valor del turno</label><input id="no-turno" type="text" inputmode="numeric" pattern="[0-9]*"
          value="${r.empleados.length ? r.empleados[0].valor_turno : 0}"></div>
      </div>
      <div class="fila" style="margin-top:8px">
        <div class="crece"><label>Descuento</label><input id="no-desc" type="text" inputmode="numeric" pattern="[0-9]*" placeholder="0"></div>
        <div class="crece"><label>Bono</label><input id="no-bono" type="text" inputmode="numeric" pattern="[0-9]*" placeholder="0"></div>
      </div>
      <div class="fila" style="margin-top:8px"><span class="crece suave">Total a pagar</span><b id="no-total" class="grande" style="font-size:17px"></b></div>
      <button class="btn ok" id="btn-nomina-registrar" style="margin-top:8px">Registrar pago (el empleado confirma en su app)</button>
      <div class="suave" style="margin-top:4px">El valor del turno por empleado lo configura el admin en la pestaña Admin.</div>

      ${r.pendientes.length ? `<hr class="sep"><b>Pendientes de confirmación:</b>
        ${r.pendientes.map(n => `
        <div class="fila suave" style="padding:4px 0">
          <span class="crece">${esc(n.empleado)} · ${esc(n.jornada)}</span>
          <span>${fmt(n.total)}</span>
          ${state.usuario.rol === 'admin' ? `
            <button class="btn-mini ok" data-nomina-conf="${n.id}">✓</button>
            <button class="btn-mini peligro" data-nomina-anular="${n.id}">✕</button>` : ''}
        </div>`).join('')}` : ''}

      <hr class="sep">
      <b>Totales pagados por empleado:</b>
      <div style="overflow-x:auto"><table>
        <tr><th>Empleado</th><th class="num">Hoy</th><th class="num">Semana</th><th class="num">Quincena</th><th class="num">Mes</th></tr>
        ${r.empleados.map(e => `
        <tr><td>${esc(e.nombre)}</td><td class="num">${fmt(e.dia)}</td><td class="num">${fmt(e.semana)}</td>
        <td class="num">${fmt(e.quincena)}</td><td class="num">${fmt(e.mes)}</td></tr>`).join('')}
      </table></div>`;

    const actualizarTotalNomina = () => {
      const t = (Number($('#no-turno').value) || 0) - (Number($('#no-desc').value) || 0) + (Number($('#no-bono').value) || 0);
      $('#no-total').textContent = fmt(t);
    };
    $('#no-emp').onchange = () => {
      $('#no-turno').value = $('#no-emp').selectedOptions[0].dataset.turno;
      actualizarTotalNomina();
    };
    ['#no-turno', '#no-desc', '#no-bono'].forEach(s => { $(s).oninput = actualizarTotalNomina; });
    actualizarTotalNomina();

    $('#btn-nomina-registrar').onclick = async () => {
      try {
        await api('/nomina', { method: 'POST', body: {
          empleado_id: Number($('#no-emp').value), jornada: $('#no-fecha').value,
          valor_turno: $('#no-turno').value, descuento: $('#no-desc').value || 0, bono: $('#no-bono').value || 0
        }});
        toast('Pago registrado: el empleado debe confirmarlo en su teléfono');
        cargarNomina();
      } catch (e) { toast(e.message, true); }
    };
    cont.querySelectorAll('[data-nomina-conf]').forEach(b => b.onclick = async () => {
      if (!confirm('¿Confirmar este pago en nombre del empleado? (para quien no usa la app)')) return;
      try { await api(`/nomina/${b.dataset.nominaConf}/confirmar`, { method: 'POST' }); toast('Pago confirmado; sale el ticket'); cargarNomina(); cargarResumenDia(); }
      catch (e) { toast(e.message, true); }
    });
    cont.querySelectorAll('[data-nomina-anular]').forEach(b => b.onclick = async () => {
      if (!confirm('¿Anular este registro de pago?')) return;
      try { await api(`/nomina/${b.dataset.nominaAnular}/anular`, { method: 'POST' }); cargarNomina(); }
      catch (e) { toast(e.message, true); }
    });
  } catch { /* la vista pudo cambiar */ }
}

async function cargarResumenDia() {
  try {
    const r = await api('/reportes/dia');
    const cont = $('#resumen-dia');
    if (!cont) return;
    cont.innerHTML = `
      <div class="fila"><span>Ventas (${r.numPedidos} pedidos)</span><span class="der grande" style="font-size:16px">${fmt(r.totalVentas)}</span></div>
      <div class="fila suave"><span>Cobrado</span><span class="der">${fmt(r.totalCobrado)}</span></div>
      <div class="fila suave"><span>Recargos por empaque</span><span class="der">${fmt(r.totalRecargos)}</span></div>
      <div class="fila suave"><span>Cancelados (${r.numCancelados})</span><span class="der">${fmt(r.totalCancelado)}</span></div>
      <hr class="sep">
      ${Object.entries(r.porMetodo).map(([m, v]) =>
        `<div class="fila suave"><span>${METODOS[m] || m}</span><span class="der">${fmt(v)}</span></div>`).join('') || '<div class="suave">Sin pagos aún</div>'}
      <hr class="sep">
      ${Object.entries(r.porVendedor).map(([v, d]) =>
        `<div class="fila suave"><span>👤 ${esc(v)} (${d.pedidos} pedidos)</span><span class="der">${fmt(d.total)}</span></div>`).join('')}
      <hr class="sep">
      <div class="fila suave"><span>💸 Gastos del local</span><span class="der">-${fmt(r.totalGastos)}</span></div>
      <div class="fila suave"><span>👥 Nómina pagada</span><span class="der">-${fmt(r.totalNomina)}</span></div>
      ${r.totalRecargoTarjeta ? `<div class="fila suave"><span>Recargos tarjeta cobrados</span><span class="der">${fmt(r.totalRecargoTarjeta)}</span></div>` : ''}
      <div class="fila" style="font-weight:800"><span>Efectivo esperado en caja</span><span class="der">${fmt(r.efectivoEsperado)}</span></div>`;
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

function renderMenu() {
  $('#vista').innerHTML = `
    <h2>Menú del día</h2>
    <div class="tarjeta">
      <h3 style="margin-top:0">Agregar plato</h3>
      <input id="np-nombre" placeholder="Nombre del plato" autocomplete="off">
      <div class="fila" style="margin-top:8px">
        <input id="np-precio" type="number" inputmode="numeric" placeholder="Precio" style="flex:1">
        <select id="np-tipo" style="flex:1.4">
          ${OPCIONES_TIPO.map(([v, n]) => `<option value="${v}" ${v === 'proteina_dia' ? 'selected' : ''}>${n}</option>`).join('')}
        </select>
      </div>
      <button class="btn" id="btn-nuevo-plato" style="margin-top:10px">Agregar al menú</button>
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
    ${TIPOS_UI.map(([tipo, titulo]) => {
      const platos = state.platos.filter(p => p.tipo === tipo);
      if (!platos.length) return '';
      return `<h3>${titulo}</h3>` + platos.map(p => `
      <div class="tarjeta ${p.disponible ? '' : 'plato-oculto'}">
        <div class="fila">
          <div class="crece">
            <div class="plato-nombre">${esc(p.nombre)}
              ${p.disponible ? '' : '<span class="chip">OCULTO</span>'}</div>
            <div class="plato-precio">${p.precio ? fmt(p.precio) : 'Incluido'}</div>
          </div>
          <button class="btn-mini ${p.disponible ? '' : 'ok'}" data-visible="${p.id}">
            ${p.disponible ? '🚫 Ocultar' : '👁 Mostrar'}</button>
          <button class="btn-mini primario" data-editar-plato="${p.id}">✏️</button>
          <button class="btn-mini peligro" data-borrar="${p.id}">🗑</button>
        </div>
        ${state.editandoPlatoId === p.id ? `
        <div class="lt-detalle" style="border-top:1px dashed var(--borde);margin-top:8px">
          <label>Nombre</label>
          <input id="ep-nombre" value="${esc(p.nombre)}" autocomplete="off">
          <div class="fila" style="margin-top:8px">
            <div class="crece"><label>Precio</label>
              <input id="ep-precio" type="number" inputmode="numeric" value="${p.precio}"></div>
            <div class="crece"><label>Tipo</label>
              <select id="ep-tipo">
                ${OPCIONES_TIPO.map(([v, n]) => `<option value="${v}" ${p.tipo === v ? 'selected' : ''}>${n}</option>`).join('')}
              </select></div>
          </div>
          <div class="fila" style="margin-top:10px">
            <button class="btn-mini" id="ep-cancelar">Cancelar</button>
            <button class="btn-mini ok" id="ep-guardar">💾 Guardar cambios</button>
          </div>
        </div>` : ''}
      </div>`).join('');
    }).join('')}`;

  $('#btn-nuevo-plato').onclick = async () => {
    try {
      await api('/platos', { method: 'POST', body: {
        nombre: $('#np-nombre').value, precio: $('#np-precio').value || 0, tipo: $('#np-tipo').value
      }});
      toast('Plato agregado; visible en todos los teléfonos');
    } catch (e) { toast(e.message, true); }
  };
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
  if ($('#ep-guardar')) $('#ep-guardar').onclick = async () => {
    try {
      await api(`/platos/${state.editandoPlatoId}`, { method: 'PUT', body: {
        nombre: $('#ep-nombre').value, precio: $('#ep-precio').value || 0, tipo: $('#ep-tipo').value
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
    ${(imp.trabajos || []).slice(0, 15).map(t => `
      <div class="tarjeta">
        <div class="fila">
          <span>${t.numero_comanda ? `#${String(t.numero_comanda).padStart(3, '0')} ${esc(t.comensal || '')}` : 'Ticket'} · ${esc(t.tipo)}</span>
          <span class="der chip ${t.estado === 'impreso' ? 'pagado' : t.estado === 'error' ? 'porcobrar' : ''}">${t.estado.toUpperCase()}</span>
        </div>
        ${t.error ? `<div class="suave" style="color:var(--peligro)">${esc(t.error)}</div>` : ''}
        ${t.estado === 'error' ? `<div class="acciones"><button class="btn-mini primario" data-reintentar="${t.id}">🔁 Reintentar</button></div>` : ''}
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
async function renderAdmin() {
  $('#vista').innerHTML = '<h2>Administración</h2><div class="tarjeta suave">Cargando...</div>';
  let cfg, usuarios, sync;
  try { [cfg, usuarios, sync] = await Promise.all([api('/config'), api('/usuarios'), api('/sync/estado')]); }
  catch (e) { return toast(e.message, true); }
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
      <h3 style="margin-top:0">🏪 General</h3>
      <label>Nombre del restaurante</label>
      <input id="cf-nombre" value="${esc(cfg.nombre_restaurante)}">
      <label>Recargo de domicilio (lo que cobra el domiciliario)</label>
      <input id="cf-recargo" type="number" inputmode="numeric" value="${esc(cfg.recargo_empaque)}">
    </div>

    <div class="tarjeta">
      <h3 style="margin-top:0">📧 Reporte diario y sincronización</h3>
      <label>Hora del reporte automático</label>
      <input id="cf-hora" type="time" value="${esc(cfg.hora_reporte)}">
      <label>Correo del dueño (recibe el reporte)</label>
      <input id="cf-correo" type="email" value="${esc(cfg.correo_dueno)}">
      <label>Cuenta Gmail que envía (usuario)</label>
      <input id="cf-gmail" value="${esc(cfg.gmail_usuario)}">
      <label>Contraseña de aplicación de Gmail</label>
      <input id="cf-gmailpass" type="password" value="${esc(cfg.gmail_app_password)}" placeholder="16 letras, se genera en la cuenta de Google">
      <label>URL del webhook de Google Sheets (Apps Script)</label>
      <input id="cf-sheets" value="${esc(cfg.sheets_webhook_url)}" placeholder="https://script.google.com/macros/s/.../exec">
      <div class="suave" style="margin-top:10px">
        ${sync.correo_configurado ? '✅ Correo configurado' : '⚠️ Falta configurar el Gmail que envía'}
        ${sync.correos_pendientes ? ` · ${sync.correos_pendientes} reporte(s) en cola` : ''}<br>
        ${sync.sheets_configurado ? '✅ Google Sheets vinculado' : '⚠️ Falta la URL del webhook de Sheets'}
        ${sync.sheets_pendientes ? ` · ${sync.sheets_pendientes} venta(s) sin subir` : ''}
      </div>
      <div class="fila" style="margin-top:10px">
        <button class="btn-mini primario" id="btn-reporte-ahora">📨 Enviar reporte ahora</button>
        <button class="btn-mini primario" id="btn-sheets-prueba">📊 Probar Google Sheets</button>
      </div>
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
        </select>
      </div>
      <button class="btn" id="btn-nuevo-usuario" style="margin-top:10px">Crear usuario</button>
    </div>
    ${usuarios.map(u => `
      <div class="tarjeta">
        <div class="fila">
          <div class="crece">
            <b>${esc(u.nombre)}</b> <span class="chip">${esc(u.rol)}</span>
            <span class="chip">turno ${fmt(u.valor_turno || 0)}</span>
            ${u.activo ? '' : '<span class="chip porcobrar">INACTIVO</span>'}
          </div>
          <button class="btn-mini" data-uturno="${u.id}">💰</button>
          <button class="btn-mini" data-upin="${u.id}">🔑 PIN</button>
          <button class="btn-mini ${u.activo ? 'peligro' : 'ok'}" data-uactivo="${u.id}" data-estado="${u.activo}">
            ${u.activo ? 'Desactivar' : 'Reactivar'}</button>
        </div>
      </div>`).join('')}`;

  $('#btn-guardar-cfg').onclick = async () => {
    try {
      await api('/config', { method: 'PUT', body: {
        modo_impresion: $('#cf-modo').value, impresora_share: $('#cf-share').value, puerto_com: $('#cf-com').value,
        ancho_ticket: $('#cf-ancho').value, nombre_restaurante: $('#cf-nombre').value, recargo_empaque: $('#cf-recargo').value,
        hora_reporte: $('#cf-hora').value, correo_dueno: $('#cf-correo').value,
        gmail_usuario: $('#cf-gmail').value, gmail_app_password: $('#cf-gmailpass').value,
        sheets_webhook_url: $('#cf-sheets').value
      }});
      toast('Configuración guardada (aplica de inmediato)');
      state.config.nombre_restaurante = $('#cf-nombre').value;
      state.config.recargo_empaque = Number($('#cf-recargo').value);
      $('#titulo-app').textContent = state.config.nombre_restaurante;
    } catch (e) { toast(e.message, true); }
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
    try { await api('/reportes/enviar-ahora', { method: 'POST' }); toast('Reporte encolado para envío'); }
    catch (e) { toast(e.message, true); }
  };
  $('#btn-sheets-prueba').onclick = async () => {
    toast('Enviando fila de prueba a Google Sheets...');
    try {
      const r = await api('/sheets/prueba', { method: 'POST' });
      toast(`✅ ${r.enviados} fila(s) llegaron a Google Sheets. Revise la hoja.`);
    } catch (e) { toast('❌ ' + e.message, true); }
  };
  $('#btn-nuevo-usuario').onclick = async () => {
    try {
      await api('/usuarios', { method: 'POST', body: { nombre: $('#nu-nombre').value, pin: $('#nu-pin').value, rol: $('#nu-rol').value } });
      toast('Usuario creado'); renderAdmin();
    } catch (e) { toast(e.message, true); }
  };
  $('#vista').querySelectorAll('[data-uturno]').forEach(b => b.onclick = async () => {
    const u = usuarios.find(x => x.id === Number(b.dataset.uturno));
    const v = prompt(`Valor del turno de ${u.nombre} (para nómina):`, u.valor_turno || 0);
    if (v === null) return;
    try { await api(`/usuarios/${u.id}`, { method: 'PUT', body: { valor_turno: Number(v) } }); toast('Turno actualizado'); renderAdmin(); }
    catch (e) { toast(e.message, true); }
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

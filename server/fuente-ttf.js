// Lector mínimo de fuentes TrueType (.ttf) + rasterizador de texto a 1 bit.
//
// ¿Por qué existe esto? La comanda imprime los platos como IMAGEN (la letra
// nativa de la SAT 15T US topa en 2x). Antes esa imagen la dibujaba PowerShell
// con System.Drawing: cada línea costaba entre 1 y 4 SEGUNDOS porque hay que
// arrancar un powershell.exe nuevo, y los nombres largos obligaban a repetir el
// intento varias veces para que cupieran en el papel. Una comanda con 4 platos
// distintos se demoraba hasta 20 segundos y, peor, dejaba el servidor entero
// congelado (todos los teléfonos esperando).
//
// Aquí se lee directamente el archivo de la fuente (C:\Windows\Fonts\arialbd.ttf)
// y se dibujan las letras en JavaScript: la misma letra, el mismo resultado en
// papel, pero en milisegundos y sin procesos externos.
//
// Solo se implementa lo que la comanda necesita: glifos TrueType (simples y
// compuestos, para la Ñ y las tildes), medidas horizontales y el mapa de
// caracteres. No hay hinting ni kerning: a 72 puntos de alto no se nota.

const fs = require('fs');
const path = require('path');

// Banderas de los glifos compuestos (una Ñ = N + virgulilla)
const ARG_1_Y_2_SON_PALABRAS = 0x0001;
const ARGS_SON_XY = 0x0002;
const TIENE_ESCALA = 0x0008;
const MAS_COMPONENTES = 0x0020;
const TIENE_ESCALA_XY = 0x0040;
const TIENE_MATRIZ_2X2 = 0x0080;

// Banderas de los puntos de un contorno
const EN_CURVA = 0x01;
const X_CORTO = 0x02;
const Y_CORTO = 0x04;
const REPETIR = 0x08;
const X_IGUAL_O_POS = 0x10;
const Y_IGUAL_O_POS = 0x20;

class FuenteTTF {
  constructor(buffer) {
    this.b = buffer;
    let inicio = 0;
    if (buffer.toString('ascii', 0, 4) === 'ttcf') inicio = buffer.readUInt32BE(12); // colección: la primera
    const numTablas = buffer.readUInt16BE(inicio + 4);
    this.tablas = {};
    for (let i = 0; i < numTablas; i++) {
      const p = inicio + 12 + i * 16;
      this.tablas[buffer.toString('ascii', p, p + 4)] = {
        off: buffer.readUInt32BE(p + 8), len: buffer.readUInt32BE(p + 12)
      };
    }
    for (const t of ['head', 'maxp', 'hhea', 'hmtx', 'loca', 'glyf', 'cmap']) {
      if (!this.tablas[t]) throw new Error(`La fuente no trae la tabla "${t}" (¿es OpenType/CFF?)`);
    }
    const head = this.tablas.head.off;
    this.unidadesEm = buffer.readUInt16BE(head + 18);
    this.formatoLoca = buffer.readInt16BE(head + 50); // 0 = corto (uint16 x2), 1 = largo (uint32)
    this.numGlifos = buffer.readUInt16BE(this.tablas.maxp.off + 4);
    this.numMetricas = buffer.readUInt16BE(this.tablas.hhea.off + 34);
    this.cacheGlifo = new Map();
    this.cacheCodigo = new Map();
    this.prepararCmap();
  }

  // ---- Mapa de caracteres: se prefiere Windows Unicode (3,1) formato 4 ----
  prepararCmap() {
    const base = this.tablas.cmap.off;
    const n = this.b.readUInt16BE(base + 2);
    let mejor = null, mejorPuntaje = -1;
    for (let i = 0; i < n; i++) {
      const p = base + 4 + i * 8;
      const plataforma = this.b.readUInt16BE(p);
      const codificacion = this.b.readUInt16BE(p + 2);
      const off = base + this.b.readUInt32BE(p + 4);
      const formato = this.b.readUInt16BE(off);
      let puntaje = -1;
      if (plataforma === 3 && codificacion === 10 && formato === 12) puntaje = 4;
      else if (plataforma === 3 && codificacion === 1 && formato === 4) puntaje = 3;
      else if (plataforma === 0 && formato === 12) puntaje = 2;
      else if (plataforma === 0 && formato === 4) puntaje = 1;
      else if (formato === 4 || formato === 12) puntaje = 0;
      if (puntaje > mejorPuntaje) { mejorPuntaje = puntaje; mejor = { off, formato }; }
    }
    if (!mejor) throw new Error('La fuente no trae un mapa de caracteres utilizable');
    this.cmap = mejor;
    if (mejor.formato === 4) {
      const off = mejor.off;
      const segX2 = this.b.readUInt16BE(off + 6);
      this.seg = {
        n: segX2 / 2,
        fin: off + 14,
        inicio: off + 16 + segX2,
        delta: off + 16 + segX2 * 2,
        rango: off + 16 + segX2 * 3
      };
    }
  }

  glifoDeCodigo(codigo) {
    if (this.cacheCodigo.has(codigo)) return this.cacheCodigo.get(codigo);
    let gid = 0;
    if (this.cmap.formato === 4) {
      if (codigo <= 0xffff) {
        const s = this.seg;
        for (let i = 0; i < s.n; i++) {
          if (this.b.readUInt16BE(s.fin + i * 2) >= codigo) {
            const desde = this.b.readUInt16BE(s.inicio + i * 2);
            if (desde <= codigo) {
              const rango = this.b.readUInt16BE(s.rango + i * 2);
              const delta = this.b.readInt16BE(s.delta + i * 2);
              if (rango === 0) gid = (codigo + delta) & 0xffff;
              else {
                const pos = s.rango + i * 2 + rango + (codigo - desde) * 2;
                const g = this.b.readUInt16BE(pos);
                gid = g === 0 ? 0 : (g + delta) & 0xffff;
              }
            }
            break;
          }
        }
      }
    } else { // formato 12
      const off = this.cmap.off;
      const grupos = this.b.readUInt32BE(off + 12);
      for (let i = 0; i < grupos; i++) {
        const p = off + 16 + i * 12;
        const desde = this.b.readUInt32BE(p), hasta = this.b.readUInt32BE(p + 4);
        if (codigo >= desde && codigo <= hasta) { gid = this.b.readUInt32BE(p + 8) + (codigo - desde); break; }
        if (codigo < desde) break;
      }
    }
    this.cacheCodigo.set(codigo, gid);
    return gid;
  }

  avanceDe(gid) {
    const off = this.tablas.hmtx.off;
    const i = Math.min(gid, this.numMetricas - 1);
    return this.b.readUInt16BE(off + i * 4);
  }

  rangoGlifo(gid) {
    const loca = this.tablas.loca.off;
    if (gid < 0 || gid >= this.numGlifos) return null;
    const [a, b] = this.formatoLoca === 0
      ? [this.b.readUInt16BE(loca + gid * 2) * 2, this.b.readUInt16BE(loca + gid * 2 + 2) * 2]
      : [this.b.readUInt32BE(loca + gid * 4), this.b.readUInt32BE(loca + gid * 4 + 4)];
    if (b <= a) return null; // glifo vacío (el espacio, por ejemplo)
    return [this.tablas.glyf.off + a, this.tablas.glyf.off + b];
  }

  // Devuelve { contornos: [[{x,y,enCurva}]], caja: {x0,y0,x1,y1} } en unidades de la fuente
  glifo(gid, profundidad = 0) {
    if (this.cacheGlifo.has(gid)) return this.cacheGlifo.get(gid);
    const r = this.rangoGlifo(gid);
    let resultado;
    if (!r) resultado = { contornos: [], caja: null };
    else {
      const p = r[0];
      const numContornos = this.b.readInt16BE(p);
      const caja = {
        x0: this.b.readInt16BE(p + 2), y0: this.b.readInt16BE(p + 4),
        x1: this.b.readInt16BE(p + 6), y1: this.b.readInt16BE(p + 8)
      };
      resultado = numContornos >= 0
        ? { contornos: this.glifoSimple(p + 10, numContornos), caja }
        : { contornos: profundidad > 4 ? [] : this.glifoCompuesto(p + 10, profundidad), caja };
    }
    this.cacheGlifo.set(gid, resultado);
    return resultado;
  }

  glifoSimple(p, numContornos) {
    const finales = [];
    for (let i = 0; i < numContornos; i++) finales.push(this.b.readUInt16BE(p + i * 2));
    p += numContornos * 2;
    const numPuntos = numContornos ? finales[numContornos - 1] + 1 : 0;
    p += 2 + this.b.readUInt16BE(p); // saltar las instrucciones de hinting

    const banderas = new Uint8Array(numPuntos);
    for (let i = 0; i < numPuntos;) {
      const f = this.b[p++];
      banderas[i++] = f;
      if (f & REPETIR) { let rep = this.b[p++]; while (rep-- > 0 && i < numPuntos) banderas[i++] = f; }
    }
    const xs = new Int16Array(numPuntos), ys = new Int16Array(numPuntos);
    let v = 0;
    for (let i = 0; i < numPuntos; i++) {
      const f = banderas[i];
      if (f & X_CORTO) { const d = this.b[p++]; v += (f & X_IGUAL_O_POS) ? d : -d; }
      else if (!(f & X_IGUAL_O_POS)) { v += this.b.readInt16BE(p); p += 2; }
      xs[i] = v;
    }
    v = 0;
    for (let i = 0; i < numPuntos; i++) {
      const f = banderas[i];
      if (f & Y_CORTO) { const d = this.b[p++]; v += (f & Y_IGUAL_O_POS) ? d : -d; }
      else if (!(f & Y_IGUAL_O_POS)) { v += this.b.readInt16BE(p); p += 2; }
      ys[i] = v;
    }
    const contornos = [];
    let desde = 0;
    for (const fin of finales) {
      const puntos = [];
      for (let i = desde; i <= fin && i < numPuntos; i++) {
        puntos.push({ x: xs[i], y: ys[i], enCurva: !!(banderas[i] & EN_CURVA) });
      }
      if (puntos.length) contornos.push(puntos);
      desde = fin + 1;
    }
    return contornos;
  }

  glifoCompuesto(p, profundidad) {
    const contornos = [];
    for (;;) {
      const banderas = this.b.readUInt16BE(p);
      const indice = this.b.readUInt16BE(p + 2);
      p += 4;
      let dx = 0, dy = 0;
      if (banderas & ARG_1_Y_2_SON_PALABRAS) {
        if (banderas & ARGS_SON_XY) { dx = this.b.readInt16BE(p); dy = this.b.readInt16BE(p + 2); }
        p += 4;
      } else {
        if (banderas & ARGS_SON_XY) { dx = this.b.readInt8(p); dy = this.b.readInt8(p + 1); }
        p += 2;
      }
      let a = 1, bb = 0, c = 0, d = 1;
      const f2 = (o) => this.b.readInt16BE(o) / 16384;
      if (banderas & TIENE_ESCALA) { a = d = f2(p); p += 2; }
      else if (banderas & TIENE_ESCALA_XY) { a = f2(p); d = f2(p + 2); p += 4; }
      else if (banderas & TIENE_MATRIZ_2X2) { a = f2(p); bb = f2(p + 2); c = f2(p + 4); d = f2(p + 6); p += 8; }
      for (const cont of this.glifo(indice, profundidad + 1).contornos) {
        contornos.push(cont.map(pt => ({
          x: a * pt.x + c * pt.y + dx,
          y: bb * pt.x + d * pt.y + dy,
          enCurva: pt.enCurva
        })));
      }
      if (!(banderas & MAS_COMPONENTES)) break;
    }
    return contornos;
  }

  // Medidas de un texto en unidades de la fuente: ancho de avance y caja de tinta
  medir(texto) {
    let pluma = 0;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const piezas = [];
    for (const ch of String(texto)) {
      const gid = this.glifoDeCodigo(ch.codePointAt(0));
      const g = this.glifo(gid);
      const avance = this.avanceDe(gid);
      if (g.caja && g.contornos.length) {
        x0 = Math.min(x0, pluma + g.caja.x0); x1 = Math.max(x1, pluma + g.caja.x1);
        y0 = Math.min(y0, g.caja.y0); y1 = Math.max(y1, g.caja.y1);
      }
      piezas.push({ gid, dx: pluma });
      pluma += avance;
    }
    if (x1 < x0) { x0 = 0; x1 = 0; y0 = 0; y1 = 0; } // texto en blanco
    return { piezas, avance: pluma, tinta: { x0, y0, x1, y1 } };
  }
}

// ---- Aplanar curvas cuadráticas y rellenar ----
function aplanarContorno(puntos, salida, escala, ox, oy) {
  // Coordenadas de la fuente -> pantalla (Y invertida)
  const T = (p) => ({ x: (p.x - ox) * escala, y: (oy - p.y) * escala });
  const n = puntos.length;
  if (!n) return;
  // Punto inicial sobre la curva (si no hay ninguno, se usa el punto medio)
  let iniIdx = puntos.findIndex(p => p.enCurva);
  let inicio;
  if (iniIdx < 0) {
    inicio = T({ x: (puntos[0].x + puntos[n - 1].x) / 2, y: (puntos[0].y + puntos[n - 1].y) / 2 });
    iniIdx = 0;
  } else inicio = T(puntos[iniIdx]);

  const linea = [inicio];
  let actual = inicio;
  let control = null;
  for (let k = 1; k <= n; k++) {
    const p = puntos[(iniIdx + k) % n];
    const t = T(p);
    if (p.enCurva) {
      if (control) { curva(linea, actual, control, t); control = null; }
      else linea.push(t);
      actual = t;
    } else {
      if (control) { // dos controles seguidos: hay un punto implícito en el medio
        const medio = { x: (control.x + t.x) / 2, y: (control.y + t.y) / 2 };
        curva(linea, actual, control, medio);
        actual = medio;
      }
      control = t;
    }
  }
  if (control) curva(linea, actual, control, inicio);
  salida.push(linea);
}

function curva(linea, p0, pc, p1) {
  // Pasos según el tamaño en pantalla: suficiente para que no se vean facetas
  const d = Math.abs(pc.x - p0.x) + Math.abs(pc.y - p0.y) + Math.abs(p1.x - pc.x) + Math.abs(p1.y - pc.y);
  const pasos = Math.max(2, Math.min(24, Math.ceil(d / 2.5)));
  for (let i = 1; i <= pasos; i++) {
    const t = i / pasos, u = 1 - t;
    linea.push({
      x: u * u * p0.x + 2 * u * t * pc.x + t * t * p1.x,
      y: u * u * p0.y + 2 * u * t * pc.y + t * t * p1.y
    });
  }
}

const SUBMUESTRAS = 4; // filas de muestreo por píxel (suaviza los bordes)

function rellenar(lineas, ancho, alto) {
  const aristas = [];
  for (const linea of lineas) {
    for (let i = 0; i < linea.length; i++) {
      const a = linea[i], b = linea[(i + 1) % linea.length];
      if (a.y === b.y) continue;
      aristas.push(a.y < b.y ? { x0: a.x, y0: a.y, x1: b.x, y1: b.y, dir: 1 }
                             : { x0: b.x, y0: b.y, x1: a.x, y1: a.y, dir: -1 });
    }
  }
  const cobertura = new Float32Array(ancho * alto);
  const cruces = [];
  for (let fila = 0; fila < alto; fila++) {
    const base = fila * ancho;
    for (let s = 0; s < SUBMUESTRAS; s++) {
      const y = fila + (s + 0.5) / SUBMUESTRAS;
      cruces.length = 0;
      for (const e of aristas) {
        if (y < e.y0 || y >= e.y1) continue;
        cruces.push({ x: e.x0 + (y - e.y0) * (e.x1 - e.x0) / (e.y1 - e.y0), dir: e.dir });
      }
      if (cruces.length < 2) continue;
      cruces.sort((a, b) => a.x - b.x);
      let vueltas = 0;
      for (let i = 0; i < cruces.length - 1; i++) {
        vueltas += cruces[i].dir;
        if (vueltas !== 0) tramo(cobertura, base, cruces[i].x, cruces[i + 1].x, ancho, 1 / SUBMUESTRAS);
      }
    }
  }
  const pix = new Uint8Array(ancho * alto);
  for (let i = 0; i < pix.length; i++) if (cobertura[i] >= 0.5) pix[i] = 1;
  return pix;
}

function tramo(cob, base, xa, xb, ancho, peso) {
  if (xa < 0) xa = 0;
  if (xb > ancho) xb = ancho;
  if (xb <= xa) return;
  const i0 = Math.floor(xa), i1 = Math.min(ancho - 1, Math.floor(xb - 1e-9));
  if (i0 === i1) { cob[base + i0] += (xb - xa) * peso; return; }
  cob[base + i0] += (i0 + 1 - xa) * peso;
  for (let i = i0 + 1; i < i1; i++) cob[base + i] += peso;
  cob[base + i1] += (xb - i1) * peso;
}

// ---- Carga de la fuente del sistema ----
const CARPETA_FUENTES = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'Fonts') : 'C:\\Windows\\Fonts';
// En orden de preferencia: todas son negrita (la comanda se lee de lejos)
const ARCHIVOS = ['arialbd.ttf', 'segoeuib.ttf', 'tahomabd.ttf', 'verdanab.ttf', 'calibrib.ttf', 'arial.ttf'];
const ALIAS = {
  arial: 'arialbd.ttf', 'arial bold': 'arialbd.ttf',
  segoe: 'segoeuib.ttf', 'segoe ui': 'segoeuib.ttf',
  tahoma: 'tahomabd.ttf', verdana: 'verdanab.ttf', calibri: 'calibrib.ttf'
};

const cargadas = new Map();
function cargarFuente(nombre) {
  const clave = String(nombre || 'arial').toLowerCase().trim();
  if (cargadas.has(clave)) return cargadas.get(clave);
  const candidatos = [];
  if (ALIAS[clave]) candidatos.push(ALIAS[clave]);
  if (/\.ttf$/i.test(clave)) candidatos.push(clave);
  candidatos.push(...ARCHIVOS);
  let fuente = null, error = null;
  for (const archivo of candidatos) {
    const ruta = path.isAbsolute(archivo) ? archivo : path.join(CARPETA_FUENTES, archivo);
    try {
      if (!fs.existsSync(ruta)) continue;
      fuente = new FuenteTTF(fs.readFileSync(ruta));
      break;
    } catch (e) { error = e; }
  }
  if (!fuente) throw new Error(`No se pudo cargar ninguna fuente TrueType${error ? ': ' + error.message : ''}`);
  cargadas.set(clave, fuente);
  return fuente;
}

// ---- API: dibujar un texto en un mapa de bits de 1 bit ----
// modo 'em'   : altoPx es el tamaño de la letra (como en un procesador de texto)
// modo 'tinta': altoPx es el alto REAL de las letras impresas (lo que mide la regla)
// Siempre se respeta maxAncho: si no cabe, el texto se reduce proporcionalmente.
function dibujarTexto(texto, altoPx, opciones = {}) {
  const fuente = cargarFuente(opciones.fuente);
  const medida = fuente.medir(texto);
  const tinta = medida.tinta;
  const anchoUnidades = Math.max(1, tinta.x1 - tinta.x0);
  const altoUnidades = Math.max(1, tinta.y1 - tinta.y0);
  if (!medida.piezas.length || (tinta.x1 === tinta.x0 && tinta.y1 === tinta.y0)) {
    return { pix: new Uint8Array(1), ancho: 1, alto: 1 };
  }
  const margen = opciones.margen === undefined ? 1 : opciones.margen;
  // Escala: una sola pasada, sin tanteos (antes esto costaba varios PowerShell)
  let escala = opciones.modo === 'em'
    ? altoPx / fuente.unidadesEm
    : altoPx / altoUnidades;
  // El límite de ancho es del papel: los márgenes también ocupan
  const maxAncho = Math.max(1, (opciones.maxAncho || 0) - margen * 2);
  if (opciones.maxAncho && anchoUnidades * escala > maxAncho) escala = maxAncho / anchoUnidades;

  let ancho = Math.max(1, Math.ceil(anchoUnidades * escala) + margen * 2);
  // Al ajustar al ancho del papel, los redondeos pueden pasarse por 1 punto
  if (opciones.maxAncho && ancho > opciones.maxAncho) ancho = opciones.maxAncho;
  const alto = Math.max(1, Math.ceil(altoUnidades * escala) + margen * 2);

  const lineas = [];
  for (const pieza of medida.piezas) {
    const g = fuente.glifo(pieza.gid);
    for (const contorno of g.contornos) {
      // El desplazamiento del glifo se resuelve moviendo el origen de la caja
      aplanarContorno(contorno, lineas, escala,
        tinta.x0 - pieza.dx - margen / escala,
        tinta.y1 + margen / escala);
    }
  }
  return { pix: rellenar(lineas, ancho, alto), ancho, alto };
}

module.exports = { dibujarTexto, cargarFuente, FuenteTTF };

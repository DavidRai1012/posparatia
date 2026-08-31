// Renderiza texto como imagen ESC/POS (raster GS v 0).
//
// ¿Por qué? Los multiplicadores de tamaño de ESC/POS son enteros y la SAT 15T US
// además los topa en 2x. Dibujando el texto con una fuente TrueType de Windows
// se logra CUALQUIER tamaño (2.5x, 2.7x...) y rotación de 90 grados: girado, el
// límite de 384 puntos aplica al alto de las letras y el papel es infinito.
//
// El dibujo lo hace `fuente-ttf.js` en JavaScript puro. ANTES lo hacía un
// powershell.exe por cada línea (1 a 4 segundos cada uno, y varios intentos
// cuando el nombre era largo): una comanda tardaba hasta 20 segundos con el
// servidor congelado. Ahora cada línea cuesta ~1 milisegundo.
const { dibujarTexto } = require('./fuente-ttf');

const ANCHO_PAPEL = 384; // puntos imprimibles en papel de 58mm (203 dpi)

// ---- Rotar 90 grados (horario) ----
function rotar90({ pix, ancho, alto }) {
  const out = new Uint8Array(ancho * alto);
  const w2 = alto;
  for (let y = 0; y < alto; y++) for (let x = 0; x < ancho; x++) {
    if (pix[y * ancho + x]) out[x * w2 + (alto - 1 - y)] = 1;
  }
  return { pix: out, ancho: w2, alto: ancho };
}

// ---- Empaquetar como raster ESC/POS (GS v 0) ----
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

// Dibuja y arma el raster. `altoPx` es el tamaño de la letra (como en Word).
// opciones: { rotado, fuente, centrar, maxAncho }
function rasterizarInfo(texto, altoPx, opciones = {}) {
  const maxAncho = opciones.maxAncho || ANCHO_PAPEL;
  // Girado, lo que limita el papel es el ALTO de la imagen sin girar
  let img = dibujarTexto(texto, altoPx, {
    modo: 'em', fuente: opciones.fuente,
    maxAncho: opciones.rotado ? 0 : maxAncho
  });
  if (opciones.rotado) img = rotar90(img);
  return { buffer: empaquetarRaster(img, opciones.centrar !== false), ancho: img.ancho, alto: img.alto };
}

function textoAEscposRaster(texto, altoPx, opciones = {}) {
  return rasterizarInfo(texto, altoPx, opciones).buffer;
}

// Renderiza apuntando a una ALTURA REAL en puntos (ej: 72 = "x3", lo que mide
// la letra impresa con una regla). Con caché en memoria porque los nombres de
// los platos se repiten en cada comanda.
const cacheRaster = new Map();
const MAX_CACHE = 2000; // el menú del local tiene ~300 platos: sobra de largo
function rasterizarAlturaObjetivo(texto, altoObjetivo, opciones = {}) {
  const clave = `${texto}|h${altoObjetivo}|${opciones.rotado ? 1 : 0}|${opciones.fuente || ''}|${opciones.centrar === false ? 0 : 1}`;
  const enCache = cacheRaster.get(clave);
  if (enCache) return enCache;
  const maxAncho = opciones.maxAncho || ANCHO_PAPEL;
  let img = dibujarTexto(texto, altoObjetivo, {
    modo: 'tinta', fuente: opciones.fuente,
    maxAncho: opciones.rotado ? 0 : maxAncho
  });
  if (opciones.rotado) img = rotar90(img);
  const r = { buffer: empaquetarRaster(img, opciones.centrar !== false), ancho: img.ancho, alto: img.alto };
  if (cacheRaster.size >= MAX_CACHE) cacheRaster.clear();
  cacheRaster.set(clave, r);
  return r;
}

// Pre-renderiza una lista de textos. Ya casi no hace falta (dibujar cuesta
// milisegundos), pero deja la primera comanda del día lista de todas formas.
function precalentar(textos, altoObjetivo, opciones = {}) {
  for (const t of textos) {
    try { rasterizarAlturaObjetivo(t, altoObjetivo, opciones); } catch { /* texto imposible: se ignora */ }
  }
}

// Vista previa en consola (para verificar sin gastar papel)
function previewASCII(texto, altoPx, opciones = {}) {
  let img = dibujarTexto(texto, altoPx, { modo: 'em', fuente: opciones.fuente, maxAncho: opciones.rotado ? 0 : ANCHO_PAPEL });
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

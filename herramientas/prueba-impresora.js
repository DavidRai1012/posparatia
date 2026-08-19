// Herramienta de calibración de la impresora térmica (independiente del servidor).
//
// Imprime un muestrario completo:      node herramientas/prueba-impresora.js
// Probar un texto con formato puntual: node herramientas/prueba-impresora.js --texto "CARLOS" --ancho 3 --alto 3
// Comparar varios tamaños de un texto: node herramientas/prueba-impresora.js --texto "CARLOS" --rotado --serie 2,3,4
//
// Opciones del modo puntual:
//   --texto "..."   texto a imprimir
//   --ancho 1..8    multiplicador de ancho de letra
//   --alto 1..8     multiplicador de alto de letra
//   --serie 2,3,4   imprime el texto en varios tamaños cuadrados seguidos, etiquetados
//   --fuenteB       usar la fuente B (más pequeña y angosta)
//   --negrita       texto en negrita
//   --rotado        letras giradas 90 grados (ESC V)
//   --alreves       línea completa al revés, 180 grados (ESC {)
//   --share NOMBRE  impresora compartida (por defecto POS58)

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ESC = 0x1b, GS = 0x1d, FF = 0x0c;

class Ticket {
  constructor() { this.partes = []; this.bytes(ESC, 0x40); } // reset
  bytes(...b) { this.partes.push(Buffer.from(b)); }
  texto(s) { this.partes.push(Buffer.from(s, 'ascii')); }
  linea(s) { this.texto(s + '\n'); }

  // GS ! n -> tamaño: nibble alto = ancho (0-7), nibble bajo = alto (0-7)
  tam(ancho, alto) { this.bytes(GS, 0x21, ((ancho - 1) << 4) | (alto - 1)); }
  fuente(b) { this.bytes(ESC, 0x4d, b ? 1 : 0); }        // ESC M: fuente A/B
  negrita(on) { this.bytes(ESC, 0x45, on ? 1 : 0); }     // ESC E
  subrayado(on) { this.bytes(ESC, 0x2d, on ? 1 : 0); }   // ESC -
  invertido(on) { this.bytes(GS, 0x42, on ? 1 : 0); }    // GS B: blanco sobre negro
  rotado(on) { this.bytes(ESC, 0x56, on ? 1 : 0); }      // ESC V: caracteres girados 90
  alreves(on) { this.bytes(ESC, 0x7b, on ? 1 : 0); }     // ESC {: línea 180 grados
  centrar(on) { this.bytes(ESC, 0x61, on ? 1 : 0); }     // ESC a
  normal() { this.tam(1, 1); this.fuente(false); this.negrita(false); this.subrayado(false); this.invertido(false); this.rotado(false); this.alreves(false); this.centrar(false); }
  cortar() { this.texto('\n\n\n'); this.bytes(GS, 0x56, 0x42, 0x00); }
  buffer() { return Buffer.concat(this.partes); }
}

function imprimir(buf, share) {
  const tmp = path.join(os.tmpdir(), `prueba_escpos_${Date.now()}.bin`);
  fs.writeFileSync(tmp, buf);
  try {
    execFileSync('cmd.exe', ['/c', 'copy', '/b', tmp, `\\\\localhost\\${share}`], { windowsHide: true });
    console.log(`Enviado a \\\\localhost\\${share} (${buf.length} bytes). Revise el papel.`);
  } finally {
    fs.unlinkSync(tmp);
  }
}

// ---- Argumentos ----
const args = process.argv.slice(2);
const valorDe = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const share = valorDe('--share') || 'POS58';
const textoCustom = valorDe('--texto');

const t = new Ticket();

if (textoCustom) {
  const serie = valorDe('--serie');
  const fuenteB = args.includes('--fuenteB');
  const negrita = args.includes('--negrita');
  const rotado = args.includes('--rotado');
  const alreves = args.includes('--alreves');
  const etiqueta = (a, h) => `[${a}x${h}${fuenteB ? ' fB' : ''}${negrita ? ' negrita' : ''}${rotado ? ' ROTADO 90' : ''}${alreves ? ' alreves' : ''}]`;

  const imprimirMuestra = (a, h) => {
    t.normal();
    t.linea(etiqueta(a, h));
    t.fuente(fuenteB); t.negrita(negrita); t.rotado(rotado); t.alreves(alreves);
    t.tam(a, h);
    t.linea(textoCustom);
    t.normal();
    t.linea('');
  };

  if (serie) {
    // Varios tamaños cuadrados en un mismo ticket, para comparar sin gastar papel
    const tams = serie.split(',').map(n => Math.min(8, Math.max(1, Number(n.trim())))).filter(Boolean);
    t.centrar(true); t.negrita(true); t.linea(`COMPARATIVO: ${textoCustom}`); t.normal();
    t.linea('--------------------------------');
    for (const n of tams) imprimirMuestra(n, n);
  } else {
    // ---- Modo puntual: un texto con el formato pedido ----
    const ancho = Math.min(8, Math.max(1, Number(valorDe('--ancho') || 1)));
    const alto = Math.min(8, Math.max(1, Number(valorDe('--alto') || 1)));
    imprimirMuestra(ancho, alto);
  }
  t.cortar();
} else {
  // ---- Muestrario completo ----
  t.centrar(true); t.tam(1, 2); t.linea('MUESTRARIO DE FORMATOS'); t.normal();
  t.linea('Papel 58mm = 32 columnas en 1x1');
  t.linea('--------------------------------');

  t.linea(''); t.negrita(true); t.linea('== TAMANOS (ancho x alto) =='); t.negrita(false);
  for (const [a, h] of [[1, 1], [2, 1], [1, 2], [2, 2], [3, 3], [4, 4], [6, 6]]) {
    t.normal(); t.linea(`${a}x${h}:`);
    t.tam(a, h); t.linea('Carlos 123'); t.normal();
  }

  t.linea(''); t.negrita(true); t.linea('== FUENTES Y ESTILOS =='); t.negrita(false);
  t.linea('Fuente A normal: Carlos 123');
  t.fuente(true); t.linea('Fuente B pequena: Carlos 123'); t.fuente(false);
  t.negrita(true); t.linea('Negrita: Carlos 123'); t.negrita(false);
  t.subrayado(true); t.linea('Subrayado: Carlos 123'); t.subrayado(false);
  t.invertido(true); t.linea(' INVERTIDO: Carlos 123 '); t.invertido(false);
  t.linea('Fuente B en 2x2:');
  t.fuente(true); t.tam(2, 2); t.linea('Carlos 123'); t.normal();
  t.linea('Fuente B en 3x3:');
  t.fuente(true); t.tam(3, 3); t.linea('Carlos 123'); t.normal();

  t.linea(''); t.negrita(true); t.linea('== ROTACIONES =='); t.negrita(false);
  t.linea('Letras giradas 90 (ESC V):');
  t.rotado(true); t.linea('CARLOS'); t.rotado(false);
  t.linea('Giradas 90 en 2x2:');
  t.rotado(true); t.tam(2, 2); t.linea('CARLOS'); t.normal();
  t.linea('Linea al reves 180 (ESC {):');
  t.alreves(true); t.linea('CARLOS'); t.alreves(false);

  t.linea(''); t.negrita(true); t.linea('== MODO PAGINA (vertical) =='); t.negrita(false);
  t.linea('Si abajo NO sale "VERTICAL"');
  t.linea('impreso de lado, la impresora');
  t.linea('no soporta modo pagina:');
  t.bytes(ESC, 0x4c);       // entrar a modo página
  t.bytes(ESC, 0x54, 0x01); // dirección de impresión: 90 grados
  t.tam(2, 2); t.texto('VERTICAL');
  t.bytes(FF);              // imprimir página y volver
  t.bytes(ESC, 0x53);       // asegurar modo estándar
  t.normal();

  t.linea(''); t.linea('== FIN DEL MUESTRARIO ==');
  t.cortar();
}

imprimir(t.buffer(), share);

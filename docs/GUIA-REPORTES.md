# Guía: configurar los reportes del restaurante

Esta guía es para el **administrador del restaurante**. Al terminarla va a tener:

- 📊 Una **hoja de Google Sheets** donde cada venta pagada aparece sola, en tiempo real.
- 📧 Un **correo automático** cada día al hacer el cierre de caja, con: ventas, métodos
  de pago, gastos del local, **nómina pagada** y el efectivo que debe haber en caja.

Se hace UNA sola vez y toma unos 15 minutos. Necesita una cuenta de Google (Gmail).

---

## Parte 1 — La hoja de Google Sheets (ventas en tiempo real)

1. En el computador, entre a [sheets.google.com](https://sheets.google.com) con su
   cuenta de Google y cree una hoja nueva. Póngale de nombre **Ventas Restaurante**.
2. En el menú de la hoja: **Extensiones → Apps Script**. Se abre una pestaña nueva.
3. Borre todo lo que aparece en el editor y pegue exactamente esto:

```javascript
// POS Restaurante - recibe cada venta pagada y la anota en la hoja de su mes
function doPost(e) {
  const libro = SpreadsheetApp.getActiveSpreadsheet();
  const CABECERA = ['Día', 'Hora', 'Comanda', 'Vendedor', 'Entrega', 'Entrada', 'Proteína',
                    'Bebida', 'Extras', 'Método de pago', 'Recargo', 'Total'];
  const filas = JSON.parse(e.postData.contents).filas;
  let ultima = { hoja: '', fila: 0 };
  for (const f of filas) {
    const nombre = f.hoja || 'Ventas';          // una hoja por mes: "09-2026"
    let hoja = libro.getSheetByName(nombre);
    if (!hoja) {
      hoja = libro.insertSheet(nombre, 0);       // el mes nuevo queda de primero
      hoja.appendRow(CABECERA);
      hoja.setFrozenRows(1);
    }
    hoja.appendRow([f.dia, f.hora, f.comanda, f.vendedor, f.entrega, f.entrada, f.proteina,
                    f.bebida, f.extras, f.metodo, f.recargo_total, f.total]);
    ultima = { hoja: nombre, fila: hoja.getLastRow() };
  }
  // Responder en qué hoja y fila quedó: así el POS puede confirmarlo
  return ContentService.createTextOutput(JSON.stringify({ ok: true, hoja: ultima.hoja, fila: ultima.fila }))
    .setMimeType(ContentService.MimeType.JSON);
}
```

> Cada mes tendrá su propia pestaña (por ejemplo **09-2026**) con las columnas:
> Día · Hora · Comanda · Vendedor (el administrador aparece como "Pepito Pérez (Admin)") ·
> Entrega (Local / Domicilio) · Entrada · Proteína · Bebida · Extras · Método de pago ·
> Recargo (domicilio + tarjeta) · Total. El nombre del cliente nunca se envía.

4. Guarde (icono del disquete) y luego: **Implementar → Nueva implementación**.
5. En el engranaje ⚙️ elija tipo **Aplicación web** y configure:
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier persona**
6. Clic en **Implementar**. Google pedirá autorización: acepte
   (si sale "no verificada", clic en *Configuración avanzada → Ir al proyecto*).
7. **Copie la URL** que aparece (termina en `/exec`).
8. En la app del POS: entrar como administrador → pestaña **Admin** →
   campo **"URL del webhook de Google Sheets"** → pegar la URL → **💾 Guardar configuración**.
9. Toque el botón **"🔎 Revisar Google Sheets"**. El POS revisa paso por paso y
   le dice **en qué pestaña y en qué fila** quedó la fila de prueba. Ábrala en
   la hoja: si está ahí, ya quedó y cada venta pagada se anota sola.

> ⚠️ **Lo que más falla:** editar el script y solo darle Guardar. Guardar NO
> cambia lo que está publicado. Después de pegar el script hay que ir a
> **Implementar → Administrar implementaciones → ✏️ → Versión: "Nueva versión"
> → Implementar**. Si no, Google sigue ejecutando el código viejo. El
> solucionador del POS detecta justo eso y lo avisa.

> Nota de privacidad: el nombre de los clientes NO se envía a Google Sheets.

> Si el restaurante se queda sin internet, las ventas se guardan en el PC y se
> suben solas apenas vuelva la conexión. No se pierde nada.

---

## Parte 2 — El correo del reporte diario

El correo se envía **al hacer el Cierre de caja** (y, de respaldo, a la hora
configurada si ese día se olvidó el cierre). Para poder enviarlo, Google exige
una "contraseña de aplicación" (una clave especial de 16 letras que solo sirve
para esto; su clave normal de Gmail no se usa nunca).

1. **Activar la verificación en dos pasos** (si no la tiene):
   [myaccount.google.com/security](https://myaccount.google.com/security) →
   "Verificación en 2 pasos" → seguir los pasos con su número de celular.
2. **Crear la contraseña de aplicación**:
   [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) →
   en "Nombre de la app" escriba `POS Restaurante` → **Crear** →
   Google muestra **16 letras** (ejemplo: `abcd efgh ijkl mnop`). Cópielas.
3. En la app del POS → **Admin** → sección de reporte:
   - **Correo del dueño**: el correo donde quiere RECIBIR el reporte.
   - **Cuenta Gmail que envía**: su dirección de Gmail.
   - **Contraseña de aplicación**: las 16 letras (con o sin espacios, da igual).
   - **Hora del reporte**: la hora del envío de respaldo (ej: 21:30).
   - **💾 Guardar configuración**.
4. Pruebe con el botón **"📨 Enviar reporte ahora"** y revise su bandeja de
   entrada (mire también en Spam la primera vez).

### Qué llega en el correo

```
REPORTE DIARIO - Jornada 2026-08-19
Ventas totales, pedidos, cancelados
Por método de pago (efectivo, tarjeta, Nequi, Daviplata, QR Bancolombia)
  (incluye los recargos por tarjeta cobrados)
Por vendedor
GASTOS DEL LOCAL (detallados, con quién los registró)
NÓMINA PAGADA (por empleado: turno, descuentos, bonos)
Efectivo esperado en caja  ← para comparar con lo contado
CIERRE DE CAJA (efectivo contado y descuadre)
```

---

## Problemas comunes

| Síntoma | Solución |
|---|---|
| "Probar Google Sheets" da error | Revise que la URL termine en `/exec` y que la implementación diga "Cualquier persona" |
| No llega el correo | Revise Spam; verifique las 16 letras y que la verificación en 2 pasos esté activa |
| El reporte llegó "con retraso" | Es normal: no había internet a esa hora; el sistema lo envió al reconectarse |
| Cambié de hoja de Sheets | Repita la Parte 1 con la hoja nueva y pegue la URL nueva en Admin |

---

## Si la prueba de Google Sheets falla

El botón "📊 Probar Google Sheets" ahora dice exactamente qué pasó:

| Mensaje | Qué hacer |
|---|---|
| "Google pidió iniciar sesión..." | El Apps Script quedó implementado con el acceso equivocado. Vuelva al editor → **Implementar → Administrar implementaciones → ✏️ → Quién tiene acceso: Cualquier persona** → Implementar, y pegue la **URL nueva** en el POS. |
| "Internet no respondió en 15 segundos" | El PC no tiene salida a internet en este momento (¿el teléfono que comparte los datos tiene señal/datos?). Las ventas quedan en cola y suben solas después. |
| "La URL no respondió como el Apps Script de la guía" | Se pegó un enlace equivocado (por ejemplo el de la hoja). El correcto es el que sale al Implementar y **termina en `/exec`**. |

> El internet NO afecta la app local: los teléfonos siguen tomando pedidos y
> la impresora sigue imprimiendo aunque no haya datos. Todo lo de internet
> (Sheets y correo) espera en cola y sale solo cuando vuelva la señal.

---

## Si ya tenía la hoja de la versión anterior (una sola pestaña)

El formato cambió a **una pestaña por mes**. Hay dos caminos:

**A) Actualizar el script en la misma hoja (la URL no cambia):**
1. Abra la hoja → **Extensiones → Apps Script** → borre todo y pegue el script nuevo de arriba → Guardar.
2. **Implementar → Administrar implementaciones → ✏️ (editar) → Versión: "Nueva versión" → Implementar.**
3. Listo: la URL del POS sigue siendo la misma. Las ventas nuevas caen en la pestaña del mes;
   la pestaña vieja queda como historial.

**B) Hoja nueva desde cero:** siga la Parte 1 completa; al final pegue la URL nueva en el POS
(Admin → URL del webhook) y pruebe con "📊 Probar Google Sheets".

## Qué correos llegan y cuándo

| Cuándo | Correo | Adjuntos |
|---|---|---|
| Cada **cierre de caja** | Reporte diario (ventas, métodos de pago con almuerzos por método, vendedores, tipos de proteína, gastos, nómina, caja) | `resumen-FECHA.xlsx` (hoja 1: el mismo resumen · hoja 2: ventas una a una). Si ese día se pagó nómina, también `nomina-AÑO.xlsx` (una hoja por mes). |
| **Último día del mes** (o el primer cierre después, si ese día no abrieron) | Nómina del mes | `nomina-AÑO-MES.xlsx` (hoja RESUMEN + la del mes, por empleado) |
| Ídem | Resumen mensual | `resumen-AÑO-MES.xlsx` (hoja 1: resumen con tabla día por día · hoja 2: todas las ventas del mes · platos · tipos · gastos) |

Desde **Admin** se puede reenviar el reporte de hoy ("📨 Enviar reporte ahora") y los dos
correos de cualquier mes ("📅 Enviar reportes del mes").

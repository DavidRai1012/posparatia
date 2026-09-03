# Novedades de la versión 8

## 1. Crear almuerzos sin escribir el precio

Estaba pasando esto: al elegir una clase que **no** tiene precio por defecto
(por ejemplo "Entrada"), la casilla *"Usar el precio por defecto"* se
desmarcaba — y al volver a "Proteína del día" se quedaba desmarcada, así que
volvía a pedir el precio de cada almuerzo.

Ya quedó: al cambiar de clase, la casilla se vuelve a marcar sola cuando esa
clase tiene precio por defecto. Para cargar el menú del día solo hay que
escribir el nombre y dar Enter. Si aun así falta el precio, el aviso ahora dice
qué hacer: *"Escriba el precio o marque «Usar el precio por defecto»"*.

## 2. La comanda muestra el total

La comanda de cocina ahora termina con el **total a cobrar**, sin el precio de
cada plato (no es una factura):

```
--------------------------------
(incluye domicilio $2.000)
(incluye recargo tarjeta $1.000)
TOTAL $20.500
Pagado: Tarjeta
--------------------------------

Nombre: David
```

- El total incluye el **domicilio** y el **recargo por tarjeta** cuando aplican,
  y cada uno se anuncia en su línea para que se entienda de dónde sale.
- Debajo dice **"Pagado: <método>"** o **"PENDIENTE DE PAGO"**, que es lo que
  necesita saber quien entrega el pedido.

## 3. Solucionador de Google Sheets

En **Admin** el botón cambió a **"🔎 Revisar Google Sheets"**. Ya no solo manda
una fila y dice "listo": revisa paso por paso y dice **qué corregir**.

| Revisa | Qué detecta |
|---|---|
| Enlace configurado | Que sea el de la implementación y termine en `/exec` |
| Internet en el PC | Si no hay señal (las ventas quedan en cola, no se pierden) |
| Respuesta del Apps Script | Errores del script, o la página de login de Google (acceso mal puesto) |
| **Versión del Apps Script** | Si Google está ejecutando el **código viejo** |
| **Fila escrita** | **En qué pestaña y en qué fila** quedó la fila de prueba |
| Ventas en espera | Cuántas ventas faltan por subir |

**Por qué no funcionaba la hoja:** el solucionador lo detectó de una. La
implementación publicada es la **versión anterior** del Apps Script, así que
Google seguía ejecutando el código viejo (una sola hoja, formato viejo) aunque
el POS enviara el formato nuevo. Respondía "ok" y por eso parecía que todo
estaba bien.

> ⚠️ **El error más común:** editar el script y darle solo **Guardar**. Guardar
> NO cambia lo que está publicado. Hay que ir a **Implementar → Administrar
> implementaciones → ✏️ → Versión: "Nueva versión" → Implementar**.

Para que el POS pueda confirmar la fila, el script nuevo de la guía ahora
responde en qué hoja y fila escribió. Con él, el solucionador dice:

> ✅ Funciona. La prueba quedó en la hoja "09-2026", fila 24.

Si no coincide con la hoja que usted está mirando, es que el enlace apunta a
**otra hoja de cálculo** — otra causa que antes era imposible de ver.

## Qué hacer en el restaurante

1. Abrir la hoja → **Extensiones → Apps Script** → borrar todo y pegar el
   script de [GUIA-REPORTES.md](GUIA-REPORTES.md).
2. **Implementar → Administrar implementaciones → ✏️ → Versión: "Nueva versión"
   → Implementar.** (La URL no cambia.)
3. En el POS: **Admin → 🔎 Revisar Google Sheets**. Debe decir en qué pestaña y
   fila quedó la prueba.
4. Borrar de la hoja las filas de prueba que quedaron ("PRUEBA DEL SOLUCIONADOR").

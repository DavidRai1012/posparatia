# Novedades de la versión 7

## 1. El correo del reporte, mejorado y con Excel adjunto

El correo del cierre de caja ahora llega **legible en el celular** (tablas por
sección) y **con el Excel del día adjunto**, con dos hojas:

1. **Resumen del día**: exactamente lo mismo que dice el correo.
2. **Ventas**: las ventas una a una de ese día, con el mismo formato de la hoja
   de Google (Día, Hora, Comanda, Vendedor, Entrega, Entrada, Proteína, Bebida,
   Extras, Método de pago, Recargo, Total, Estado).

Si ese día se pagó nómina, también va adjunto el **Excel de nómina** (ver punto 3).

Desde Admin, "📨 Enviar reporte ahora" manda el correo de hoy con sus adjuntos.

## 2. Reportes mensuales

El **último día del mes**, cuando la cajera hace el cierre de caja, salen **dos
correos más**:

- **Nómina del mes**: total por empleado y el Excel de nómina del mes.
- **Resumen mensual**: ventas, métodos de pago, vendedores, tipos de proteína,
  gastos, nómina, y una tabla **día por día** (ventas, cobrado, gastos, nómina,
  efectivo esperado, contado, descuadre). Adjunto: Excel con ese resumen, todas
  las ventas del mes una a una, platos vendidos, tipos y gastos.

Si el último día del mes no abrieron, salen en el primer cierre del mes
siguiente. Cada mes se reporta una sola vez. Desde Admin → "📅 Enviar reportes
del mes" se pueden reenviar los de cualquier mes. Y en Caja hay "📥 Excel del
mes" para descargarlo cuando quiera.

## 3. Excel de nómina: una hoja por mes (estilo Kardex)

- Hoja **RESUMEN**: empleados × meses, con totales.
- **Una hoja por mes** (ej: `09-2026`): los pagos de ese mes **agrupados por
  empleado** con subtotal, y el total del mes al final. Como a cada empleado se
  le paga distinto (días sin pago, días con varios), se lista lo que realmente
  se pagó: fecha, día de la semana, turno, descuento, bono, concepto, total y
  cuándo lo confirmó.

## 4. Dinero con el que arrancó el día (base de caja)

Al principio de la **Caja** aparece "💵 Dinero con el que arrancó el día":

- Si no se registra nada, se asume que **lo contado en el cierre de ayer** sigue
  en la caja (y si ayer no se contó, lo que el sistema esperaba que hubiera).
- Si la cajera cuenta y no coincide (el cajero de ayer se equivocó), escribe el
  valor real y lo registra. Queda anotado quién lo registró.
- El **efectivo esperado** ahora es: base + ventas en efectivo − gastos − nómina.
  El cierre compara lo contado contra eso.

> Si el dueño se lleva el efectivo al final del día, la cajera debe registrar
> cada mañana con cuánto arranca (o dejar $0 si la caja quedó vacía).

Si quedaron **días con ventas sin cierre**, el efectivo de esos días también
está en la caja y nadie lo contó: la app avisa en amarillo y pide contar la
caja y registrar la base a mano, en vez de dar un número falsamente exacto.

## 5. Corregir el TOTAL del día por método de pago

En Caja → "🔁 Rectificar métodos de pago" hay una sección nueva: **corregir el
total del día por método** (por ejemplo, el Nequi real según el extracto). El
reporte muestra el total corregido y anota que "pago a pago sumaba $X".

**Lo que pidieron y por qué sale la palabra APROXIMADO:** al corregir un total
ya no se sabe a qué pedidos corresponde, así que los **almuerzos de ese método
se estiman** dividiendo el total entre el precio del almuerzo completo, y en
todos los reportes aparecen marcados como **APROXIMADO**. Si en cambio se
corrige **pago por pago** (el selector de cada fila, como antes) sin tocar el
total, el conteo de almuerzos sigue siendo exacto y no dice aproximado. Dejar
el campo vacío quita la corrección.

Dos detalles importantes de cómo quedó hecho:

- **La corrección se guarda como diferencia**, no como un total congelado. Si
  después de corregir entra un pago nuevo, se anula una comanda o se rectifica
  un pago, el total real se mueve con ellos (antes ese dinero se perdía del
  reporte). Si los pagos cambiaron después de corregir, el reporte lo avisa:
  *"hubo pagos nuevos o anulados después de corregir: verifique contra el
  extracto"*.
- **El efectivo NO se corrige aquí.** No tiene extracto contra el cual cuadrar,
  y permitirlo dejaría fijar el efectivo esperado al valor que tenga la caja:
  el descuadre siempre daría cero y el control se perdería. El efectivo se
  cuadra con la base del día y el conteo del cierre.

En el resumen de Caja y en todos los reportes ahora aparecen los **almuerzos
por método de pago**.

## 6. El administrador aparece con su cargo

En todos los reportes, Excel y en la hoja de Google, quien tiene rol de
administrador aparece como **"Pepito Pérez (Administrador)"** (en la hoja de
Google, "(Admin)"). Para que salga el nombre real del gerente, en Admin → 🔑 se
le cambia el nombre al usuario "Administrador" por el suyo.

## 7. Google Sheets: una pestaña por mes

La hoja en tiempo real cambia de formato: **una pestaña por mes** (`09-2026`)
con las columnas Día, Hora, Comanda, Vendedor, Entrega (Local / Domicilio),
Entrada, Proteína, Bebida, Extras, Método de pago, Recargo y Total. Sin la
columna del cliente.

**Hay que actualizar el Apps Script** (2 minutos): la guía
[GUIA-REPORTES.md](GUIA-REPORTES.md) trae el script nuevo y los dos caminos
(actualizar el de la hoja actual sin cambiar la URL, o crear una hoja nueva).
Mientras no se actualice, el POS sigue mandando las ventas con el formato viejo
a la hoja vieja: no se pierde nada.

> Se conservaron dos columnas que no estaban en la lista pedida porque sin
> ellas se pierde información que ya usan: **Método de pago** (para cuadrar el
> Nequi cada día) y **Bebida** (el jugo incluido, igual que en el Excel). Si
> sobran, se quitan del script en un minuto.

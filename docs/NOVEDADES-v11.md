# Novedades de la versión 11

(Incluye todo lo de la versión 10: roles de nómina con valor por día, Excel en
tiempo real opcional con aviso en la app, ventana negra silenciosa y
minimizada. Ver NOVEDADES-v10.md.)

## Reenviar reportes desde Caja

En **Caja** hay una tarjeta nueva, **"📨 Reenviar reportes al correo del
dueño"**, que pueden usar el cajero y el administrador. Tres opciones:

1. **📨 Reporte de un día**: se elige el día (hoy o cualquiera anterior). Va el
   mensaje con el resumen del día, el **Excel del día** (resumen + ventas una a
   una) y el **Excel de nómina del mes** de ese día.
2. **📅 Reporte de un mes**: se elige el mes. Va el mensaje con el resumen del
   mes (incluida la nómina pagada y los días trabajados), el **Excel del mes**
   (resumen con tabla día por día, todas las ventas, platos, tipos y gastos) y
   el **Excel de nómina de ese mes**. Si es el mes en curso, avisa que va
   parcial.
3. **👥 Solo la nómina de un mes**: se elige el mes, también de meses
   anteriores. Va el mensaje con lo pagado por empleado y los días trabajados
   por rol, y el **Excel de nómina de ese mes**.

Cada botón pregunta antes de enviar y luego dice si **salió** o si **quedó en
cola** (sin internet, o si falta configurar el Gmail): en cola sale solo apenas
se pueda. Un reenvío no reemplaza al reporte automático: el del cierre sale
igual a su hora.

## Los reportes automáticos ahora llevan todo

- El **reporte diario** (cierre de caja u hora de cierre) siempre lleva los dos
  Excel: el del día y el de nómina del mes. Antes el de nómina solo iba los días
  que se pagaba.
- El **reporte del mes** (último día del mes o el primer cierre después) es
  ahora **un solo correo** con el mensaje y los dos Excel, en vez de dos correos
  separados. Si se quiere la nómina aparte, está el botón "Solo la nómina".

Los botones "Enviar reporte ahora" y "Enviar reportes del mes" de Admin se
quitaron: todo eso está en Caja.

# Novedades de la versión 9

## 1. Nómina en dos pasos: turnos y pagos (como el Kardex)

La nómina cambió de lógica. Antes "registrar" y "pagar" eran lo mismo; ahora son
dos cosas, igual que en la tarjeta Kardex que llevaban a mano:

1. **Turno**: el día que vino cada quien y **qué hizo** ese día. Un mismo
   empleado puede ser cajero el viernes, auxiliar de caja el lunes y auxiliar
   de cocina el domingo. Se registra así de fácil: empleado, día, cargo.
2. **Pago**: cuando se le paga el acumulado, se marcan los turnos que entran en
   ese pago (uno, tres, la quincena entera) y el empleado confirma en su
   teléfono, como antes.

Todo vive en un **submenú propio**: Caja → **"👥 Turnos y pagos de nómina →"**.
Ahí están:

- **Registrar turno**: empleado (con su cargo habitual preseleccionado), día,
  cargo y nota opcional. El valor sale del cargo; la cajera no lo puede cambiar.
  Si se registra dos veces el mismo cargo el mismo día, avisa (y deja hacerlo
  si de verdad fue doble turno).
- **Turnos sin pagar**, por empleado: se desmarcan los que no entran, se pone
  descuento o bono si aplica, y el botón dice cuánto se paga.
- **Pendientes de confirmación** por el empleado.
- **Historial del mes** (elija el mes): los **días trabajados** de cada uno con
  su cargo y si ya se pagó, y los **pagos** con qué turnos incluyeron.
- **Totales pagados** (hoy, semana, quincena, mes) y lo que falta por pagar.
- El **Excel de nómina**.

### Cargos y valores (Admin)

En **Admin → 👥 Cargos de nómina** el administrador define los cargos y cuánto
vale un turno de cada uno; sábado y domingo pueden valer distinto (vacío =
igual que el valor normal). Vienen creados Cajero, Auxiliar de caja, Auxiliar
de cocina, Mesero y Cocinera **con valor en cero**: hay que ponerles el valor
antes de poder registrar turnos con ellos (la app lo avisa).

A cada usuario se le puede fijar un **cargo habitual** (Admin → tarjeta del
usuario) para que salga preseleccionado; el día que haga otra cosa, se cambia
al registrar el turno.

### Corregir y borrar días pasados (solo administrador)

Lo que pidieron por la nómina pagada por error hoy: el administrador puede,
desde el historial de cualquier mes:

- **Borrar un pago** (también de días pasados). Sus turnos vuelven a quedar
  **sin pagar** —no se pierden— y el dinero deja de contarse como salido de la
  caja ese día.
- **Corregir un pago**: descuento, bono y concepto; el total se recalcula con
  sus turnos.
- **Corregir o borrar un turno** (día, cargo, valor, nota). Si el turno ya está
  pagado, primero hay que borrar ese pago, para que ningún pago quede con una
  suma que no cuadra.

Cada corrección queda anotada en el historial interno con quién la hizo.

### Lo que ya existía se conservó

Los pagos registrados hasta hoy se convirtieron automáticamente en un turno
cada uno (con el cargo según el rol del usuario y el valor que tenían), así el
Kardex de días trabajados queda completo hacia atrás. Nada se perdió.

## 2. Excel de nómina, estilo Kardex

Una hoja por mes. Dentro, por empleado:

- **Días trabajados**: fecha, día de la semana, cargo, valor, nota y si ya está
  pagado (y cuándo) o **SIN PAGAR**.
- **Pagos**: fecha, qué turnos incluyó, suma, descuento, bono, total, concepto
  y confirmación.

Y la hoja RESUMEN (empleado × mes) con lo pagado. Este Excel es el que se
adjunta al correo los días que se paga nómina y en el reporte mensual, que
ahora también dice cuántos días trabajó cada quien en cada cargo.

## 3. Hora de cierre por día de la semana

La hora fija del reporte de respaldo ya no va: en **Admin → 🕐 Hora de cierre
por día** se pone una hora para cada día de la semana. Si ese día se olvida el
cierre de caja, a esa hora sale solo el reporte. Un día en blanco usa la hora
general de siempre.

---

## Qué hacer en el restaurante después de instalar

1. **Admin → 👥 Cargos de nómina**: ponerle el valor a cada cargo (y a sábado
   y domingo si pagan distinto). Agregar los que falten.
2. **Admin → usuarios**: elegir el cargo habitual de cada empleado.
3. **Admin → 🕐 Hora de cierre por día**: las horas de cada día.
4. **Caja → Turnos y pagos de nómina**: borrar el pago de hoy que salió por
   error (🗑 en el historial); sus turnos quedan sin pagar para pagarlos bien.

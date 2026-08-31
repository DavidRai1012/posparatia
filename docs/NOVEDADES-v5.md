# Novedades de la versión 5

## 1. La comanda sale de inmediato (el problema de los 20 segundos)

**Qué pasaba:** los platos se imprimen como imagen (la letra de la impresora topa
en 2x). Esa imagen la dibujaba un programa de Windows (PowerShell) que hay que
arrancar de cero **por cada línea del ticket**: entre 1 y 4 segundos cada vez, y
con los nombres largos había que repetir el intento varias veces hasta que
cupiera en el papel. Una comanda con varios platos distintos podía tardar 20
segundos, y mientras tanto **el servidor quedaba congelado**: los otros teléfonos
también esperaban.

Con 300 platos en el menú era peor todavía, porque cada plato nuevo era la
primera vez que se dibujaba, y al arrancar el PC (o al tocar cualquier plato del
menú) el sistema intentaba pre-dibujar los 300 → varios minutos pegado.

**Qué se hizo:** ahora el texto se dibuja dentro del mismo POS, leyendo la letra
Arial de Windows. Mismo resultado en papel, pero **1 milisegundo por línea**.

| | Antes | Ahora |
|---|---|---|
| Comanda de 3 almuerzos con platos nuevos | hasta 20 s | 0,04 s |
| Preparar los 300 platos del menú | más de 5 minutos | 0,2 s |
| Servidor bloqueado mientras tanto | sí | no |

También se aceleró la app en el teléfono: tocar un plato ya no vuelve a dibujar
la lista completa (con 200 platos eso se sentía pesado) y la pantalla de pedido
ya no se redibuja cada vez que otro mesero registra una venta.

**Buscador de platos:** si una pantalla tiene más de 12 platos aparece arriba una
barra de búsqueda. Escribir "cham" basta para encontrar "Crema de champiñones"
(ignora tildes y mayúsculas).

## 2. La bebida incluida también va con los platos vendidos solos

Si el cliente pide una proteína del día o un especial **sin entrada**, ahora se
le puede agregar el jugo incluido (va en $0). El sistema permite una bebida por
cada almuerzo completo **más** una por cada plato del día vendido solo; si se
pasa, avisa antes de enviar.

## 3. Tipo de plato (pollo, carne, cerdo...)

En la pestaña **Menú** hay una tarjeta **🏷️ Tipos de plato**: cualquier mesero o
cajero puede agregar o quitar tipos (vienen Pollo, Carne, Cerdo, Pescado, Pasta
y Vegetariano). Después, a cada proteína del día o especial se le asigna su tipo:

- al crearla, en el selector **"Tipo (para compras)"**;
- o directamente desde la lista del menú, con el selector que aparece debajo de
  cada proteína (así se pueden clasificar muchas de corrido).

## 4. Reportes de qué se vendió

Con los tipos asignados, ahora se sabe **qué comprar más**:

- **Caja → Resumen del día**: "Almuerzos por tipo" (ej: Pollo 23, Carne 15) y
  "Platos vendidos hoy" (ej: Pollo a la jardinera 12).
- **Excel del día**: dos hojas nuevas, *Platos vendidos* y *Por tipo*.
- **Excel por rango de fechas** (Caja → "Qué se vendió entre dos fechas"): las
  mismas dos hojas para una semana, una quincena o un mes.
- **Correo del dueño**: incluye los almuerzos por tipo y la lista de proteínas
  vendidas, de la más vendida a la menos.

Los platos sin tipo asignado aparecen agrupados como "Sin tipo".

## 5. Precio por defecto del almuerzo

En **Menú → 💲 Precio del almuerzo (por defecto)** se configuran cuatro valores:

| | Con entrada | Vendido solo |
|---|---|---|
| Proteína del día | $17.500 | $17.000 |
| Especial | $26.000 | $25.000 |

Al crear un plato viene marcada la casilla **"Usar el precio por defecto"**: no
hay que escribir el precio, solo el nombre. Cuando suba el precio el año que
viene, se cambia **una sola vez** y todos los platos marcados quedan
actualizados. Los platos con precio distinto (por ejemplo la bandeja paisa) se
crean con la casilla desmarcada y conservan el suyo.

> Las ventas ya registradas **nunca** cambian de precio: cada comanda guarda el
> precio que tenía el día que se vendió.

---

## Qué hacer en el restaurante después de instalar

1. **Menú → 💲 Precio del almuerzo**: confirmar los cuatro precios del año.
2. **Menú → botón "Poner el precio por defecto a las N proteínas del día"**: pasa
   de golpe todas las proteínas al precio por defecto. Antes de aceptar, el aviso
   lista las que hoy tienen otro precio (esas quedarían igualadas: si alguna debe
   conservar el suyo, cancele y desmárquela después con ✏️).
3. **Menú → 🏷️ Tipos de plato**: ajustar la lista si falta alguno.
4. Asignar el tipo a las proteínas con el selector de cada fila de la lista.
   No hay que hacerlo todo el mismo día: los platos sin tipo salen como
   "Sin tipo" en el reporte hasta que se clasifiquen.

# Novedades de la versión 6

## 1. Lo que pasó con Google Sheets (y los teléfonos que no conectaban)

Se revisó a fondo y son **dos cosas distintas** que pasaron al tiempo:

**a) El link de Sheets NO daña la app.** Se comprobó con pruebas: aunque la URL
esté mala o el internet muerto, el POS local sigue atendiendo a los teléfonos
normalmente. Las ventas quedan en cola y se suben solas cuando hay internet.

**b) Lo de los teléfonos fue la dirección del hotspot.** Cuando el hotspot del
teléfono se apaga y se prende (o se toca la configuración de datos), Android
muchas veces le entrega **otra dirección** al PC. El QR que estaba en la
pantalla quedaba viejo y los teléfonos que lo escaneaban "no podían conectar".

Lo que se corrigió:

- **El QR de la pantalla de login ahora se actualiza solo** cada 20 segundos:
  si el hotspot cambió de dirección, el QR en pantalla ya es el nuevo.
- El botón 📶 ahora muestra un **diagnóstico**: si el PC tiene salida a
  internet o no, y cuántos envíos (Sheets/correo) están en cola. Así se
  distingue de una vez "no hay internet" (todo local funciona) de "el WiFi
  está caído" (los teléfonos no alcanzan al PC).
- **Tope de 15 segundos** a todo lo que sale a internet. Antes, un hotspot con
  los datos agotados (acepta la conexión pero no responde) dejaba el botón
  "Probar Google Sheets" colgado hasta 5 minutos, y el **cierre de caja** podía
  quedarse esperando el correo hasta 2 minutos. Ahora todo corta a los 15 s con
  un mensaje claro y queda en cola.
- **Falla grave corregida**: si el Apps Script se implementa con acceso
  distinto de "Cualquier persona", Google responde su página de login *como si
  todo estuviera bien* y el POS marcaba las ventas como enviadas **sin llegar
  jamás a la hoja**. Ahora el POS verifica la respuesta real del Apps Script;
  si está mal implementado, avisa exactamente qué corregir.

> Al probar la hoja en el restaurante: pegue la URL que termina en `/exec`,
> guarde y use "📊 Probar Google Sheets". Si sale el aviso de "Cualquier
> persona", vuelva a Implementar el Apps Script con ese acceso (paso 5 de la
> guía) y pegue la URL nueva.

## 2. Valor del turno por día de la semana

En **Admin**, el botón 💰 de cada empleado abre el submenú de turnos:

- Un **valor base** y un valor para **cada día** (lunes a domingo).
- Los días vacíos (o en 0) usan el valor base.
- En la Caja, al registrar nómina, el campo del turno **cambia solo según la
  fecha elegida** y muestra el día ("(sábado)").
- El cajero no puede alterar ese valor: el servidor usa el del día aunque le
  manden otro. Solo el admin puede escribir un valor distinto.

## 3. Eliminar usuarios

Cada usuario tiene ahora 🗑 **Eliminar** además de Desactivar:

- Si nunca registró nada, se **borra por completo**.
- Si tiene ventas o nómina en la historia, **desaparece de todas las listas**
  pero los reportes y Excel de días pasados conservan su nombre (no se daña
  ninguna cuenta vieja).
- En ambos casos su **PIN queda libre** para asignárselo a otro empleado.
- Protección: no se puede eliminar uno a sí mismo ni al único administrador.
- **Desactivar** sigue igual, para ausencias temporales (el PIN se conserva).

## 4. LA CAUSA REAL de "no se conecta ningún teléfono"

Encontrada y corregida. **No era el cortafuegos ni la hoja de Sheets.**

Cuando el PC tiene **varias redes al tiempo** (el cable de red *y* el hotspot
del teléfono), el POS elegía cuál anunciar con una regla fija que prefería las
direcciones `192.168.x` sobre las `10.x`. En el caso real, el cable era
`192.168.0.3` y el hotspot `10.153.1.157`: el QR mostraba la del **cable**,
donde no hay ningún mesero. Los teléfonos, colgados del hotspot, no podían
alcanzar esa dirección — por eso al desconectar el cable "se arregló solo".

Lo que se corrigió:

- **El POS aprende cuál dirección sirve de verdad.** Cada vez que un teléfono
  habla con el servidor, queda anotada la dirección del PC por la que lo
  alcanzó, y esa pasa a ser la que anuncia el QR. Queda guardada, así que
  sobrevive reinicios del PC.
- **Cuando un teléfono pregunta, se le responde su propia vía**, que con
  seguridad funciona.
- **La pantalla de login muestra un QR por cada red del PC** (la recomendada
  grande y las otras debajo, con su nombre de red). Si la primera no abre, se
  escanea la de al lado: la primera conexión ya no puede fallar.
- Se les da preferencia a los rangos típicos de hotspot de teléfono
  (`192.168.43.x` de Android, `172.20.10.x` de iPhone, `192.168.137.x` de
  Windows).

## 5. Seguridad (encontrado en la revisión)

- **El teléfono de un empleado eliminado o desactivado quedaba adentro.** La
  sesión vivía en memoria hasta reiniciar el PC: podía seguir tomando comandas
  que salían por la impresora y viendo las ventas del día. Ahora, al eliminar,
  desactivar o cambiarle el PIN a alguien, su sesión se cierra en el acto.
- **El canal en vivo aceptaba dispositivos sin sesión.** Cualquier equipo en el
  WiFi del local podía quedarse escuchando y recibir todas las comandas del día
  (platos, totales y nombre del cliente) sin poner ningún PIN. Ahora sin sesión
  válida se rechaza la conexión.

# Especificaciones del Sistema de Restaurante (Plazoleta de Comidas)
## Requerimientos y Casos de Uso en Formato Gherkin

Documento de especificación de comportamiento (BDD) para el sistema de pedidos, comandas térmicas con llamado por voz, contingencias locales y sincronización de reportes.

---

```gherkin
# language: es
Característica: Registro de pedidos y atribución de ventas
  Como vendedor de la plazoleta
  Quiero registrar un pedido a mi nombre y con el nombre del comensal
  Para atribuir la venta y enviar la orden a cocina

  Escenario: Registro y atribución de la venta al vendedor activo
    Dado que el vendedor "David" tiene su sesión activa en la app web
    Cuando registra un pedido de "Menú del Día" a nombre del comensal "Carlos Ruiz"
    Entonces el sistema debe guardar el pedido asociado al vendedor "David"
    Y el estado del pedido debe quedar como "Pendiente en Cocina"
    Y la app debe mostrar en pantalla el mensaje "Comanda enviada con éxito"
```

---

```gherkin
# language: es
Característica: Impresión de comanda térmica para cocina
  Como despachador de cocina
  Quiero que la comanda resalte visualmente el nombre del comensal
  Para identificarlo de inmediato y gritar su nombre cuando el pedido esté listo

  Escenario: Generación del ticket de cocina optimizado para llamado por voz
    Dado que existe un pedido registrado para el comensal "Carlos Ruiz" con el plato "Pollo al horno"
    Cuando el servidor envía la orden de impresión mediante comandos ESC/POS
    Entonces el ticket impreso debe mostrar el encabezado "LLAMAR: CARLOS RUIZ" con formato de doble alto y doble ancho
    Y el ticket debe mostrar el plato "Pollo al horno" con formato de doble alto
    Y el ticket debe incluir la hora actual en tamaño de texto estándar
    Y el ticket no debe incluir el nombre del vendedor
```

---

```gherkin
# language: es
Característica: Personalización de platos en comanda térmica
  Como cocinero
  Quiero identificar rápidamente las modificaciones o notas especiales en el ticket
  Para preparar el pedido según las preferencias del comensal

  Escenario: Impresión de personalizaciones críticas del plato
    Dado que se registra un pedido del plato "Churrasco" con la nota "Término 3/4, sin ensalada"
    Cuando se genera la comanda para cocina
    Entonces el ticket debe incluir el texto ">> NOTA: Término 3/4, sin ensalada"
    Y la nota debe imprimirse con formato en negrita y doble alto
    Y la nota debe ubicarse inmediatamente debajo del plato "Churrasco"
```

---

```gherkin
# language: es
Característica: Gestión de pedidos para llevar y recargo por empaque
  Como mesero
  Quiero registrar un pedido como "Para llevar" y aplicar el recargo configurable
  Para cobrar el valor correspondiente del icopor y alertar a cocina sobre el tipo de empaque

  Escenario: Registro de pedido telefónico para llevar con recargo y marca en comanda
    Dado que el restaurante tiene configurado un recargo de "$1.500" por empaque de icopor
    Y el mesero ingresa los platos de un pedido recibido por llamada para el cliente "Marcela Gómez"
    Cuando selecciona la opción "Para llevar" y confirma el pedido
    Entonces el sistema debe añadir el recargo de "$1.500" al valor total de la cuenta
    Y el ticket de cocina debe imprimir el encabezado "PARA LLEVAR / EMPACAR" en texto destacado
    Y el registro del pedido debe quedar clasificado con el tipo de entrega "Para llevar"
```

---

```gherkin
# language: es
Característica: Registro de métodos de pago para arqueo de caja
  Como administrador del restaurante
  Quiero que los pagos electrónicos queden discriminados para el cierre de caja
  Para cuadrar las cuentas diarias sin enviar datos financieros innecesarios a la cocina

  Esquema del escenario: Registro de pago electrónico sin impresión en comanda
    Dado que existe un pedido para el comensal "Andrés López" por valor de "$35.000"
    Cuando el cajero procesa el pago seleccionando el método "<metodo_pago>"
    Entonces el sistema debe computar el monto de "$35.000" bajo el concepto de "<metodo_pago>" para el reporte de cierre de caja
    Y el ticket impreso para cocina no debe incluir el método de pago ni el valor de la transacción

    Ejemplos:
      | metodo_pago        |
      | Tarjeta de débito  |
      | Tarjeta de crédito |
      | Billetera virtual  |
```

---

```gherkin
# language: es
Característica: Cancelación de pedidos en preparación
  Como mesero
  Quiero cancelar un pedido en proceso desde la app web móvil
  Para suspender la preparación, actualizar el sistema y detener el despacho en cocina

  Escenario: Cancelación de un pedido en cola por solicitud del cliente
    Dado que existe un pedido para el comensal "Felipe Mora" en estado "En proceso"
    Y el mesero se encuentra en la sección "En proceso" de la app web en su teléfono
    Cuando selecciona la opción "Cancelar" sobre el pedido de "Felipe Mora"
    Y confirma la cancelación
    Entonces el sistema debe actualizar el estado del pedido a "Cancelado"
    Y el pedido debe dejar de mostrarse en la lista de órdenes activas de cocina
    Y el importe del pedido no debe sumarse a las ventas efectivas del turno
```

---

```gherkin
# language: es
Característica: Operación en contingencia desde el equipo servidor local
  Como cajero
  Quiero usar la aplicación web directamente en el PC que actúa como servidor
  Para continuar registrando pedidos y emitiendo comandas ante la falla de un dispositivo móvil

  Escenario: Registro de pedidos desde la estación principal por falla del teléfono
    Dado que el teléfono móvil del cajero se encuentra inoperativo
    Y el cajero abre la aplicación web en el navegador del PC servidor local
    Y autentica su usuario en la interfaz
    Cuando registra un pedido para el comensal "Laura Gómez"
    Entonces el sistema local debe guardar el pedido en la base de datos
    Y el servidor debe enviar la orden de impresión directamente a la impresora térmica
    Y el estado del pedido debe registrarse como "Pendiente en Cocina"
```

---

```gherkin
# language: es
Característica: Autenticación rápida mediante PIN numérico
  Como cajero
  Quiero iniciar sesión ingresando un código de 4 dígitos
  Para acceder ágilmente al sistema de toma de comandas

  Escenario: Autenticación exitosa con PIN de 4 dígitos
    Dado que el cajero tiene un PIN de acceso de 4 dígitos "5821" registrado en el sistema
    Y se encuentra en la pantalla de inicio de sesión de la app
    Cuando ingresa el código "5821" en el teclado numérico
    Entonces el sistema debe validar las credenciales
    Y la app debe redirigir a la pantalla principal de registro de pedidos
    Y el cajero debe quedar establecido como el usuario activo de la sesión
```

---

```gherkin
# language: es
Característica: Gestión y sincronización del menú del día
  Como miembro del personal de atención
  Quiero configurar y sincronizar el menú del día entre los dispositivos móviles
  Para mantener actualizada la oferta de platos desde la apertura del local

  Escenario: Publicación y edición colaborativa del menú del día en la apertura
    Dado que el local inicia su jornada de atención
    Y el cajero accede a la sección de configuración de menú desde su teléfono
    Cuando el cajero ingresa los platos que componen el "Menú del Día" y guarda los cambios
    Entonces el sistema debe actualizar el catálogo de platos disponibles en tiempo real
    Y el mesero debe visualizar el "Menú del Día" actualizado en su propio teléfono móvil
    Y el mesero debe poder editar o ajustar las opciones del menú desde su dispositivo
```

---

```gherkin
# language: es
Característica: Desactivación en tiempo real de platos agotados
  Como cajero
  Quiero marcar un plato como agotado durante el servicio
  Para evitar que el personal siga ofreciendo y registrando productos sin disponibilidad

  Escenario: Ocultamiento automático de un plato agotado en los dispositivos de los meseros
    Dado que el plato "Sancocho de Gallina" está activo y visible en el menú del día
    Y el mesero tiene abierta la pantalla de toma de pedidos en su teléfono móvil
    Cuando el cajero marca el plato "Sancocho de Gallina" como "Agotado" en el sistema
    Entonces el sistema debe actualizar la disponibilidad del catálogo en tiempo real
    Y el plato "Sancocho de Gallina" debe dejar de aparecer como opción seleccionable en el teléfono del mesero
```

---

```gherkin
# language: es
Característica: Edición de comandas activas
  Como mesero
  Quiero modificar un pedido en curso ante cambios del cliente
  Para actualizar la orden en cocina y ajustar el valor total de la cuenta

  Escenario: Modificación de plato y tipo de entrega en una comanda en proceso
    Dado que existe un pedido en estado "En proceso" con el número de comanda "005"
    Y el cliente solicita cambiar su plato actual por uno de mayor costo o modificar la modalidad a "Para llevar"
    Cuando el mesero edita el pedido desde la sección "En proceso" en la app web
    Entonces el sistema debe recalcular el precio total incluyendo los nuevos cargos (cambio de plato o empaque)
    Y el sistema debe generar una nueva impresión en cocina con el mismo número de comanda "005"
    Y la nueva impresión debe indicar claramente que es una actualización o cambio
    Y el pedido debe reflejar los datos actualizados tanto en cocina como en el reporte de caja

  Escenario: Edición de una comanda registrada por otro vendedor
    Dado que existe un pedido registrado por el vendedor "David" en estado "En proceso"
    Y la vendedora "Ana" tiene su sesión activa en otro dispositivo
    Cuando "Ana" edita o cancela el pedido de "David"
    Entonces el sistema debe permitir la operación sin restricción de propietario
    Y la venta debe conservar la atribución original al vendedor "David"
    Y el historial del pedido debe registrar que la modificación la realizó "Ana"
```

---

```gherkin
# language: es
Característica: Sincronización de ventas en Google Sheets y reporte diario automático
  Como dueño del restaurante
  Quiero recibir reportes automáticos por correo y mantener sincronizada la información de ventas en Google Sheets (incluso ante fallas de internet)
  Para monitorear los ingresos diarios y garantizar que ningún dato de ventas se pierda

  Escenario: Configuración de la hora del reporte diario
    Dado que el administrador accede a la sección de configuración del sistema
    Cuando establece la hora de reporte diario en "21:30" y guarda los cambios
    Entonces el sistema debe programar el envío automático del reporte a las "21:30" de cada jornada
    Y el cambio debe aplicar desde la jornada en curso sin reiniciar el servidor

  Escenario: Envío automático programado del reporte diario por correo electrónico
    Dado que el administrador configuró la hora de reporte diario en "22:00"
    Y el correo del dueño está registrado como "dueno@restaurante.com"
    Cuando el reloj del servidor alcanza las "22:00"
    Entonces el sistema debe consolidar el total de ventas, métodos de pago y comandas del día
    Y debe enviar automáticamente un correo a "dueno@restaurante.com" con el reporte adjunto o detallado

  Escenario: Sincronización en tiempo real de ventas hacia Google Sheets
    Dado que el sistema cuenta con conexión a internet estable
    Y la hoja de cálculo privada de Google Sheets está vinculada
    Cuando se confirma y registra el pago de un pedido
    Entonces el sistema debe insertar inmediatamente una nueva fila en la hoja de Google Sheets con el detalle de la venta

  Escenario: Almacenamiento en búfer local por pérdida de internet y sincronización por lotes
    Dado que se pierde la conexión a internet en el servidor local
    Cuando el personal continúa registrando y procesando pedidos durante la jornada
    Entonces el sistema debe guardar cada venta en una cola de almacenamiento local (búfer)
    Y cuando se restablece la conexión a internet
    Entonces el sistema debe enviar automáticamente en lote todas las ventas acumuladas hacia Google Sheets
    Y la cola de pendientes locales debe quedar sincronizada y limpia
```

---
---

# Escenarios agregados tras análisis de completitud

Los siguientes escenarios cubren vacíos detectados en la revisión lógica de las especificaciones originales: arquitectura de impresión configurable (USB / Bluetooth al PC / Bluetooth vía teléfono puente), contingencias de impresión, pago en efectivo, cierre de caja, ciclo de vida completo del pedido, casos negativos de autenticación, resiliencia de red LAN y administración de usuarios.

---

```gherkin
# language: es
Característica: Configuración del modo de impresión de comandas
  Como administrador del restaurante
  Quiero seleccionar cómo está conectada la impresora térmica (USB al PC, Bluetooth al PC, o Bluetooth a un teléfono)
  Para adaptar el sistema al hardware disponible sin cambiar el flujo de trabajo del personal

  Antecedentes:
    Dado que toda comanda generada por cualquier dispositivo se registra primero en el PC servidor
    Y el servidor mantiene una única cola de impresión ordenada por hora de llegada

  Escenario: Modo 1 - Impresora conectada por USB al PC servidor
    Dado que el modo de impresión configurado es "USB local"
    Cuando un pedido entra a la cola de impresión
    Entonces el servidor debe enviar los comandos ESC/POS directamente a la impresora USB
    Y el pedido debe marcarse como "Impreso" en la cola con la hora de impresión

  Escenario: Modo 2 - Impresora conectada por Bluetooth al PC servidor
    Dado que el modo de impresión configurado es "Bluetooth local"
    Y la impresora está emparejada con el PC exponiendo un puerto serie (COM)
    Cuando un pedido entra a la cola de impresión
    Entonces el servidor debe enviar los comandos ESC/POS a través del puerto serie Bluetooth
    Y el comportamiento para el personal debe ser idéntico al del modo "USB local"

  Escenario: Modo 3 - Impresora conectada por Bluetooth a un teléfono puente
    Dado que el modo de impresión configurado es "Teléfono puente"
    Y un teléfono designado como "impresor" tiene abierta la vista "Estación de impresión" de la app web
    Cuando un pedido entra a la cola de impresión del servidor
    Entonces el teléfono puente debe recibir el contenido compacto del ticket desde el servidor
    Y el teléfono puente debe transmitir el ticket a la impresora Bluetooth
    Y el teléfono puente debe confirmar al servidor la impresión exitosa
    Y solo entonces el servidor debe marcar el pedido como "Impreso"

  Escenario: Selección de la vía Bluetooth en el teléfono puente según el tipo de impresora
    Dado que el teléfono puente está en la vista "Estación de impresión"
    Cuando el administrador configura la conexión con la impresora
    Entonces el sistema debe ofrecer la vía "Web Bluetooth" si la impresora soporta BLE
    Y debe ofrecer la vía "App puente de impresión (RawBT)" si la impresora solo soporta Bluetooth clásico (SPP)
    Y en ambas vías el contenido del ticket debe generarse en el servidor para mantener un formato único
```

---

```gherkin
# language: es
Característica: Contingencias de la cola de impresión
  Como cajero
  Quiero que ninguna comanda se pierda cuando la impresora falla o el teléfono puente se desconecta
  Para que cocina siempre reciba los pedidos aunque haya problemas de hardware

  Escenario: Retención de comandas cuando el teléfono puente pierde conexión
    Dado que el modo de impresión es "Teléfono puente"
    Y el teléfono puente pierde la conexión WiFi con el servidor
    Cuando se registran nuevos pedidos
    Entonces las comandas deben permanecer en la cola del servidor en estado "Pendiente de impresión"
    Y la app debe mostrar una alerta visible de "Impresora sin conexión" en todos los dispositivos
    Y al reconectarse el teléfono puente, las comandas retenidas deben imprimirse en orden de llegada

  Escenario: Falla física de la impresora durante el servicio
    Dado que la impresora no responde (sin papel, apagada o desconectada)
    Cuando el servidor intenta imprimir una comanda y el intento falla
    Entonces el sistema debe reintentar la impresión automáticamente hasta 3 veces
    Y si los reintentos fallan, la comanda debe quedar en estado "Error de impresión"
    Y la app debe mostrar la comanda fallida con un botón "Reimprimir"
    Y el pedido debe seguir visible en pantalla para que cocina pueda trabajar sin ticket en el peor caso

  Escenario: Reimpresión manual de una comanda
    Dado que existe un pedido ya impreso con número de comanda "007"
    Cuando el cajero selecciona la opción "Reimprimir" sobre ese pedido
    Entonces el sistema debe generar de nuevo el ticket con el mismo número de comanda "007"
    Y el ticket debe incluir la marca "REIMPRESIÓN" en el encabezado
```

---

```gherkin
# language: es
Característica: Aviso impreso de cancelación en cocina
  Como despachador de cocina
  Quiero recibir un ticket de anulación cuando se cancela un pedido ya enviado
  Para detener la preparación aunque yo trabaje solo con los tickets de papel

  Escenario: Impresión del ticket de anulación de un pedido en preparación
    Dado que existe un pedido con número de comanda "009" ya impreso en cocina
    Cuando el mesero cancela el pedido y confirma la cancelación
    Entonces el sistema debe imprimir un ticket con el encabezado "ANULADO - COMANDA 009" en doble alto y doble ancho
    Y el ticket debe incluir el nombre del comensal y los platos anulados
```

---

```gherkin
# language: es
Característica: Pago en efectivo con cálculo de vueltas
  Como cajero
  Quiero registrar pagos en efectivo indicando el monto recibido
  Para calcular las vueltas sin errores y computar el efectivo en el cierre de caja

  Escenario: Cobro en efectivo con cálculo automático de vueltas
    Dado que existe un pedido para el comensal "Rosa Pérez" por valor de "$28.000"
    Cuando el cajero selecciona el método "Efectivo" e ingresa que recibió "$50.000"
    Entonces el sistema debe mostrar que las vueltas son "$22.000"
    Y el monto de "$28.000" debe computarse bajo el concepto "Efectivo" para el cierre de caja

  Escenario: Rechazo de monto recibido insuficiente
    Dado que existe un pedido por valor de "$28.000"
    Cuando el cajero ingresa que recibió "$20.000" en efectivo
    Entonces el sistema debe impedir confirmar el pago
    Y debe mostrar el mensaje "El monto recibido es menor al total"
```

---

```gherkin
# language: es
Característica: Cierre de caja del turno
  Como administrador del restaurante
  Quiero ejecutar un cierre de caja al final de la jornada
  Para cuadrar el efectivo físico contra lo registrado y dejar el día contablemente cerrado

  Escenario: Generación del cierre de caja diario
    Dado que durante la jornada se registraron ventas en efectivo, tarjetas y billeteras virtuales
    Cuando el administrador ejecuta la opción "Cierre de caja"
    Entonces el sistema debe mostrar el total vendido discriminado por método de pago
    Y debe mostrar el total de pedidos cancelados con su valor
    Y debe mostrar el total de recargos por empaque cobrados
    Y debe permitir ingresar el efectivo físico contado para registrar el descuadre (sobrante o faltante)
    Y al confirmar, los pedidos del día deben quedar bloqueados contra edición
```

---

```gherkin
# language: es
Característica: Historial de comandas del día
  Como mesero
  Quiero ver todas las comandas de la jornada en una sola lista
  Para consultar, corregir, reimprimir o cobrar cualquier pedido sin marcar estados de cocina

  # Nota de diseño (2026-08-18): al trabajar cocina con comandas físicas de papel,
  # no existe forma confiable de saber cuándo termina una preparación; se eliminó
  # el estado "Entregado" y la sección "En proceso" se reemplazó por "Historial".

  Escenario: Consulta del historial durante el servicio
    Dado que existen comandas registradas en la jornada
    Cuando el mesero abre la sección "Historial"
    Entonces debe ver todas las comandas del día de la más reciente a la más antigua
    Y cada comanda debe indicar si está "Pagado" o "Por cobrar"
    Y las comandas anuladas deben listarse aparte al final
    Y los pedidos sin pago deben seguir apareciendo en "Cuentas por cobrar" de la caja
```

---

```gherkin
# language: es
Característica: Casos negativos de autenticación y cambio de usuario
  Como administrador del restaurante
  Quiero que el acceso por PIN maneje errores y cambios de turno
  Para que un teléfono compartido no mezcle las ventas de dos vendedores

  Escenario: Intento de acceso con PIN incorrecto
    Dado que el cajero se encuentra en la pantalla de inicio de sesión
    Cuando ingresa un PIN que no corresponde a ningún usuario registrado
    Entonces el sistema debe mostrar el mensaje "PIN incorrecto"
    Y debe permanecer en la pantalla de inicio de sesión
    Y tras 5 intentos fallidos consecutivos debe bloquear el teclado durante 30 segundos

  Escenario: Cambio de usuario en un dispositivo compartido
    Dado que el vendedor "David" tiene la sesión activa en un teléfono
    Cuando selecciona la opción "Cambiar de usuario" y "Ana" ingresa su PIN
    Entonces los pedidos nuevos deben atribuirse a "Ana"
    Y los pedidos registrados previamente deben conservar la atribución a "David"

  Escenario: Administración de usuarios y PINs
    Dado que el administrador accede a la sección de usuarios
    Cuando crea el usuario "Ana" con rol "Mesero" y un PIN de 4 dígitos
    Entonces el sistema debe rechazar el PIN si ya está asignado a otro usuario
    Y el rol "Mesero" no debe tener acceso al cierre de caja ni a los reportes de ventas
    Y el rol "Administrador" debe poder desactivar usuarios sin borrar sus ventas históricas
```

---

```gherkin
# language: es
Característica: Resiliencia de la red LAN y del servidor local
  Como mesero
  Quiero que el sistema tolere cortes breves de WiFi y reinicios del PC
  Para no perder pedidos ni generar comandas duplicadas

  Escenario: Pérdida de WiFi del teléfono justo al confirmar un pedido
    Dado que el mesero confirma un pedido y la respuesta del servidor no llega por un corte de WiFi
    Cuando la app reintenta el envío automáticamente al recuperar la conexión
    Entonces el servidor debe detectar por un identificador único que el pedido ya fue recibido
    Y no debe crearse un pedido duplicado ni imprimirse una segunda comanda
    Y la app debe mostrar el estado real del pedido al mesero

  Escenario: Recuperación tras reinicio del PC servidor
    Dado que el PC servidor se apaga inesperadamente durante el servicio
    Cuando el PC se reinicia y el servidor arranca de nuevo
    Entonces todos los pedidos y pagos previos deben estar intactos en la base de datos local
    Y la numeración de comandas debe continuar desde el último número usado
    Y las comandas que quedaron en "Pendiente de impresión" deben ofrecerse para imprimir o descartar

  Escenario: Numeración diaria de comandas
    Dado que inicia una nueva jornada de atención
    Cuando se registra el primer pedido del día
    Entonces la numeración de comandas debe reiniciar en "001"
    Y el número mostrado en cocina debe ser corto para facilitar el llamado y la referencia verbal

  Escenario: Acceso de los teléfonos a la app en la red local
    Dado que el PC servidor tiene una dirección fija en la red LAN del restaurante
    Cuando un mesero escanea el código QR de acceso publicado en el mostrador
    Entonces el navegador del teléfono debe abrir la app web servida por el PC
    Y no debe requerirse conexión a internet para usar la app dentro del local
```

---

```gherkin
# language: es
Característica: Reactivación de platos y ajuste de precios
  Como cajero
  Quiero reactivar platos agotados y corregir precios durante el servicio
  Para reflejar la disponibilidad y los valores reales del día

  Escenario: Reactivación de un plato marcado como agotado
    Dado que el plato "Sancocho de Gallina" está marcado como "Agotado"
    Cuando el cajero lo marca nuevamente como "Disponible"
    Entonces el plato debe reaparecer como opción seleccionable en todos los teléfonos en tiempo real

  Escenario: Cambio de precio sin afectar pedidos ya registrados
    Dado que existen pedidos registrados del plato "Bandeja Paisa" a "$18.000"
    Cuando el cajero cambia el precio del plato a "$20.000"
    Entonces los pedidos ya registrados deben conservar el precio de "$18.000"
    Y los pedidos nuevos deben tomar el precio de "$20.000"
```

---

```gherkin
# language: es
Característica: Reporte de ventas por vendedor y reintento de correo
  Como dueño del restaurante
  Quiero ver las ventas discriminadas por vendedor y que el reporte por correo se reintente si falla
  Para evaluar el desempeño del personal y no quedarme sin el reporte del día

  Escenario: Consulta de ventas del día por vendedor
    Dado que "David" y "Ana" registraron ventas durante la jornada
    Cuando el administrador consulta el reporte del día
    Entonces el sistema debe mostrar el total vendido y el número de pedidos de cada vendedor
    Y los pedidos cancelados no deben sumar al total de ningún vendedor

  Escenario: Reintento del envío del reporte diario por falla de internet
    Dado que a las "22:00" no hay conexión a internet en el servidor
    Cuando el sistema no logra enviar el correo del reporte diario
    Entonces el reporte debe quedar en cola de envío pendiente
    Y debe reintentarse automáticamente al restablecerse la conexión
    Y el reporte enviado con retraso debe indicar la fecha de la jornada a la que corresponde
```

---

```gherkin
# language: es
Característica: Velocidad de la comanda con el menú completo
  Como mesero
  Quiero que la comanda salga de inmediato aunque el menú tenga 300 platos
  Para no dejar al cliente esperando en la caja

  Escenario: Comanda con platos que nunca se han impreso
    Dado que el menú tiene 300 platos y ninguno se ha impreso hoy
    Cuando el mesero confirma una comanda con 3 almuerzos de platos distintos
    Entonces la comanda debe armarse en menos de un segundo
    Y el servidor debe seguir atendiendo a los demás teléfonos mientras tanto

  Escenario: Buscar un plato en un menú largo
    Dado que la pantalla de proteínas tiene más de 12 platos
    Cuando el mesero escribe "champinones" en el buscador
    Entonces deben quedar visibles los platos cuyo nombre contenga "champiñones"
    Y la búsqueda debe ignorar tildes y mayúsculas
```

---

```gherkin
# language: es
Característica: Bebida incluida en los platos vendidos solos
  Como mesero
  Quiero poder agregar el jugo incluido a una proteína vendida sin entrada
  Para no cobrarle aparte al cliente algo que va incluido

  Escenario: Proteína del día vendida sola con su jugo
    Dado que el cliente pide una proteína del día sin entrada
    Cuando el mesero agrega una bebida incluida
    Entonces el ticket debe quedar válido
    Y la bebida no debe sumar valor al total

  Escenario: Más bebidas que platos
    Dado que el cliente pide una proteína del día sola
    Cuando el mesero agrega dos bebidas incluidas
    Entonces el sistema debe avisar que hay 2 bebidas para 1 plato
    Y no debe permitir confirmar el pedido
```

---

```gherkin
# language: es
Característica: Tipo de plato y reporte de compras
  Como dueño del restaurante
  Quiero saber cuántos almuerzos se vendieron de cada plato y de cada tipo de carne
  Para decidir qué comprar más y qué se está quedando quieto

  Escenario: Asignar el tipo a una proteína
    Dado que existe el tipo "Pollo" configurado en el menú
    Cuando el cajero asigna el tipo "Pollo" al plato "Pollo a la jardinera"
    Entonces el plato debe quedar clasificado como "Pollo" en los reportes

  Escenario: Configurar los tipos disponibles
    Dado que el mesero está en la pestaña Menú
    Cuando agrega el tipo "Pescado"
    Entonces el tipo debe quedar disponible en todos los teléfonos

  Escenario: Reporte del día por plato y por tipo
    Dado que se vendieron 2 "Pollo a la jardinera" y 1 "Chuleta valluna"
    Cuando se consulta el resumen del día
    Entonces debe mostrar 2 almuerzos del tipo "Pollo" y 1 del tipo "Cerdo"
    Y el Excel debe traer una hoja con los platos vendidos y otra con los totales por tipo

  Escenario: Reporte de varios días para las compras
    Dado que el cajero elige un rango de fechas
    Cuando descarga el Excel de platos vendidos
    Entonces debe recibir las cantidades vendidas de cada plato y de cada tipo en ese rango
```

---

```gherkin
# language: es
Característica: Precio por defecto del almuerzo
  Como cajero
  Quiero configurar un solo precio para casi todas las proteínas del día
  Para no escribir el mismo valor 150 veces y poder cambiarlo cuando suba el año siguiente

  Escenario: Crear un plato con el precio por defecto
    Dado que el precio por defecto del día es "$17.500" con entrada y "$17.000" solo
    Cuando el cajero crea la proteína "Pollo a la jardinera" con "precio por defecto" marcado
    Entonces el plato debe venderse a "$17.500" en almuerzo completo y a "$17.000" solo

  Escenario: Cambio del precio del año
    Dado que hay 150 proteínas marcadas con precio por defecto
    Cuando el cajero cambia el precio por defecto a "$18.000"
    Entonces las 150 proteínas deben pasar a "$18.000"
    Y las ventas ya registradas deben conservar el precio que tenían

  Escenario: Plato con precio propio
    Dado que la "Bandeja paisa" tiene un precio distinto al del resto
    Cuando el cajero deja sin marcar "precio por defecto" y escribe "$18.500"
    Entonces la bandeja debe conservar su precio aunque cambie el precio por defecto
```

---

```gherkin
# language: es
Característica: Sincronización con Google Sheets a prueba de hotspot
  Como administrador
  Quiero que los envíos a internet nunca dejen la app esperando ni pierdan ventas
  Para confiar en la hoja aunque el internet del local sea el hotspot de un teléfono

  Escenario: Internet mudo (datos agotados del teléfono)
    Dado que el hotspot acepta conexiones pero no responde
    Cuando el sistema intenta enviar ventas a Google Sheets
    Entonces el intento debe cortarse a los 15 segundos con un mensaje claro
    Y las ventas deben quedar en cola y reintentarse solas
    Y la app local debe seguir atendiendo a los teléfonos con normalidad

  Escenario: Apps Script mal implementado (falso éxito)
    Dado que la URL del webhook responde la página de login de Google con estado 200
    Cuando el sistema envía ventas
    Entonces NO deben marcarse como enviadas
    Y el error debe explicar que la implementación necesita acceso "Cualquier persona"

  Escenario: Cierre de caja sin internet
    Dado que el correo del reporte no puede salir
    Cuando la cajera ejecuta el cierre de caja
    Entonces el cierre debe completarse en segundos con el reporte "en cola"
    Y el correo debe salir solo cuando vuelva el internet

  Escenario: El QR de conexión se actualiza solo
    Dado que el hotspot se reinició y le entregó otra dirección al PC
    Cuando la pantalla de login del PC lleva abierta más de 20 segundos
    Entonces el QR y la dirección mostrados deben ser los nuevos
    Y el botón 📶 debe indicar si el PC tiene salida a internet
```

---

```gherkin
# language: es
Característica: Valor del turno por día de la semana
  Como administradora
  Quiero que el turno de cada empleado valga distinto según el día
  Porque de lunes a jueves vale una cosa, el sábado otra y el domingo otra

  Escenario: Configurar los turnos de un empleado
    Dado que el admin abre 💰 en la tarjeta del empleado
    Cuando escribe un valor para cada día de la semana y guarda
    Entonces la nómina debe usar el valor del día que corresponda a la fecha del turno

  Escenario: El cajero no puede alterar el valor
    Dado que el empleado tiene sábado en "$45.000"
    Cuando el cajero registra un pago de nómina con fecha de un sábado enviando otro valor
    Entonces el sistema debe registrar "$45.000" ignorando el valor enviado

  Escenario: Día sin valor propio
    Dado que el empleado tiene valores solo para sábado y domingo
    Cuando se registra un turno de un martes
    Entonces debe usarse el valor base del empleado

  Escenario: El formulario muestra el valor del día elegido
    Dado que el cajero está registrando nómina
    Cuando cambia la fecha del turno a un domingo
    Entonces el campo del valor debe actualizarse al valor del domingo e indicar el día
```

---

```gherkin
# language: es
Característica: Eliminación de usuarios
  Como administrador
  Quiero poder eliminar usuarios además de desactivarlos
  Para que los que ya no trabajan no aparezcan más y sus PIN queden libres

  Escenario: Eliminar un usuario sin historia
    Dado que el usuario nunca registró ventas, nómina ni gastos
    Cuando el admin lo elimina
    Entonces debe borrarse por completo del sistema

  Escenario: Eliminar un usuario con ventas registradas
    Dado que el usuario tiene ventas o nómina en la historia
    Cuando el admin lo elimina
    Entonces debe desaparecer de todas las listas y su PIN quedar libre
    Y los reportes y Excel de días pasados deben conservar su nombre

  Escenario: Protección del último administrador
    Dado que solo existe un administrador activo
    Cuando intenta eliminarse o desactivarse a sí mismo
    Entonces el sistema debe impedirlo y pedir crear otro admin primero
```

---

```gherkin
# language: es
Característica: Correo del reporte con Excel adjunto
  Como dueño del restaurante
  Quiero recibir el resumen del día en el correo y en un Excel
  Para revisarlo en el celular y guardarlo en mi contabilidad

  Escenario: Correo del cierre de caja
    Dado que la cajera ejecuta el cierre de caja
    Cuando sale el correo del día
    Entonces debe traer el resumen legible (ventas, métodos de pago, vendedores, tipos, gastos, nómina y caja)
    Y adjunto un Excel con dos hojas: el mismo resumen y las ventas una a una de ese día

  Escenario: Día con nómina pagada
    Dado que ese día se confirmó al menos un pago de nómina
    Cuando sale el correo del día
    Entonces también debe adjuntar el Excel de nómina con una hoja por mes
    Y cada hoja de mes debe listar los pagos agrupados por empleado con subtotal

  Escenario: El administrador aparece con su cargo
    Dado que el gerente tiene rol de administrador y registró ventas
    Cuando se consulta cualquier reporte, Excel o la hoja de Google
    Entonces su nombre debe aparecer como "Pepito Pérez (Administrador)"
```

---

```gherkin
# language: es
Característica: Reportes mensuales
  Como dueño del restaurante
  Quiero recibir al final del mes la nómina del mes y el resumen del mes
  Para cerrar la contabilidad mensual sin armar nada a mano

  Escenario: Cierre del último día del mes
    Dado que hoy es el último día del mes
    Cuando la cajera ejecuta el cierre de caja
    Entonces deben salir dos correos adicionales: "Nómina del mes" y "Resumen mensual"
    Y el resumen mensual debe adjuntar un Excel con el resumen día por día y todas las ventas del mes

  Escenario: El último día no abrieron
    Dado que el 31 no hubo cierre de caja
    Cuando se hace el primer cierre del mes siguiente
    Entonces deben salir los correos del mes anterior una sola vez

  Escenario: Reenvío manual
    Dado que el admin elige un mes en la pestaña Admin
    Cuando toca "Enviar reportes del mes"
    Entonces deben encolarse de nuevo los dos correos de ese mes
```

---

```gherkin
# language: es
Característica: Base de caja y corrección de totales por método
  Como cajera
  Quiero registrar con cuánto dinero arrancó el día y corregir el total de un método de pago
  Para que el efectivo esperado y los extractos cuadren con la realidad

  Escenario: Base de caja por defecto
    Dado que ayer se contaron $120.000 en el cierre
    Cuando hoy no se registra base de caja
    Entonces el efectivo esperado debe partir de $120.000

  Escenario: Corregir la base de caja
    Dado que en la caja hay $100.000 y no $120.000
    Cuando la cajera registra $100.000 como base del día
    Entonces el efectivo esperado debe partir de $100.000 y el reporte debe decir quién lo registró

  Escenario: Corregir el total de un método
    Dado que Nequi registrado pago a pago suma $340.000 y el extracto dice $355.000
    Cuando la cajera corrige el total de Nequi a $355.000
    Entonces el reporte debe mostrar $355.000 con la nota de que se corrigió a mano
    Y los almuerzos de Nequi deben mostrarse como APROXIMADO (total ÷ precio del almuerzo)

  Escenario: Corregir pago por pago conserva el conteo exacto
    Dado que la cajera cambia el método de un pago de Nequi a Tarjeta sin tocar los totales
    Cuando se consulta el reporte
    Entonces los almuerzos por método deben seguir siendo exactos, sin la palabra "aproximado"

  Escenario: Quitar la corrección
    Dado que Nequi tiene el total corregido
    Cuando la cajera deja el campo vacío
    Entonces el total vuelve a lo registrado y los almuerzos vuelven a ser exactos
```

---

```gherkin
# language: es
Característica: Hoja de Google Sheets por mes
  Como dueño del restaurante
  Quiero que la hoja en tiempo real tenga una pestaña por mes con el formato del Excel
  Para ver el mes completo sin filtrar

  Escenario: Venta pagada
    Dado que se paga una comanda en septiembre de 2026
    Cuando llega a Google Sheets
    Entonces debe anotarse en la pestaña "09-2026"
    Y con las columnas Día, Hora, Comanda, Vendedor, Entrega (Local/Domicilio), Entrada, Proteína, Bebida, Extras, Método de pago, Recargo y Total
    Y sin el nombre del cliente
```

# POS Restaurante (plazoleta de comidas)

Sistema de comandas para el restaurante: los meseros toman pedidos desde sus teléfonos
conectados al WiFi del local, todo se guarda en el PC del restaurante y las comandas
salen por la impresora térmica con el nombre del comensal en grande para llamarlo por voz.

**No necesita internet para operar.** Internet solo se usa (si se configura) para el
reporte diario por correo y la sincronización con Google Sheets; si se cae, todo queda
en un búfer local y se envía cuando vuelva la conexión.

---

## 1. Instalación (una sola vez, en el PC del restaurante)

1. Instalar [Node.js](https://nodejs.org) (versión LTS).
2. Abrir una terminal en esta carpeta y ejecutar: `npm install`
3. Permitir el puerto en el Firewall de Windows (terminal como **administrador**):

```bash
netsh advfirewall firewall add rule name="POS Restaurante" dir=in action=allow protocol=TCP localport=3000
```

4. Arrancar con doble clic en **`Iniciar POS.bat`** (dejar la ventana abierta).
   La ventana muestra la dirección para los teléfonos, por ejemplo `http://192.168.1.50:3000`.

> Recomendado: en el router del restaurante, fijar la IP del PC (reserva DHCP)
> para que la dirección no cambie. Luego, desde Admin se puede imprimir un
> **QR de acceso** para pegar en el mostrador: los meseros lo escanean y listo.

## 2. Primer uso

- Usuario inicial: PIN **1234** (Administrador). Entrar, ir a **Admin** y:
  - Crear los usuarios reales (meseros, cajero) con sus PIN de 4 dígitos.
  - Cambiar el PIN del administrador.
  - Poner el nombre del restaurante y el recargo por empaque.
- En **Menú** se cargan los platos del día. "Marcar agotado" los oculta en todos
  los teléfonos al instante; "Reactivar" los devuelve.

## 3. La impresora térmica (3 modos, se elige en Admin → Impresora)

| Modo | Cuándo usarlo | Configuración |
|---|---|---|
| **Simulado** | Pruebas sin impresora | Los tickets se escriben en `data/impresiones.log` |
| **USB en el PC** | Impresora USB conectada al PC servidor | Ver abajo (compartir impresora) |
| **Bluetooth del PC (COM)** | Impresora Bluetooth emparejada con el PC | Ver abajo (puerto COM) |
| **Teléfono puente** | Impresora Bluetooth vinculada a un teléfono | Ver abajo (RawBT / BLE) |

### Modo USB
1. Instalar la impresora en Windows (driver genérico "Generic / Text Only" sirve).
2. Compartirla: Configuración → Impresoras → (la impresora) → Propiedades → Compartir →
   nombre del recurso: **POS58** (o el que sea, y ponerlo igual en Admin → Impresora).
3. El sistema envía los bytes ESC/POS crudos con `copy /b`, sin pasar por el driver.

### Modo Bluetooth del PC
1. Emparejar la impresora con el PC (Configuración → Bluetooth).
2. En "Más opciones de Bluetooth" → pestaña "Puertos COM", ver el puerto **saliente**
   (ej: COM4) y ponerlo en Admin → Impresora.

### Modo teléfono puente (la impresora está vinculada a un teléfono)
Todas las comandas siguen pasando por el PC; el teléfono solo es la "mano" que imprime:

1. En Admin → Impresora elegir modo **Teléfono puente**.
2. En el teléfono que tiene la impresora: abrir la app, pestaña **Impresora**,
   elegir la vía y tocar **Activar estación en este teléfono**:
   - **RawBT** (recomendado, funciona con casi cualquier impresora térmica Bluetooth):
     instalar la app gratuita [RawBT](https://play.google.com/store/apps/details?id=ru.a402d.rawbtprinter)
     y vincular allí la impresora. Los tickets llegan solos.
   - **Web Bluetooth**: solo si la impresora es BLE. Chrome en Android, botón "Conectar impresora BLE".
3. Ese teléfono debe quedarse con la app abierta y pantalla encendida.
   Si se desconecta, las comandas **no se pierden**: quedan en cola en el PC,
   todos los teléfonos ven la alerta roja, y al reconectar salen en orden.

Si un ticket falla (sin papel, etc.), aparece en la pestaña Impresora con botón **Reintentar**.

## 4. Reporte diario por correo (opcional)

El reporte se envía al ejecutar el **Cierre de caja** (incluye el arqueo y el descuadre).
Como respaldo, si a la hora configurada aún no se ha hecho el cierre, se envía solo.

En Admin → Reporte (solo el administrador puede ver y cambiar esto):
- **Hora del reporte**: hora del envío automático de respaldo.
- **Correo del dueño**: quien lo recibe.
- **Cuenta Gmail que envía** + **contraseña de aplicación**: se genera en
  [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
  (requiere verificación en 2 pasos activa; son 16 letras).

Sin internet a esa hora, el reporte queda en cola y sale cuando vuelva la conexión.

## 5. Google Sheets (opcional)

Cada venta pagada se agrega como fila a una hoja de cálculo del dueño, sin OAuth:

1. Crear una hoja en [sheets.google.com](https://sheets.google.com).
2. Extensiones → Apps Script, pegar esto y guardar:

```javascript
function doPost(e) {
  const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  if (hoja.getLastRow() === 0) {
    hoja.appendRow(['Fecha', 'Hora', 'Comanda', 'Comensal', 'Vendedor',
                    'Tipo entrega', 'Detalle', 'Método de pago', 'Recargo', 'Total']);
  }
  const filas = JSON.parse(e.postData.contents).filas;
  for (const f of filas) {
    hoja.appendRow([f.fecha, f.hora, f.comanda, f.comensal, f.vendedor,
                    f.tipo_entrega, f.detalle, f.metodo_pago, f.recargo, f.total]);
  }
  return ContentService.createTextOutput('ok');
}
```

3. Implementar → Nueva implementación → tipo **Aplicación web** →
   Ejecutar como: **yo** · Acceso: **Cualquier persona** → copiar la URL.
4. Pegar la URL en Admin → "URL del webhook de Google Sheets".

Sin internet, las ventas quedan en búfer local y se suben en lote al reconectar.

## 6. Operación diaria

1. Encender el PC y abrir `Iniciar POS.bat` (o dejarlo en el arranque de Windows).
2. Cargar/ajustar el menú del día.
3. Tomar pedidos; cocina recibe el ticket y grita el nombre del comensal.
4. El cajero cobra (efectivo calcula vueltas; electrónico queda discriminado).
5. Al final: Caja → **Cierre de caja** (contar el efectivo físico para ver el descuadre).
   Tras el cierre la jornada queda bloqueada.

## 7. Contingencias previstas

- **Se daña el teléfono de un mesero** → entrar a la app en el navegador del propio PC.
- **Se va el WiFi al confirmar un pedido** → la app reintenta sola; no se duplican comandas.
- **Se reinicia el PC** → nada se pierde (base de datos local); las comandas pendientes se
  retoman, y el POS arranca solo al prender el PC (acceso directo en la carpeta de Inicio;
  también hay uno en el Escritorio por si hay que arrancarlo a mano).
- **Se cae internet** → el sistema ni lo nota; correos y Sheets esperan en cola.

### Si se cae la red WiFi y se levanta una nueva (ej: cambia el teléfono que comparte datos)

Protocolo (2-3 minutos, los pedidos ya guardados NO se pierden):

1. El nuevo teléfono enciende su hotspot. **Truco que ahorra pasos**: configurar en los dos
   teléfonos "candidatos" el hotspot con el MISMO nombre y la MISMA clave — así el PC y los
   demás teléfonos se reconectan solos sin tocar nada.
2. Conectar el PC a esa red (si el nombre/clave son iguales, se conecta solo).
3. En el PC, la app sigue funcionando en `http://localhost:3000` (localhost nunca cambia).
   Tocar el botón **📶** de la barra superior: muestra el QR con la dirección NUEVA.
4. Cada mesero escanea ese QR con su teléfono y entra de nuevo con su PIN. Listo.

Lo único que se pierde al cambiar de red es la sesión de los teléfonos (el PIN se
re-ingresa en segundos). El servidor, las comandas y la caja no se enteran del cambio.

> Recomendación a futuro: comprar un router barato (no necesita internet) y dejarlo fijo
> en el local. Con eso la dirección nunca cambia, el QR impreso en el mostrador vale para
> siempre y este protocolo desaparece.

## 8. Respaldo

Toda la información vive en `data/pos.db`. Copiar ese archivo (con el servidor
apagado) a una USB o a la nube de vez en cuando es el respaldo completo.

# Guía: actualizar el POS en el PC del restaurante

Para pasar de una versión anterior a la nueva **no es necesario desinstalar**:
el instalador nuevo se ejecuta encima y **las ventas, usuarios y configuración
se conservan** (viven en `C:\POS-Restaurante\data`, que ninguna instalación toca).

## Actualización normal (recomendada, 2 minutos)

1. Copie el `Instalar-POS-Restaurante.exe` nuevo al PC del restaurante (USB).
2. **Cierre el POS**: la ventana negra del servidor arranca minimizada; ábrala desde la barra de tareas y ciérrela con la X
   (o reinicie el PC y NO abra el POS).
3. Doble clic al instalador nuevo → Siguiente → Instalar → Finalizar.
4. Abra el POS con el icono del Escritorio (o deje que arranque solo al prender el PC).
5. Listo: la primera vez que arranca aplica solo los cambios internos que
   necesite la base de datos (sale un aviso "[db] Migración aplicada..." en la
   ventana — es normal).

> Todo lo que ya estaba configurado se mantiene: menú, usuarios y PINs,
> impresora, Google Sheets, correo, tamaños de letra, etc.

## Desinstalación completa (solo si quiere quitar el POS del PC)

1. Cierre la ventana del servidor del POS.
2. Windows → Configuración → **Aplicaciones → Aplicaciones instaladas** →
   busque **POS Restaurante** → **Desinstalar**.
3. La desinstalación elimina el programa y los accesos directos, pero
   **deja la carpeta `C:\POS-Restaurante\data`** con las ventas por seguridad.
   - Si quiere conservar ese historial: copie `C:\POS-Restaurante\data\pos.db` a una USB.
   - Si quiere borrarlo todo: elimine la carpeta `C:\POS-Restaurante` manualmente.

## Respaldo (recomendado hacerlo de vez en cuando)

Toda la información del restaurante es UN archivo: `C:\POS-Restaurante\data\pos.db`.
Con el POS cerrado, cópielo a una USB o súbalo a su Drive. Ese archivo restaurado
en cualquier instalación del POS recupera todo (ventas, usuarios, configuración).

## Si algo sale mal al actualizar

- **El POS no abre tras actualizar**: reinicie el PC; si sigue sin abrir,
  ejecute el instalador otra vez.
- **"El POS ya está corriendo"**: había otra ventana del servidor abierta;
  es inofensivo — la app sigue en http://localhost:3000.
- **Los teléfonos no conectan**: revise que estén en el WiFi del local y
  escaneen el QR del botón 📶 (la dirección pudo cambiar).

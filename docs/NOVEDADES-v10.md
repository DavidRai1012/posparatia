# Novedades de la versión 10

## 1. Nómina: roles con valor del turno por día de la semana

Los "cargos" ahora se llaman **roles**, y cada rol tiene el valor del turno de
**cada día** (lunes, martes... domingo). Ya no existe el "valor por defecto" ni
las casillas sueltas de sábado y domingo, que confundían: se escribe el valor
de cada día y listo. Un día en 0 quiere decir "ese rol no se paga ese día" (no
se puede registrar un turno con él, y la app lo dice ahí mismo).

- **Quién los maneja**: el administrador **y el cajero**. Están en
  Caja → Turnos y pagos de nómina → tarjeta **"👔 Roles y valor del turno por
  día"** (tóquela para abrirla). También aparecen en Admin.
- **Crear, cambiar y borrar**: "＋ Agregar rol", escribir los 7 valores,
  "🗑" para quitar uno, y **"💾 Guardar roles"**. Los turnos ya registrados con
  un rol borrado no cambian.
- **Registrar turno**: empleado, día y **rol que hizo ese día**. El valor sale
  del rol y del día de la semana; el cajero no lo puede cambiar (el admin sí
  puede escribir otro a mano).
- **Rol preseleccionado**: el "rol habitual en nómina" que el admin le ponga al
  usuario (Admin → tarjeta del usuario) o, si no tiene, el de su acceso en la
  app (Cajero, Mesero, Cocinera). El día que haga otra cosa, se cambia al
  registrar el turno.
- **Pagar**: igual que antes. Se marcan los turnos sin pagar del empleado, se
  pone descuento o bono si aplica, y el empleado confirma en su teléfono.
  Corregir y borrar días pasados sigue igual (solo administrador).

Lo que ya tenían configurado se convirtió solo: el valor normal quedó de lunes
a viernes, y sábado y domingo conservaron el suyo. Conviene revisarlo.

## 2. Excel en tiempo real (Google Sheets): opcional y sin sustos

- **Viene desactivado.** Se prende en Admin → tarjeta "📊 Excel en tiempo real"
  marcando la casilla **"Activar"** y tocando "Guardar configuración". Mientras
  esté apagado no se envía nada, no se intenta nada y **no aparece ningún
  mensaje**. El correo diario con su Excel adjunto y los botones de Descargar
  siguen exactamente igual.
- **Activado**, arriba de la app (en la caja y en Admin) aparece una línea con
  el estado del envío:
  - verde: "📊 Excel en tiempo real al día · última venta subida 12:31";
  - amarilla: "📊 Excel en tiempo real: 3 venta(s) en espera · motivo · se
    reintenta solo a las 12:40. No se pierde ninguna venta."
- **La ventana negra ya no muestra nada de esto.** Lo que el sistema hace por
  dentro (envíos a Google, correos, reintentos) queda anotado en
  `C:\POS-Restaurante\data\registro.log`, por si alguna vez hay que revisarlo.
- Lo que pasó el 3 de septiembre ("Internet no respondió en 15 segundos"
  aunque el teléfono sí tenía datos): Google Apps Script tarda más que un
  servidor normal y por un hotspot lento pasaba de 15 s. Ahora se le dan hasta
  45 s, se sale a internet por IPv4 primero (los hotspots de celular con IPv6 a
  medias dejaban a Node esperando) y los reintentos se espacian (1, 2, 4...
  hasta 10 minutos) en vez de insistir cada 30 segundos.

## 3. Arranque: el navegador adelante, la ventana negra minimizada

Al abrir el POS, la ventana negra arranca **minimizada** (queda en la barra de
tareas) y el servidor abre solo el navegador con la app. Lo que la cajera ve es
el POS funcionando. La ventana negra sigue siendo el motor: **no se cierra**
durante el servicio; para apagar el POS, se abre desde la barra de tareas y se
cierra con la X.

---

## Qué hacer en el restaurante después de instalar

1. Caja → Turnos y pagos de nómina → **👔 Roles**: revisar el valor de cada día
   de cada rol (los que tenían quedaron: el normal de lunes a viernes) y
   agregar los que falten. Guardar.
2. Si quieren la hoja de Google en tiempo real: Admin → **marcar "Activar"** en
   la tarjeta 📊, Guardar configuración y tocar "🔎 Revisar Google Sheets".
3. Si no la quieren: no hay que hacer nada.

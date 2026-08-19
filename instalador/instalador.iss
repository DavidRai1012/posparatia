; Instalador del POS Restaurante (Inno Setup)
; Compilar con: crear-instalador.bat  (deja el resultado en instalador\salida\)
;
; Qué hace el instalador en el PC del restaurante:
;   1. Copia la app completa + Node.js portable a C:\POS-Restaurante
;      (fuera de Archivos de Programa para que la base de datos data\ se
;      pueda escribir sin permisos especiales)
;   2. Crea accesos directos: Escritorio, Menú Inicio y AUTOARRANQUE
;   3. Abre el puerto 3000 en el Firewall de Windows (corre como admin)
;   4. Ofrece iniciar el POS al terminar
; La base de datos data\ NUNCA se toca: sobrevive reinstalaciones y
; desinstalaciones (respáldela copiando data\pos.db).

[Setup]
AppId={{8F4B1E2A-POS-TIA-2026}}
AppName=POS Restaurante
AppVersion=1.0
AppPublisher=DavidRai1012
DefaultDirName={sd}\POS-Restaurante
DefaultGroupName=POS Restaurante
DisableProgramGroupPage=yes
OutputDir=salida
OutputBaseFilename=Instalar-POS-Restaurante
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Files]
Source: "node.exe"; DestDir: "{app}"
Source: "..\Iniciar POS.bat"; DestDir: "{app}"
Source: "..\package.json"; DestDir: "{app}"
Source: "..\README.md"; DestDir: "{app}"
Source: "..\server\*"; DestDir: "{app}\server"; Flags: recursesubdirs
Source: "..\public\*"; DestDir: "{app}\public"; Flags: recursesubdirs
Source: "..\herramientas\*"; DestDir: "{app}\herramientas"; Flags: recursesubdirs
Source: "..\docs\*"; DestDir: "{app}\docs"; Flags: recursesubdirs
Source: "..\node_modules\*"; DestDir: "{app}\node_modules"; Flags: recursesubdirs

[Icons]
Name: "{autodesktop}\POS Restaurante"; Filename: "{app}\Iniciar POS.bat"; WorkingDir: "{app}"
Name: "{group}\POS Restaurante"; Filename: "{app}\Iniciar POS.bat"; WorkingDir: "{app}"
; Autoarranque al prender el PC (minimizado)
Name: "{commonstartup}\POS Restaurante"; Filename: "{app}\Iniciar POS.bat"; WorkingDir: "{app}"; Flags: runminimized

[Run]
; Regla de firewall para que los teléfonos de la LAN alcancen el puerto 3000
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""POS Restaurante"""; Flags: runhidden
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""POS Restaurante"" dir=in action=allow protocol=TCP localport=3000"; Flags: runhidden
Filename: "{app}\Iniciar POS.bat"; Description: "Iniciar el POS Restaurante ahora"; Flags: postinstall skipifsilent

[UninstallDelete]
; los .log y archivos temporales sí se limpian; data\ (las ventas) se conserva
Type: files; Name: "{app}\*.log"

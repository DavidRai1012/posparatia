@echo off
rem Reconstruye el instalador del POS. Requisitos: Node.js y Inno Setup instalados.
cd /d "%~dp0"

echo Copiando el Node.js portable...
for /f "delims=" %%N in ('where node') do set NODE_ORIGEN=%%N
copy /y "%NODE_ORIGEN%" node.exe >nul

echo Compilando el instalador...
set ISCC="C:\Program Files\Inno Setup 7\ISCC.exe"
if not exist %ISCC% set ISCC="C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
%ISCC% instalador.iss
if %errorlevel%==0 (
  echo.
  echo Listo: instalador\salida\Instalar-POS-Restaurante.exe
) else (
  echo FALLO la compilacion del instalador
)
pause

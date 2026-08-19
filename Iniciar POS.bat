@echo off
title POS Restaurante
cd /d "%~dp0"

rem Usar el Node incluido en la instalacion; si no existe, el del sistema
if exist "%~dp0node.exe" (set NODE="%~dp0node.exe") else (set NODE=node)

rem Si el POS ya esta corriendo, solo abrir la app en el navegador
netstat -ano | findstr /r /c:":3000 .*LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo El POS ya esta corriendo. Abriendo la app...
  start "" http://localhost:3000
  timeout /t 3 >nul
  exit
)

echo ============================================
echo   POS Restaurante - iniciando servidor...
echo   NO CIERRE ESTA VENTANA durante el servicio
echo ============================================

rem Abrir el navegador cuando el servidor haya arrancado (4 segundos)
start /min cmd /c "timeout /t 4 >nul & start http://localhost:3000"

%NODE% server\index.js
pause

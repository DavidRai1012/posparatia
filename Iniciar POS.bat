@echo off
rem La ventana negra es solo el motor del POS. Se abre MINIMIZADA para que lo
rem que se vea sea la app en el navegador (el servidor la abre solo apenas
rem arranca). Lo que el sistema hace por dentro (envios a Google, correos,
rem reintentos) NO sale aqui: queda en data\registro.log.
if not "%POS_MINIMIZADO%"=="1" (
  set POS_MINIMIZADO=1
  start /min "POS Restaurante" cmd /c "%~f0"
  exit /b
)
title POS Restaurante
cd /d "%~dp0"

rem Usar el Node incluido en la instalacion; si no existe, el del sistema
if exist "%~dp0node.exe" (set NODE="%~dp0node.exe") else (set NODE=node)

rem Si el POS ya esta corriendo, solo abrir la app en el navegador
netstat -ano | findstr /r /c:":3000 .*LISTENING" >nul 2>&1
if %errorlevel%==0 (
  start "" http://localhost:3000
  exit
)

echo ============================================
echo   POS Restaurante - motor en marcha
echo   Puede dejar esta ventana minimizada.
echo   NO la cierre durante el servicio.
echo ============================================

%NODE% server\index.js
pause

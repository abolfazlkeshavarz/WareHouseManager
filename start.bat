@echo off
rem Starts the warehouse server. Double-click this file, then open http://localhost:3000
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install --omit=dev
)
set PORT=3000
node --no-warnings server\index.js
pause

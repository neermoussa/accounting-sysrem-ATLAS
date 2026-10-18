@echo off
rem Starts the Atlas backend (shared by all department apps) on port 4000.
cd /d "%~dp0backend"
set PUPPETEER_SKIP_DOWNLOAD=1
call npm install
node server.js

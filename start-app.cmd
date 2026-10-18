@echo off
rem Starts the Accounting app on port 5174.
cd /d "%~dp0frontend"
call npm install
call npx vite

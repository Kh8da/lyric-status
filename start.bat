@echo off
cd /d "%~dp0"
title Lyric Status
echo.
echo  Lyric Status
echo  http://127.0.0.1:3030
echo.

:: Check node
where node >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

:: Install deps if needed
if not exist node_modules (
    echo  Installing dependencies...
    npm install
    echo.
)

:: Check helper
if not exist track-helper\get-track.exe (
    echo  Building track helper...
    dotnet build get-track.csproj -c Release -o track-helper
    echo.
)

:: Open browser after short delay
start /b cmd /c "timeout /t 2 >nul && start http://127.0.0.1:3030"

:: Start server
node src/server.js
pause

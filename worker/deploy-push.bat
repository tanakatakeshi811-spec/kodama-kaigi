@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Kodama Kaigi - push notification setup
set "PATH=%PATH%;%ProgramFiles%\nodejs;%LOCALAPPDATA%\Programs\nodejs;%APPDATA%\npm"
where node >nul 2>nul
if errorlevel 1 goto nonode
node deploy-push.mjs
echo.
echo Press any key to close.
pause >nul
exit /b 0
:nonode
echo [ERROR] node was not found. Install Node.js from nodejs.org, then run this again.
pause
exit /b 1

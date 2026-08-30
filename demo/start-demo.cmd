@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo OneLive requires Node.js 20 or newer to start the local 3D demo.
  echo Install Node.js, then run this file again.
  pause
  exit /b 1
)
title OneLive Demo Server
node "%~dp0serve-demo.mjs"
if errorlevel 1 pause

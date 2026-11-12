@echo off
rem Windows launcher for setup (a Node script that a shebang cannot start here).
rem   setup          ask; every answer is pre-filled, Enter keeps it
rem   setup --yes    take every default without asking
where node >nul 2>nul
if errorlevel 1 (
  echo setup needs Node 18 or newer on PATH: https://nodejs.org/ 1>&2
  exit /b 1
)
node "%~dp0setup" %*

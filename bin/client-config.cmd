@echo off
rem Windows launcher for client-config (a Node script that a shebang cannot start here).
rem   bin\client-config            for compose.yaml (with the VPN sidecar)
rem   bin\client-config direct     for compose.direct.yaml
where node >nul 2>nul
if errorlevel 1 (
  echo client-config needs Node 18 or newer on PATH: https://nodejs.org/ 1>&2
  exit /b 1
)
node "%~dp0client-config" %*

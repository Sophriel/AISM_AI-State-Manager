@echo off
chcp 65001
cd /d "%~dp0.."
start "AISM Server" cmd /k npm start
timeout /t 2
start msedge --app=http://127.0.0.1:4400

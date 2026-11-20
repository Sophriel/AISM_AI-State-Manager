@echo off
chcp 65001 >nul
cd /d "%~dp0.."
start "AISM Server" cmd /k npm start

@echo off
chcp 65001
cd /d "%~dp0.."
start "AISM Server" cmd /k npm start

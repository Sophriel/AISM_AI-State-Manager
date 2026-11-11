@echo off
chcp 65001 > nul
REM 사용법:
REM   release.bat 비밀 단어가 뭐였는지 말하고 result.txt 에 DONE 이라고 써
REM   release.bat STOP        (멈춤 허용)
cd /d "%~dp0"
if "%~1"=="" (
    echo 사용법: release.bat ^<지시 문장^>   또는   release.bat STOP
    pause
    exit /b 1
)
> release.txt echo %*
echo released: %*

@echo off
chcp 65001 > nul
cd /d "%~dp0"
del /q release.txt hook.log 2>nul

REM 훅 경로를 절대경로로 넣은 settings 파일을 생성 (JSON용으로 \ -> /)
set "HOOK=%~dp0stop_hook.js"
set "HOOK=%HOOK:\=/%"
> settings.generated.json echo {"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node","args":["%HOOK%"],"timeout":1800}]}]}}

REM 클라우드(기본)로 테스트. 로컬 Qwen으로 하려면 아래 줄 주석 해제
set "ANTHROPIC_BASE_URL=http://127.0.0.1:8080"

title E-001 Stop hook parking
claude --settings "%~dp0settings.generated.json" "비밀 단어는 '바나나'야. 기억만 하고 '알겠어'라고만 답해."

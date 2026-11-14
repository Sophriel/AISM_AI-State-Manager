@echo off
setlocal
chcp 65001 > nul

REM ============================================================
REM  Claude Code 역할별 실행
REM  사용법: launch_role.bat <planner|verifier|coder> [slug]
REM  예)     launch_role.bat verifier fix-inventory-load-race
REM ============================================================

REM ---------- 경로 (환경에 맞게 수정) ----------
set "PROJECT_DIR=C:\Path\To\ai-state-manager"
set "ROLE_DIR=%PROJECT_DIR%\.claude\roles"

REM ---------- 역할별 엔드포인트 ----------
REM 로컬 llama-server 를 쓸 역할은 LOCAL, Anthropic API 를 쓸 역할은 CLOUD
set "EP_PLANNER=CLOUD"
set "EP_VERIFIER=LOCAL"
set "EP_CODER=LOCAL"
set "LOCAL_URL=http://127.0.0.1:8080"

REM ============================================================

set "ROLE=%~1"
set "SLUG=%~2"
if "%ROLE%"=="" (
    echo 사용법: %~nx0 ^<planner^|verifier^|coder^> [slug]
    pause & exit /b 1
)
if not exist "%ROLE_DIR%\role_%ROLE%.md" (
    echo [ERROR] 역할 파일 없음: %ROLE_DIR%\role_%ROLE%.md
    pause & exit /b 1
)

REM 공통 규약 + 역할 프롬프트를 하나로 합침
set "PROMPT_FILE=%TEMP%\claude_role_%ROLE%.md"
type "%ROLE_DIR%\_workflow.md" "%ROLE_DIR%\role_%ROLE%.md" > "%PROMPT_FILE%" 2>nul

REM 엔드포인트 선택
if /i "%ROLE%"=="planner"  set "EP=%EP_PLANNER%"
if /i "%ROLE%"=="verifier" set "EP=%EP_VERIFIER%"
if /i "%ROLE%"=="coder"    set "EP=%EP_CODER%"
if /i "%EP%"=="LOCAL" (
    set "ANTHROPIC_BASE_URL=%LOCAL_URL%"
) else (
    set "ANTHROPIC_BASE_URL="
)

REM 소스 쓰기 차단 (planner / verifier)
set "GUARD="
if /i not "%ROLE%"=="coder" set "GUARD=--disallowedTools "Edit(src/**)" "Edit(scripts/**)""

REM 첫 메시지
if "%SLUG%"=="" (
    set "FIRST=세션 시작. docs/work/ 목록을 보여주고 작업을 골라달라고 해."
) else (
    set "FIRST=세션 시작. 작업: %SLUG%"
)

title Claude [%ROLE%] %SLUG%
cd /d "%PROJECT_DIR%"
echo.
echo   role     : %ROLE%
echo   endpoint : %EP%  %ANTHROPIC_BASE_URL%
echo   task     : %SLUG%
echo.

claude --append-system-prompt-file "%PROMPT_FILE%" %GUARD% "%FIRST%"

endlocal

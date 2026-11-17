# Experiments

설계의 핵심 가정을 확인한 실험 기록. **결과만 이 문서에 남기고, 실험 코드(`experiments/`)는 git에서 제외한다** (로컬 전용).
재현이 필요하면 아래 "방법"대로 다시 만든다.

| ID | 질문 | 결론 | 날짜 |
|---|---|---|---|
| E-001 | Stop 훅 안에서 세션을 파킹했다가 외부에서 지시를 넣을 수 있나 | ✅ 가능 | 2026-11-11 |
| E-002 | wt.exe 실행·long-poll 끊김 감지·훅 병합·공백 경로 인자 | ✅ 모두 통과 (발견 사항 F-1~F-6) | 2026-11-11 |
| E-003 | `--append-system-prompt-file` 역할이 압축 후에도 유지되나 | ✅ 유지 | 2026-11-11 |
| E-004 | `--resume`으로 같은 대화를 새 창에 이어 붙일 수 있나 (역할 프롬프트·Stop 훅·session_id) | ✅ 가능 — session_id 유지 | 2026-11-16 |
| E-005 | 서버에서 PowerShell WinRT 토스트를 띄울 수 있나 | ✅ 가능 — 단 detached로 띄우면 표시 안 됨 | 2026-11-16 |
| E-007 | Edge 앱 창을 서버가 지정 크기로 띄우고 닫을 때 크기를 저장할 수 있나 | ✅ 가능 — 전용 프로필(`--user-data-dir`) + `--window-size`, `pagehide` sendBeacon + resize 디바운스 | 2026-11-17 |

---

## E-001. Stop 훅 파킹

**방법** — Stop 훅(Node)이 `release.txt`가 생길 때까지 대기. 내용이 `STOP`이면 exit 0(멈춤 허용), 아니면 `{"decision":"block","reason":<내용>}` 출력. 첫 프롬프트에 비밀 단어를 주고, 파킹 중 다른 창에서 `release.txt`를 써서 지시를 넣는다.

| # | 확인 | 결과 |
|---|---|---|
| W1 | 파킹 중 창 | 작업 중 스피너 유지 |
| W2 | 파킹 중 끼어들기 | 입력+엔터 → 프롬프트 **예약**. ESC → 훅 중단, 예약 입력 즉시 실행. 그 응답이 끝나면 Stop 훅 **다시 발화** |
| W3 | 지시 전달 | block reason을 같은 세션 맥락으로 수행(비밀 단어 기억), 끝나면 재파킹 |
| W4 | 훅 타임아웃 | `timeout: 1800` 도달 → 훅 취소, 세션은 멈춤 허용과 동일하게 정상 종료 (안전하게 실패) |
| W5 | 로컬 Qwen(`ANTHROPIC_BASE_URL`) | 동일 동작 |

환경: Windows 대화형(클라우드·로컬), Linux 헤드리스(Claude Code 2.1.322).

## E-002. 실행·long-poll·훅 병합

**방법** — Fastify 최소 서버(`POST /hook/stop` long-poll, `POST /release/:key`), Stop 훅, 세션 디렉터리(`env.bat`, `settings.json`, `prompt.md`, `args.txt`) 생성기, `launch_session.bat`(`call env.bat` → `set /p ARGS=<args.txt` → `claude %ARGS%`). EWE 경로(공백 포함, 기존 PostToolUse 훅 있음)에서 실행.

| # | 확인 | 결과 |
|---|---|---|
| U1 | `wt.exe -w new`가 새 창으로 열리나 | ✅ 독립 창 |
| U2 | 파킹 중 ESC / 창 닫기를 서버가 감지하나 | ✅ 둘 다 즉시 연결 종료 감지 (F-1 방식으로) |
| U3 | `--settings` 훅과 프로젝트 훅이 병합되나 | ✅ EWE의 normalize-eol(PostToolUse)과 AISM Stop 훅 모두 동작 |
| U4 | 공백 경로가 든 args.txt로 실행되나 | ✅ 정상, 역할 프롬프트·settings 적용 |
| E2E | 파킹 → block 지시 → 계속 → 재파킹 → allow → 종료 | ✅ |

**Stop 훅 stdin 필드** (server.log에 기록된 실제 payload, Claude Code 2026-11 기준): `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`(`"Stop"`), `stop_hook_active`, `last_assistant_message`, 그 밖에 `prompt_id`, `effort`, `background_tasks`, `session_crons`, `scratchpad_dir`. 필드명은 snake_case.

**발견 사항**

- **F-1 [중요]** Fastify에서 클라이언트 이탈은 `request.raw.socket.on("close")`로 감지한다. `request.raw.on("close")`는 요청 본문 수신 완료 시에도 발화해 파킹 직후 가짜 끊김이 생긴다.
- **F-2** 파킹을 푸는 요청(release 등)에도 응답을 보내야 호출 측이 타임아웃되지 않는다.
- **F-3** CLI로 띄운 세션은 Stop payload에 `transcript_path`가 있어도 해당 .jsonl이 생성되지 않았다. 원인 미확인. AISM은 파일·훅 기반이라 영향 없음.
- **F-4** 첫 프롬프트가 모호하면(작업 ID만) 세션이 질문 UI를 띄우고 멈춘다. 역할 프롬프트와 생성 헤더에 할 일을 명확히 준다.
- **F-5** 사용자 전역 `defaultMode: plan`이 세션에 상속되어 파일을 쓸 수 없다. 세션 settings에 `permissions.defaultMode`를 명시한다 (현재 `acceptEdits`).
- **F-6** 파킹 중 ESC는 훅 프로세스를 종료한다 (U2와 일치, 의도된 동작).

## E-003. 압축 후 역할 유지

**방법** — 코드네임을 포함한 역할을 `--append-system-prompt-file`로 주입한 헤드리스 세션에서 `/compact` 실행 후 역할을 묻는다. transcript의 `"subtype":"compact_boundary"`로 압축이 실제로 일어났는지 확인.

| 확인 | 결과 |
|---|---|
| 압축 발생 | ✅ `compact_boundary` 1개 |
| 압축 후 역할 (플래그 재전달) | ✅ 정확히 답함 |
| 압축 후 역할 (`--resume`에 플래그 없음) | ✅ 답했으나 요약에 의존한 것으로 보여 보장되지 않음 |

**결론** — 대화형 세션은 프로세스가 사는 동안 시스템 프롬프트가 고정이라 유지된다. `--resume`(S-9)으로 이어 붙일 때는 플래그를 반드시 다시 넘긴다.

## E-004. 이어서 띄우기

`--resume <session_id>`로 같은 대화를 새 창에 이어 붙인 것을 확인 (`.claude/plans/261114-m2-coder-loop/todo-v1-notes.md` E-004 절 요약).

| # | 확인 | 결과 |
|---|---|---|
| ① | 역할 프롬프트·Stop 훅 적용 | ✅ |
| ② | `AISM resume: <folder>` 첫 메시지·대화 유지 | ✅ |
| ③ | session_id 원래 값 유지 | ✅ |

**결론** — `--resume`은 같은 대화(역할·훅·session_id)를 새 창에 이어 붙인다. AISM은 세션 키당 `activeSessionId`를 저장해 "이어서 띄우기"로 재사용한다 (S-9).

## E-005. Windows 토스트

서버가 PowerShell WinRT 토스트(`scripts/toast.ps1`)를 띄우는 방식을 변형별로 확인.

| 변형 | 방식 | 결과 |
|---|---|---|
| A | 동기·inherit·기본 플래그 | ✅ |
| B | 동기·inherit·서버 플래그 (`-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden`) | ✅ |
| C | 비동기·pipe | ✅ |
| D | 비동기·pipe·detached | ❌ |
| E | 비동기·ignore | ✅ |
| F | 서버와 동일(detached·ignore) | ❌ |
| G | detached·ignore·windowsHide | ❌ |

**결론** — `detached: true`면 오류 없이도 토스트가 표시되지 않는다. 서버는 detached 없이(`stdio: "ignore"`) 띄운다 (ADR 0014). 진단 스크립트는 로컬 `experiments/E-005-toast/diag.cjs`(git 제외).

## E-007. UI 창 크기

- 방법: `.claude/plans/261116-m2-polish/todo-v1-checklist.md` 1번 — 크기를 바꾼 뒤 저장 확인, 바꾼 직후 바로 닫기(sendBeacon), 서버 재시작 후 같은 크기, 일반 Edge 창이 떠 있는 상태에서 재시작, `AISM_NO_UI=1`.
- 결과: 모두 이상 없음 (사용자 보고, 2026-11-17).
- 참고: E-006(PID 생존 감지)은 계획만 하고 보류 — 실행하지 않았다(`261114-m2-coder-loop` todo-v1-notes N4).

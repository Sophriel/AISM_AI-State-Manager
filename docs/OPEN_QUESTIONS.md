# Open Questions

결정되면 `docs/decisions/`에 ADR로 옮기고 여기서는 링크만 남긴다.
해소된 질문은 질문 칸에 취소선을 긋고 메모 칸 앞에 `해소:`와 근거(ADR 링크 또는 구현 위치)를 적는다. 열린 질문만 취소선이 없다.

| ID | 질문 | 관련 기능 | 메모 |
|---|---|---|---|
| Q-1 | ~~기술 스택~~ | 전체 | 해소: → [ADR 0003](decisions/0003-local-web-node-ts.md) (확정: Node/TS + React) |
| Q-2 | ~~세션을 어떻게 띄우나~~ | S-1 | 해소: `wt.exe -w new` + 세션별 env.bat로 구현 (`server/src/launcher.ts`, `scripts/launch_session.bat`). **방향: `wt.exe`로 별도 Windows Terminal 창** (사용자 선호). 주의: wt.exe는 기존 WT 프로세스에 위임할 수 있어 서버의 환경변수가 안 넘어갈 수 있음 → 환경변수는 창 안에서 실행되는 bat이 직접 설정 |
| Q-3 | ~~훅 → 오케스트레이터 신호 방식~~ | S-2, S-7 | 해소: 로컬 HTTP long-poll(`/hook/stop`)로 구현, 서버 꺼짐 시 → [ADR 0004](decisions/0004-hook-when-server-down.md). 방향: 로컬 HTTP(long-poll, 파킹용). 서버 꺼짐 시 동작은 → [ADR 0004](decisions/0004-hook-when-server-down.md) |
| Q-4 | ~~Stop 훅은 매 응답마다 발화 — "작업 완료"를 어떻게 구분하나~~ | S-7 | 해소: **해소 방향**: 매 Stop을 체크포인트로 보고 서버가 파일 상태로 판정 (S-7). E-001에서 동작 확인 |
| Q-5 | ~~설정·워크플로우 정의 포맷~~ | W-1 | 해소: 설정은 JSON → [ADR 0007](decisions/0007-config-and-limits.md). 워크플로우 정의 파일(W-1)은 M3 |
| Q-6 | ~~상태 저장 위치~~ | W-7 | 해소: → [ADR 0005](decisions/0005-state-in-aism-folder.md) |
| Q-7 | 역할별 스킬을 어떻게 제한하나 | R-6 | 공용 `.claude/skills` + 프롬프트 지시 vs 역할별 디렉터리 |
| Q-8 | ~~루프 상한과 연속 block 상한~~ | W-4 | 해소: → [ADR 0007](decisions/0007-config-and-limits.md) |
| Q-9 | ~~이전 단계 세션 재사용 vs 항상 새 세션~~ | R-8 | 해소: **해소 방향**: 역할별 선택 (R-8). PLAN은 유지(논의 맥락 보존), 로컬 VERIFY는 상황에 따라 |
| Q-10 | ~~역할 프롬프트 내 프로젝트 특화 내용(UE 엣지 케이스 등)을 어디에 둘까~~ | R-1 | 해소: 범용 `roles/` + 프로젝트 설정 `roleOverlay` 파일 (M1 구현, 사용 중). M1: 범용 `roles/` + 프로젝트 설정 `roleOverlay` 파일 1개. 사용해 보고 확정 |
| Q-11 | ~~**Windows 대화형 세션**에서 파킹 중 창 상태: 사용자가 입력/ESC로 끼어들 수 있나, 끼어들면 훅은 어떻게 되나~~ | S-8 | 해소: **E-001 2회차: 입력은 예약되고 ESC로 훅을 끊으면 예약 입력 실행 → 끼어들기 가능.** ESC 이후 응답이 끝나면 Stop 재발화 확인 → **서버가 세션을 놓치지 않음.** 해소 |
| Q-12 | ~~파킹 최대 시간: 훅 `timeout`(초)을 얼마까지 늘려도 안정적인가~~ | S-8 | 해소: `parkLimitSec`(3300) < `hookTimeoutSec`(3600) → [ADR 0007](decisions/0007-config-and-limits.md). 기본 600초, 문서상 명시된 상한 없음. **E-001 1회차: 1800초 파킹 후 타임아웃 → 세션 정상 종료 확인.** 서버는 타임아웃 전에 풀어주고, 놓치면 S-9로 복구 |
| Q-13 | ~~Windows 훅 실행 셸: Git Bash / PowerShell 차이~~ | S-7 | 해소: exec form(`"command":"node","args":[...]`)으로 구현 (`launcher.ts` settings.json). exec form(`"command":"node","args":[...]`)으로 셸 의존 제거 |
| Q-14 | ~~산출물 파일 이름~~ | W-2 | 해소: → [ADR 0006](decisions/0006-plan-folder-convention.md) |

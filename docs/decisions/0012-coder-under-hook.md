# 0012. CODER도 Stop 훅 아래에서 자동화한다

- 상태: 확정
- 날짜: 2026-11-14
- 출처: m2-coder-loop plan-v2 (§3 A·C)

## 맥락

M1까지 CODER는 서버 밖의 수동 세션이었다 — PLANNER가 TODO_READY로 멈추면 사용자가 CODER 창을 직접 띄우고 todo를 검토·구현했다. todo 검증 루프(W-5)와 BLOCKED·DONE 처리(W-6)를 자동화하려면 CODER도 다른 역할처럼 서버가 띄우고 Stop 훅으로 묶어야 한다(사용자 결정 D5).

## 결정

- **역할·설정 (D1)**: `Role = "planner" | "verifier" | "coder"`. 설정 `roles.coder`는 필수(엄격 검증의 닫힌 객체 `roles` 키 3개). 예시 설정 — endpoint `local`, permissionMode `acceptEdits`, prompt `roles/_workflow.md` + `roles/coder.md`.
- **보호 경로**: CODER에는 `protectedPaths` deny 규칙(`--disallowedTools "Edit(<path>)"`)을 붙이지 않는다 — 보호 경로는 "CODER가 아닌 역할이 건드리면 안 되는 곳"이고 CODER는 그곳을 고치는 역할이다. 나머지 런처 산출물(prompt.md, settings.json Stop 훅, env.bat, `--permission-mode`, `--name`, 첫 프롬프트)은 다른 역할과 같다.
- **todo 루프 (D2)**: 판정표에 행 5t(PLANNER)와 c1~c9(CODER)를 추가한다.

**PLANNER — 기존 행 5의 TODO_READY 분기를 교체 (행 5t):**

| 조건 | 동작 |
|---|---|
| T = null | allow + warn `notodo-v<N>` "plan-v<N>이 TODO_READY인데 todo 파일이 없습니다" |
| todo-vT-verify 없음 | hold(PLANNER) + `deliver("coder", instructionReviewTodo(T))` |
| 그 외(REVISE·PASS·MALFORMED) | allow (사용자 대화 중 또는 CODER 진행 중) |

**CODER — 새 행 (sender.role === "coder"), 위에서 처음 맞는 것:**

| 행 | 조건 | 동작 |
|---|---|---|
| c1 | Status TODO_READY, T = null | allow + warn `notodo-v<N>` (위와 같은 키·문구) |
| c2 | TODO_READY, todo-vT-verify 없음 | allow + warn `notodoverify-v<T>` "todo-v<T>-verify.md가 없습니다 — 검토 결과가 없습니다" |
| c3 | TODO_READY, REVISE, T < confirmFromVersion | hold(CODER) + `deliver("planner", instructionTodoRevise(T))` |
| c4 | TODO_READY, REVISE, T ≥ confirmFromVersion | hold(CODER) + warn `todo-gate-v<T>` "todo-v<T> REVISE — 계속 개정하려면 PLANNER 창에서 지시하세요" (D2) |
| c5 | TODO_READY, MALFORMED | block(CODER, instructionTodoVerdictLine(T)) (연속 상한 적용) |
| c6 | TODO_READY, PASS | instructed에 `impl-v<T>` 없으면 block(CODER, instructionImplement(T)) 후 기록, 있으면 allow |
| c7 | IN_PROGRESS | allow + info `coder-stopped-v<T>` "CODER가 구현 중 멈췄습니다 — CODER 창을 확인하세요" |
| c8 | BLOCKED | allow + warn `blocked-v<N>` "plan-v<N> BLOCKED — PLANNER에 다음 plan 작성을 지시합니다" + instructed에 `blocked-v<N>` 없으면 `deliver("planner", instructionBlocked(N))`, 결과가 "blocked"면 기록 |
| c9 | DONE | allow + info `done-v<N>` "구현 완료 (plan-v<N>) — 테스트 후 작업을 종료하세요" + PLANNER가 parked면 PLANNER도 allow |
| — | 그 외 | 행 11(예상하지 못한 상태) |

todo 개정 게이트는 plan과 같은 기준(D2) — `confirmFromVersion` 이상 todo REVISE부터 사용자 확인.

## 결과

- CODER 구현이 parkLimitSec보다 길면 PLANNER는 park-timeout으로 idle이 된다 — DONE의 "PLANNER allow"는 peer가 parked일 때만, BLOCKED 지시는 undeliverable(알림·복사)로 남는다.
- VERIFIER와 CODER가 같은 로컬 엔드포인트를 쓰지만 정상 흐름에서는 동시에 생성하지 않는다(plan PASS 뒤 VERIFIER는 allow되어 쉬므로). 사용자가 CODER 작업 중 VERIFIER를 직접 쓰면 로컬 서버가 요청을 줄 세워 느려진다(S-4 대기열 미구현).
- 기존 `state.json`(2키 assigned)은 형식이 달라져 버려진다(경고 1줄) — m1-polish 규칙 그대로.

## 검토한 대안

- **CODER를 수동 실행으로 두고 서버는 판정·알림만**: 사용자 결정 D5로 기각 — 다른 역할과 같은 방식으로 묶기로.
- **todo 판정을 기존 `Snapshot`에 합치기**: 기존 Snapshot 리터럴을 쓰는 테스트가 많아 변경 범위가 커짐 → 별도 `TodoSnapshot`(`readTodoSnapshot`).

# 0026. 끝난 VERIFIER·CODER에 지시가 오면 `--resume`으로 새 창을 이어서 띄운다

- 상태: 확정
- 날짜: 2026-11-24
- 출처: 261123-ui-polish plan-v5 (P6)

## 맥락

같은 작업에서 두 번째 plan부터 PLANNER → VERIFIER 지시가 자동으로 넘어가지 않았다. VERIFIER는 plan-v1을 PASS로 마치고 `idle`이 되는데, ADR 0011의 `deliver` 규칙은 `idle` peer에 `undeliverable`(알림만)을 내린다. 그래서 plan-v2 검증 지시가 VERIFIER 창에 자동으로 전달되지 않고 사용자가 수동으로 다시 띄워야 했다. CODER도 같은 경로(todo 검토 지시)라 함께 다룬다.

## 결정

지시 전달 규칙(`deliver`)과 VERIFIER 종료 행을 바꾼다. ADR 0011 표의 `idle` 행을 이 ADR이 대체한다.

**VERIFIER 행 8(PASS)**: `allow` → `hold`(파킹). PASS를 낸 VERIFIER는 `idle`이 아니라 **파킹으로 대기**한다. 이후 PLANNER에 todo 작성을 지시하는 부분은 그대로.

**`deliver` peer 상태 기준**:

| peer 상태 | 역할 | 변경 후 |
|---|---|---|
| 없음(배정 없음) | VERIFIER·CODER | `launch` (그대로) |
| `detached` | 모든 역할 | `undeliverable` (ADR 0011 그대로) |
| `parked` | 모든 역할 | `block` (그대로) |
| `idle` | **VERIFIER·CODER** | **`resume-launch`** — `claude --resume <activeSessionId>`로 새 창 + "이전 창은 닫으세요" 알림 |
| `idle` | PLANNER | `undeliverable` (ADR 0011 그대로) |
| `working` / `unbound` | 모든 역할 | 없음 (그대로) |

**`resume-launch` 처리** (orchestrator): 그 역할 세션의 `activeSessionId`가 있으면 `launchRole(..., activeSessionId, true)`(기존 S-9 `--resume` 경로)로 새 창을 띄우고 알림 `"<ROLE> 창을 이어서 새로 띄웠습니다 — 이전 창은 닫으세요"`(info). `activeSessionId`가 없으면 `undeliverable`로 처리(알림만). 코딩 잠금 등 `launch` 전용 전처리는 `resume-launch`에도 같게 적용한다.

**PLANNER는 그대로**: `idle` PLANNER에 지시가 오면 `undeliverable`(ADR 0011). PLANNER가 `idle`이면 사용자가 그 창에서 대화 중(DRAFT·NEEDS_DECISION 등)이므로 새 창을 띄우지 않는다. `detached`도 ADR 0011 그대로.

**CODER는 파킹하지 않음**: CODER 블록의 `allow` 종료 행은 전부 `allow`로 둔다. 특히 커밋 계획 지시 후(`commitPlanExists`)는 사용자가 **CODER 창에서 커밋을 허가**해야 하는데, 파킹하면 Stop 훅이 창을 붙잡아 입력할 수 없다(ESC 시 detached). 따라서 CODER는 끝나면 `idle`이 되고, 다음 todo 검토 지시는 `deliver` idle → `resume-launch`로 전달된다. 파킹 대기는 VERIFIER에만 적용한다(VERIFIER는 PASS 뒤 사용자가 그 창에서 할 일이 없음).

## 결과

- 두 번째 plan부터도 PLANNER Stop → VERIFIER 지시가 자동으로 전달된다(파킹 중이면 `block`, `idle`이면 `resume-launch`).
- PASS 직후에는 VERIFIER 창이 파킹으로 남아 있어 사용자가 결과를 보고 있을 때 새 창이 바로 뜨지 않는다.
- `idle`(파킹 상한 후) 상태에서 지시가 오면 이전 대화를 `--resume`으로 이어 붙인 새 창이 뜨고, "이전 창은 닫으세요" 알림이 뜬다.
- 활성 세션 id가 없으면(서버 재시작 후 detached 등) 알림만 — ADR 0011과 같은 복구 경로.

## 검토한 대안

plan-v5 D1에서 고른 선택지는 **D**였다(추천은 C).

- **A — `idle` 유지 + 알림만 (현행 `undeliverable`)**: 기각. 두 번째 plan부터 자동 전환이 안 되는 문제를 그대로 둔다 — 사용자가 매번 수동으로 다시 띄워야 한다.
- **B — `idle` 시 새 창을 `--resume` 없이(새 대화)로 띄우기**: 기각. 이전 검증 대화 맥락(검증 진행 상황)을 잃는다.
- **C — `idle` 시 `--resume`으로 새 창 띄우기 (파킹 없음)**: 기각(추천이었음). PASS 직후 사용자가 그 창에서 결과를 보고 있을 때 새 창이 바로 뜨면 두 창이 같은 역할로 동시에 동작한다(배정은 새 세션으로 옮겨지고 옛 창 Stop은 배정 게이트에서 즉시 allow).
- **D (선택) — 파킹 대기 + 상한 후 `--resume` 새 창**: PASS 후 `hold`(파킹) → `parkLimitSec` 지나면 `idle` → 그 뒤 지시가 오면 `--resume` 새 창 + "이전 창은 닫으세요" 알림. PASS 직후에는 창이 남아 있어 동시 동작을 피하고, 상한 후엔 자동으로 이어 붙인다.

## 장기

- `resume-launch`는 VERIFIER·CODER에만 적용한다. PLANNER는 ADR 0011(알림만)을 유지한다.
- 여러 작업이 같은 VERIFIER 창을 공유하지 않는다 — 배정은 작업별(`task.assigned`).

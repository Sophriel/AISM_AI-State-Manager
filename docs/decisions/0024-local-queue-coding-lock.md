# 0024. 로컬 모델 대기열과 프로젝트별 코딩 잠금 — 한 프로젝트 CODER 하나, 순서 대기

- 상태: 확정
- 날짜: 2026-11-20
- 출처: 261120-parallel-tasks-stage2 plan-v4 (§3 C~G)

## 맥락

1단계(ADR 0022)는 여러 작업을 동시에 진행할 수 있게 했지만, 같은 프로젝트의 두 작업이 CODER를 동시에 돌리거나 두 작업이 같은 로컬 엔드포인트를 동시에 쓰는 것을 서버가 막지 않았다 — 사용자가 피해야 했다. 사용자 요청(D3, D4, D6, D7, D8, D11): 로컬 엔드포인트 사용 중이면 대기열로 순서를 지키고, 프로젝트별 코딩 잠금으로 CODER를 한 작업만 돌리며, git 프로젝트는 `커밋 완료` 버튼으로 잠금을 넘기고, 대기는 "순서 대기" 배지로 보인다.

## 결정

- **로컬 모델 대기열**(D3): 로컬 엔드포인트(설정 `endpoints`에 `ANTHROPIC_BASE_URL`이 있는 것)를 다른 세션이 쓰는 중이면, 그 엔드포인트로 가는 지시(block)와 지시가 있는 실행(launch)은 메모리 대기열(`localQueue`)에 넣고, 사용이 끝나면(Stop·detached·작업 종료) 차례대로 처리한다. 대상이 parked가 아니면 undeliverable(알림·복사)로 대체한다.
- **프로젝트별 코딩 잠금**(D4, D7): 구현 지시(c6)를 받는 CODER는 프로젝트당 한 작업 — `codingLocks[project]`. 다른 작업이 잠금을 갖고 있으면 구현 지시를 `codingQueue`에 대기시킨다. BLOCKED는 잠금을 유지한다(D7).
- **잠금 해제**(D6, D11): git 프로젝트는 UI의 **커밋 완료** 버튼(`POST /api/tasks/commit-done`, `task.commitDone` 기록), git 아님 프로젝트는 CODER DONE Stop, 공통으로 작업 종료. 잠금이 풀리면 대기열 첫 항목이 잠금을 받고 구현 지시를 전달받는다.
- **"순서 대기" 배지**(D8): 대기 중인 역할은 `queued`(`순서 대기`) 배지와 사유 한 줄(로컬 모델 사용 중 / 같은 프로젝트의 다른 작업이 커밋할 때까지)을 보인다. 다른 작업 이름은 보이지 않는다.
- **CODER 규약 변경**(D4): todo 검토에서 `판정: PASS`를 쓰면 턴을 끝내고, 서버의 구현 지시(`todo-vN-verify.md가 PASS다. todo-vN.md를 순서대로 구현해.`)를 받은 뒤에만 구현을 시작한다.

## 잠금 대기열 저장 이유

c6은 block과 같은 평가에서 `impl-v<T>`를 기록하므로 같은 지시는 다시 나오지 않는다. 대기열을 메모리에만 두면 서버 재시작 뒤 CODER는 구현 지시를 영영 못 받는다. 그래서 `codingQueue`는 `state.json`에 저장하고, 재시작 후에도 차례가 오면 전달한다(대상이 parked가 아니면 undeliverable). 로컬 대기열(`localQueue`)은 메모리만 — 재시작 시 비워지고, 잃은 구현 지시는 relaunch 첫 지시 규칙으로 복구한다.

## 지시 없는 launch 제외

지시(instruction)가 없는 로컬 역할 launch(새 작업 PLANNER, UI relaunch)는 사용자가 입력하기 전까지 모델을 쓰지 않으므로 대기·사용 중 표시 대상에서 제외한다. 사용 중 판정은 "서버가 보낸 지시 기준"으로 한정 — 사용자가 세션 창에 직접 입력해 시작한 사용은 다음 Stop에서야 해제가 된다(README 한계).

## relaunch 첫 지시 규칙

재시작·세션 교체로 잃은 구현 지시를 복구하기 위해 `relaunch`의 첫 지시를 순서대로 판정한다: 1) 그 역할의 `undelivered`, 1-1) 그 작업·역할의 로컬 대기 항목(찾으면 대기열에서 삭제), 2) 그 작업이 코딩 잠금을 갖고 plan이 `TODO_READY`이고 최신 todo가 `PASS`이며 `impl-v<T>`가 기록되어 있으면 `instructionImplement(T)`. 첫 지시가 있으면 로컬 대기열 규칙을 거친다(사용 중이면 `queued: true`). relaunch 없이 창에서 직접 이어 가면 사용자가 구현을 지시해야 한다(README 한계).

## 결과

- `state.json` 형식 변경 — `Task.commitDone`, `State.codingLocks`·`codingQueue` 추가. 이전 형식은 버려지므로 업그레이드 전 작업을 종료해야 한다.
- 웹: `순서 대기` 배지(#9b59b6)·사유 줄, git 프로젝트 DONE 상태의 **커밋 완료** 버튼(확인 창 포함).
- `roles/coder.md`·`.claude/roles/role_coder.md`·두 `_workflow.md` 규약 갱신 — PASS 후 턴 종료, 구현 지시 대기.

## 검토한 대안

- **잠금 대기 시 `impl-v<T>` 기록을 빼서 다음 Stop에서 재판정**: 대기 중 CODER는 parked라 다음 Stop이 오지 않고, 판정표 순수성을 깨므로 기각 — 저장된 대기열로 대신.
- **로컬 사용 중을 "세션이 working인 동안"으로 판정**: 사용자가 직접 입력한 경우까지 잡으려면 터미널 관찰이 필요(ADR 0002 위반). 서버가 보낸 지시 기준으로 한정.
- **커밋 완료를 git으로 자동 판정**: ADR 0019 유지 — 버튼(D6).

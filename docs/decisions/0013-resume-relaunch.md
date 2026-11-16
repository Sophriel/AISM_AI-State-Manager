# 0013. 이어서 띄우기는 `--resume` + `AISM resume:` 첫 프롬프트, 새 sessionKey

- 상태: 확정
- 날짜: 2026-11-14
- 출처: m2-coder-loop plan-v2 (§3 E)

## 맥락

ADR 0011 이후 끊긴 세션은 알림만 나고 사용자가 다시 띄우기(새 대화)해야 했다. 새 대화는 이전 맥락을 잃는다 — `claude --resume <session_id>`로 같은 대화를 새 창에 이어 붙이면(S-9) "창을 닫았다"와 "ESC 개입" 모두 복구된다.

## 결정

- **API**: `POST /api/tasks/relaunch` 본문 `{ role, mode? }`, `mode` ∈ `"new" | "resume"`, 없으면 `"new"`, 그 외 400.
- **허용 조건**: `mode === "resume"`는 기존 허용 상태(detached·idle; unbound 예외는 resume에 적용 안 함) **그리고** `task.folder !== null` **그리고** 배정된 세션의 `activeSessionId !== null`. 아니면 409(`cannot resume`).
- **런처**: `LaunchOptions.resumeSessionId?: string`. 있으면 args에 `--resume <id>`를 넣고 첫 프롬프트는 `"AISM resume: <folder>"`(ASCII — args.txt는 ASCII만). 그 밖의 인자는 같다.
- **sessionKey**: 항상 **새** sessionKey로 `working` 등록, `assign`으로 이전 키 배정 해제(allow "unassigned"). 이벤트 `{ type: "launch", role, sessionKey, relaunch: true, resume: true }`.
- **역할 규약**: `roles/_workflow.md` "Session start" 1에 추가 — `If the first message is \`AISM resume: <folder>\`, you are continuing your earlier conversation in a new window: re-read the latest files of that folder and continue your role's next step; do not start over.`
- **웹**: 역할마다 "<ROLE> 이어서 띄우기" 버튼. 조건 `canResume`은 서버 조건과 같고, 웹은 `getState().sessions[key].resumable`(= `activeSessionId !== null`)로 판단한다.

## 결과

- 이전 창이 살아 있으면 그 창의 Stop은 배정 게이트에서 allow — 더 이상 자동으로 지시받지 않는다(다시 띄우기와 같은 확인 대화상자).
- resume 대상 대화가 다른 cwd에서 만들어졌다면 Claude Code가 찾지 못할 수 있다 — 런처는 항상 프로젝트 루트로 `cd`하므로 AISM이 띄운 세션은 같은 cwd.
- **E-004 확인 항목** (구현 후 체크리스트): ① `--resume <id>`와 `--append-system-prompt-file`·`--settings`를 함께 줘도 역할 프롬프트와 Stop 훅이 적용되는지, ② 첫 프롬프트 인자가 resume 대화의 다음 사용자 메시지로 들어가는지, ③ Stop payload의 `session_id`가 원래 id인지 새 id인지(동작에는 영향 없음, 기록만). ①·②가 안 되면 이어서 띄우기 버튼을 숨기고(서버 resume 409) 다음 plan에서 다룬다. 결과는 `docs/experiments.md`에 기록.

## 검토한 대안

- **전달 못 한 지시문을 첫 프롬프트로 직접 넘기기**: 지시문이 한국어라 `args.txt`(ASCII) 경로로 못 넘김 → `AISM resume: <folder>` + 역할 규약으로 파일을 다시 읽게 함. 다음 Stop에서 평가가 필요한 지시를 다시 낸다.
- **같은 sessionKey로 resume**: 이전 창이 살아 있으면 두 창이 같은 키로 Stop을 보내 혼선 → 새 sessionKey + 이전 키 배정 해제.

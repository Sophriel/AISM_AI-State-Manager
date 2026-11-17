# 0015. 새로 띄우는 세션의 첫 지시는 prompt.md 헤더 `First instruction:`로

- 상태: 확정
- 날짜: 2026-11-16
- 출처: m2-polish plan-v3 (§3 B)

## 맥락

`deliver`가 peer가 없는 역할에 launch를 내리면 지시 문구가 함께 가는데, 런처는 그 지시를 버렸다(N2) — 새 세션은 "무엇을 하면 되는지" 모른 채 시작한다. args.txt는 ASCII로만 쓴다(ADR 0013)라 한국어 지시를 첫 프롬프트 인자로 넘길 수 없다.

## 결정

- **launch Action**: `{ kind: "launch"; role; instruction? }` — `deliver`가 전달 못 한 지시(`undelivered`)를 그대로 싣는다.
- **런처**: `LaunchOptions.firstInstruction`이 있으면 prompt.md의 AISM context 헤더 마지막 줄에 `First instruction: <지시>`를 추가한다. args.txt·첫 프롬프트에는 넣지 않는다.
- **기록**: launch 이벤트에 `instruction`(2000자 절단)을 붙여 타임라인에 `Launch <ROLE> — 지시: …`로 보인다.
- **relaunch**: 전달 못 한 지시(`undelivered`)가 있으면 새 세션의 `firstInstruction`으로 넘기고 바로 삭제한다.
- **역할 규약**: `roles/_workflow.md` Session start 1번에 "First instruction:" 줄이 있으면 작업 폴더를 읽은 뒤 그 지시를 이 세션의 첫 단계로 수행하되, 세션 시작 시 한 번만 적용한다는 문장을 둔다.

## 결과

- 새 세션은 첫 지시를 헤더에서 읽고 바로 일을 시작한다. 타임라인에 어떤 지시로 띄웠는지 보인다.
- 안전 장치는 역할 규약(plan-v3 §3 B 문단)이다 — 지시는 한 번만 적용하고, 지시와 충돌하면 작업 폴더의 상태가 우선한다.

## 검토한 대안

- **첫 프롬프트 인자**: args.txt는 ASCII(ADR 0013)라 한국어 지시를 넣을 수 없음 → 기각.
- **지시 미전달 유지 (기존)**: 새 세션이 무엇을 해야 하는지 모르고 대기함(N2) → 기각.

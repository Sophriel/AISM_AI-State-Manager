# 0009. 역할 이름을 PLANNER/VERIFIER/CODER로

- 상태: 확정
- 날짜: 2026-11-14
- 출처: M1-polish plan-v3 (§A)

## 맥락

기존 역할 이름 `PLAN`/`VERIFY`/`CODE`는 역할을 드러내지 못했다. `PLAN`은 산출물 파일명(`plan-vN.md`)과, `CODE`는 일반 명사 "코드"와 혼동된다. 세션 창 제목·알림·UI 배지·타임라인에 표시되는 이름이 역할을 명확히 드러내야 한다.

## 결정

역할 이름을 **PLANNER / VERIFIER / CODER**로 바꾼다. 적용 범위:

- **표시 이름** — 세션 창 제목, 알림 문구, UI 배지, 타임라인.
- **내부 식별자** — `Role = "planner" | "verifier"` (CODER는 M2), 설정 `roles.planner`/`roles.verifier`, 세션 키 접두사 `planner-`/`verifier-`.
- **파일 이름** — 역할 프롬프트 `roles/planner.md`·`roles/verifier.md`, 개발용 `.claude/roles/role_planner.md`·`role_verifier.md`·`role_coder.md`, 실행 스크립트 인자.

산출물 파일명(`plan-vN.md`, `plan-vN-verify.md`, `todo-vN.md`, `code-log.md`)과 `Status:` 값은 그대로 둔다 — 역할 이름이 아니라 산출물 규약이다.

## 결과

- **이전 형식 state는 버린다.** `state.json`이 현재 형식과 다르면(예: `assigned.plan`, 세션 `role: "plan"`) 무시하고 빈 상태로 시작한다. 이전 형식 판별·변환 코드는 없다.
- **설정은 현재 형식과 다르면 시작 거부.** `aism.config.json`이 현재 형식과 다르면 서버가 고칠 항목을 알려 주고 시작하지 않는다. 이전 형식 자동 변환은 없다.
- **기록 문서는 수정하지 않는다.** ADR·plan·todo·code-log 등 과거 기록은 작성 시점의 이름을 그대로 유지한다.

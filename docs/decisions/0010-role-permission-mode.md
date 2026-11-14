# 0010. 역할별 권한 모드는 설정의 permissionMode로

- 상태: 확정
- 날짜: 2026-11-14
- 출처: M1-polish plan-v3 (§C)

## 맥락

ADR 0008은 모든 역할 세션에 `settings.json`의 `permissions.defaultMode: "acceptEdits"`를 명시했다. 하지만 역할마다 필요한 권한이 다르다 — PLANNER는 산출물(plan/todo)을 자유롭게 써야 하고, VERIFIER는 검증 파일만 쓴다. 역할을 구분해 권한 모드를 지정할 수 있어야 한다.

## 결정

1. **역할 설정에 `permissionMode`를 추가한다.** `roles.<role>.permissionMode` ∈ `default | acceptEdits | auto | plan | bypassPermissions`. 생략 시 기본 `acceptEdits`.
2. **CLI `--permission-mode`로 전달한다.** `settings.json`의 `permissions` 키는 두지 않고, 세션 시작 인자에 `--permission-mode <mode>`를 붙인다.
3. **예시 설정** — PLANNER `auto`, VERIFIER `acceptEdits`.

## 이유

- `auto`는 지원 프로바이더·모델에서만 동작한다. 로컬 엔드포인트(llama-server 등)는 `auto`를 지원하지 않아 Manual(권한 확인)로 떨어지므로, 로컬을 쓰는 역할은 `acceptEdits`를 쓴다.

## 미확인

- `--permission-mode` 플래그가 사용자 전역 설정의 `defaultMode`를 실제로 이기는지. 구현 후 체크리스트로 확인하고, 이기지 못하면 `settings.json`의 `defaultMode`를 병행한다.

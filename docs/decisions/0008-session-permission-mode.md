# 0008. 역할 세션의 권한 모드는 acceptEdits로 명시한다

- 상태: 확정 (사후 기록 — M1 구현 중 CODE가 적용, 사용자 승인)
- 날짜: 2026-11-12
- 출처: E-002 F-5 (`docs/experiments.md`), M1 todo T9

## 맥락

AISM이 띄운 세션은 사용자 전역 설정의 `permissions.defaultMode`를 상속한다.
사용자 전역 기본값이 `plan`(읽기 전용)이라, 그대로 두면 PLAN은 `plan-vN.md`를, VERIFY는 `plan-vN-verify.md`를 쓸 수 없어 루프가 멈춘다.
또 무인 진행 중 파일 쓰기마다 권한 확인 프롬프트가 뜨면 사람이 없을 때 세션이 멈춘다.

## 결정

AISM이 생성하는 세션 `settings.json`에 `permissions.defaultMode: "acceptEdits"`를 명시한다 (`server/src/launcher.ts`).

## 안전장치

- 프로젝트의 `protectedPaths`를 PLAN·VERIFY에 `--disallowedTools "Edit(<p>)" "Write(<p>)"`로 전달해 소스 쓰기를 막는다 (plan-v3 §3.2).
- 역할 규약의 "소스 수정 금지"가 1차 방어다. Bash를 통한 쓰기는 위 설정으로 막을 수 없다.
- acceptEdits는 파일 편집만 자동 승인한다. Bash 명령 등 다른 권한은 기존 설정을 따른다.

## 결과

- 사용자 전역 설정과 관계없이 역할 세션이 산출물을 쓸 수 있다.
- 역할별로 다른 모드가 필요해지면(예: M2의 CODE) 설정에 역할별 `permissionMode`를 추가한다.

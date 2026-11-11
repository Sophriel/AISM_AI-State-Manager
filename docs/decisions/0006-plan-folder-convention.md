# 0006. 산출물은 EWE 방식의 버전 파일 규약을 따른다

- 상태: 확정
- 날짜: 2026-11-11

## 맥락

초기 규약은 `docs/work/<slug>/PLAN.md` 한 파일에 Revision을 올리고 `REVIEW.md`에 섹션을 누적하는 방식이었다.
실제로 EWE에서 써 온 방식은 다르며, 사용자에게 익숙하다.

## 결정

    <plans 루트>/<YYMMDD>-<slug>/
        plan-v1.md
        plan-v1-verify.md
        plan-v2.md
        plan-v2-verify.md
        ...
        todo.md
        code-log.md

- 개정마다 새 plan 파일을 만든다. 이전 버전은 수정하지 않는다.
- 최신 plan의 첫 줄 `Status:`와 verify 파일의 마지막 줄 `판정: PASS|REVISE`가 상태 판정의 근거다.
- plans 루트는 프로젝트별 설정값. 기본값 `.claude/plans/` (AISM, EWE 모두). **git 추적 대상이 아니다** — 작업용 파일이며, 남길 가치가 있는 결정은 ADR로 옮긴다.

## 결과

- 이력이 파일로 남아 비교가 쉽다.
- **루프 횟수 = 최신 plan 버전 N**이라서 서버가 따로 셀 필요가 없다 (W-4).
- 다음 차례는 파일 존재 여부만으로 정해진다 (`_workflow.md`의 "Whose turn" 표).

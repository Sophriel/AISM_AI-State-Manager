# 0007. 설정 파일과 기본 한도

- 상태: 확정
- 날짜: 2026-11-11
- 출처: M1 plan-v3 (§3.2, §3.6)

## 결정

1. **설정 포맷은 JSON** — `aism.config.json`. 의존성 없이 읽고, TypeScript 타입으로 검증한다. 개인 경로가 들어가므로 git에서 제외하고 `aism.config.example.json`을 커밋한다. (Q-5)
2. **엔드포인트 = 환경변수 묶음.** 세션 시작 전 관리 대상 변수(`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`)를 모두 비운 뒤 역할의 묶음을 설정한다. `cloud: {}` = Claude Code 기본 엔드포인트.
3. **같은 세션에 사용자 개입 없이 연속 block은 3회까지.** 넘으면 멈춤 허용 + 알림. (Q-8)
4. **plan 자동 왕복은 plan-v5-verify까지.** 이후 REVISE는 매 라운드 사용자 확인 (D2, ADR 0006).
5. 파킹 한도 `parkLimitSec` 3300 < 훅 타임아웃 `hookTimeoutSec` 3600.

# AISM (AI State Manager)

역할이 고정된 Claude Code 세션(PLAN / VERIFY / CODE)을 Stop 훅과 파일 계약으로 이어 붙이는 **로컬 오케스트레이터**.
사용자 1명, Windows 전용, 개인 도구.

현재 단계: 기획 완료, 구현 전. 첫 마일스톤은 M1(PLAN⇄VERIFY 루프) — `docs/FEATURES.md` 상단.

## 어디에 무엇이 있나

| 경로 | 내용 |
|---|---|
| `docs/VISION.md` | 목표, 원칙, 비목표 — 설계 판단이 애매하면 여기부터 |
| `docs/FEATURES.md` | 기능 ID(R-/W-/S-/G-)와 우선순위, 마일스톤 |
| `docs/OPEN_QUESTIONS.md` | 미결 사항 (Q-n) |
| `docs/decisions/` | 확정된 결정 (ADR). **뒤집으려면 새 ADR을 쓴다** |
| `experiments/` | 핵심 가정 검증 실험 (E-001: Stop 훅 파킹 — 검증 완료) |
| `.claude/roles/` | 역할 세션 시스템 프롬프트. `_workflow.md`가 공통 규약 |
| `.claude/plans/` | 작업별 플랜 폴더 (git 제외) |

## 확정된 전제 (ADR 요약)

- 하네스는 Claude Code를 그대로 쓴다. 에이전트 기능을 재구현하지 않는다. (0001)
- 상태 판정은 파일과 훅으로만. 터미널 출력 파싱·LLM 판단 금지. (0002)
- 스택: Node.js + TypeScript (Fastify) 서버, SSE, React + Vite UI. 훅 스크립트도 Node. (0003)
- 세션은 `wt.exe`로 별도 Windows Terminal 창에 띄운다.
- 산출물은 `.claude/plans/<YYMMDD>-<slug>/plan-vN.md`, `plan-vN-verify.md`. (0006)

## 작업 규칙

- 사용자와는 한국어로. 코드 식별자·경로는 원문 그대로.
- **커밋·푸시는 사용자가 요청할 때만.**
- 새 결정은 `docs/decisions/NNNN-*.md`로 남기고, 관련 Q-n은 OPEN_QUESTIONS에서 해소 표시.
- 기능을 추가·변경하면 FEATURES.md의 ID와 상태를 함께 갱신.
- Windows 우선: 경로·프로세스·줄바꿈(`.bat`은 CRLF)을 Windows 기준으로 생각한다.
- 역할 세션으로 실행된 경우 역할 규약(`.claude/roles/`)이 이 파일보다 우선한다.

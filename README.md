# AI State Manager

역할이 고정된 Claude Code 세션(PLAN / VERIFY / CODE 등)을 파일 계약과 상태 머신으로 이어 붙여, 세션이 끝나면 다음 작업이 자동으로 이어지게 하는 로컬 오케스트레이터.

> 상태: 기획 단계 — 기능 정리와 문서화 진행 중. 코드 없음.

## 문서

| 문서 | 내용 |
|---|---|
| [docs/VISION.md](docs/VISION.md) | 왜 만드는가, 무엇을 만들고 무엇을 안 만드는가 |
| [docs/FEATURES.md](docs/FEATURES.md) | 기능 목록 (초안, 우선순위 포함) |
| [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md) | 아직 결정하지 않은 것 |
| [docs/decisions/](docs/decisions/) | 결정 기록 (ADR) |
| [docs/prior-art.md](docs/prior-art.md) | 검토한 기존 도구와 차이점 |
| [experiments/](experiments/) | 핵심 가정을 확인하는 작은 실험 |

## 이 레포의 작업 방식

이 레포 자체도 3세션 워크플로우로 개발한다 (dogfooding).
역할 정의는 `.claude/roles/`, 플랜 폴더는 `.claude/plans/<YYMMDD>-<slug>/` (plan-vN.md / plan-vN-verify.md, git 제외).

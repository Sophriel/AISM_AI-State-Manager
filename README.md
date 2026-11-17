# AI State Manager

역할이 고정된 Claude Code 세션(PLANNER / VERIFIER / CODER 등)을 파일 계약과 상태 머신으로 이어 붙여, 세션이 끝나면 다음 작업이 자동으로 이어지게 하는 로컬 오케스트레이터.

> 상태: M1(PLANNER⇄VERIFIER 루프) 구현 중. Windows 전용, 사용자 1명, 개인 도구.

## 설치

Windows + Node.js 22+ 필요.

```bat
npm install
copy aism.config.example.json aism.config.json
```

`aism.config.json`을 열어 `projects.<이름>.root`를 실제 프로젝트 경로로, `endpoints.local.*`를 사용할 로컬 엔드포인트로 수정한다. (예시: `C:/Users/<you>/Desktop/Projects/Unreal Projects/EWE`)

빌드(웹 UI + 서버):

```bat
npm run build
```

업그레이드할 때는 먼저 UI에서 작업을 종료하세요. 현재 형식과 다른 state.json은 무시되어(플랜 파일은 대상 레포에 그대로 남음) 진행 중이던 작업의 배정·알림 기록이 사라집니다. 설정 파일이 현재 형식과 다르면 서버가 고칠 항목을 알려 주니 aism.config.example.json에 맞춰 고치세요.

M2부터 설정에 `roles.coder`(필수)와 선택 키 `toast`가 있습니다 — aism.config.example.json을 참고해 추가하세요. Windows 토스트는 Windows PowerShell 5.1(`powershell.exe`)로 띄웁니다. 선택 키 `window`(UI 창 크기)도 있습니다.

## 실행

```bat
scripts\start_aism.bat
```

레포 루트로 이동 → 새 창에서 `npm start`(서버, 127.0.0.1:4400). 서버가 시작되면 Edge 앱 모드로 UI 창을 띄운다(설정 `window`의 크기, 없으면 1000×900). 창을 닫을 때 마지막 크기가 설정 파일 `window`에 저장된다(서버가 설정 파일을 2칸 들여쓰기로 다시 쓴다). UI는 AISM 전용 Edge 프로필(`state/edge-profile`)을 쓰므로 브라우저 알림 권한은 처음 한 번 다시 허용한다. Edge가 필요하다. 서버만 다시 켤 때는 환경변수 `AISM_NO_UI=1`로 창을 띄우지 않는다. 개발 중에는 `npm run dev`(서버+웹 HMR 동시 실행)를 쓴다.

## 사용 흐름

1. UI에서 프로젝트를 고르고 **새 작업**을 누른다 — PLANNER 세션이 새 터미널 창에 뜬다.
2. PLANNER 창에서 작업을 설명하면 PLANNER가 `plan-v1.md`를 작성하고 멈춘다.
3. 서버가 PLANNER를 파킹하고 VERIFIER 세션을 띄운다 — VERIFIER가 `plan-v1-verify.md`에 `판정: PASS/REVISE`를 쓴다.
4. REVISE면 PLANNER가 지시를 받아 `plan-v2.md`를 만들고 다시 VERIFIER로, PASS면 PLANNER가 todo 작성 지시를 받아 TODO_READY가 되면 알리고 멈춘다.
5. UI의 **작업 종료**로 작업을 끝낸다.

플랜 폴더는 미리 만들지 말고, 새 작업을 시작한 뒤 PLANNER 창에서 만들게 한다.

## 문서

| 문서 | 내용 |
|---|---|
| [docs/VISION.md](docs/VISION.md) | 왜 만드는가, 무엇을 만들고 무엇을 안 만드는가 |
| [docs/FEATURES.md](docs/FEATURES.md) | 기능 목록 (초안, 우선순위 포함) |
| [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md) | 아직 결정하지 않은 것 |
| [docs/decisions/](docs/decisions/) | 결정 기록 (ADR) |
| [docs/prior-art.md](docs/prior-art.md) | 검토한 기존 도구와 차이점 |
| [docs/experiments.md](docs/experiments.md) | 핵심 가정 검증 실험 기록 (실험 코드는 git 제외) |

## 이 레포의 작업 방식

이 레포 자체도 3세션 워크플로우로 개발한다 (dogfooding).
역할 정의는 `.claude/roles/`, 플랜 폴더는 `.claude/plans/<YYMMDD>-<slug>/` (plan-vN.md / plan-vN-verify.md, git 제외).

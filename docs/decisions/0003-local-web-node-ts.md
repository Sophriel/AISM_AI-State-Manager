# 0003. 로컬 웹 UI + Node/TS

- 상태: 확정
- 날짜: 2026-11-11

## 결정

- 서버: Node.js + TypeScript (Fastify). 훅 수신(HTTP), 파일 감시, `wt.exe` 실행, 상태 머신을 한 프로세스에서.
- 실시간 갱신: SSE.
- UI: React + Vite. `msedge --app=http://localhost:<port>`로 앱처럼 실행.
- 훅 스크립트도 Node (`"command":"node","args":[...]` exec form — Windows 셸 의존 제거, Q-13).

## 이유

- Node는 Claude Code 때문에 이미 설치돼 있다.
- 서버·훅·UI가 한 언어.
- 데스크톱 앱 개발 경험 불필요. 필요해지면 같은 UI를 Tauri/Electron으로 감쌀 수 있다.

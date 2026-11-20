# 0021. 서버와 UI를 분리한다 — 서버는 하나, UI 창은 여러 개

- 상태: 확정
- 날짜: 2026-11-18
- 출처: 261118-parallel-tasks plan-v2 (§3 A)

## 맥락

`scripts\start_aism.bat`이 서버를 실행하고 UI 창 하나를 함께 띄웠기 때문에, 두 번째 창을 열려면 서버를 다시 시작하거나 `AISM_NO_UI=1`로 창을 억제한 뒤 수동으로 열어야 했다. 사용자 요청(D1, D12): 서버 실행 스크립트와 UI 실행 스크립트를 분리 — 서버는 따로 띄워 두고, UI는 원하는 만큼 띄워 서버에 연결한다.

## 결정

- **두 스크립트**(D12): `scripts\start_server.bat`(서버 하나, `npm start`)과 `scripts\open_ui.bat`(`node server\dist\open-ui.js`). `start_aism.bat`·`write-start-bat.cjs`는 삭제하고 두 bat을 만드는 `scripts\write-launch-bats.cjs`로 대체.
- **서버는 창을 띄우지 않는다**: `index.ts`의 `openUi` 호출을 삭제하고, `ui.ts`의 `AISM_NO_UI`·`opts.env` 검사도 삭제(서버가 창을 띄우지 않으므로 의미 없음).
- **open-ui 진입점**(`server/src/open-ui.ts`): 설정을 읽고 `GET http://127.0.0.1:<port>/api/health`(2초 타임아웃)로 서버가 켜져 있는지 확인한다. 켜져 있으면 Edge 앱 창을 연다(설정 `window`의 크기, 없으면 1000×900). 꺼져 있으면 서버를 띄우지 않고 안내만(`AISM 서버가 켜져 있지 않습니다 — scripts\start_server.bat으로 먼저 서버를 띄우세요`)하고 종료 코드 1.
- **포트 사용 중**: 서버 `listen`이 `EADDRINUSE`로 실패하면 `포트 <port>가 사용 중입니다 — 이미 AISM 서버가 켜져 있으면 UI는 scripts\open_ui.bat으로 여세요.`를 출력하고 종료.

## 결과

- 서버 하나에 UI 창 여러 개 — 각 창은 같은 서버에 SSE로 연결된다.
- `open_ui`는 서버를 시작하지 않는다 — 꺼져 있으면 안내만.
- 개발(`npm run dev`)에서는 서버가 창을 띄우지 않으므로 Vite 주소를 직접 연다.

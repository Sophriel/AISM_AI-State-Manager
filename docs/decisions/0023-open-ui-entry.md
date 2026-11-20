# 0023. open_ui 진입점은 별도 파일, CLI는 Edge 실행 명령을 기다린다

- 상태: 확정
- 날짜: 2026-11-19
- 출처: 261119-open-ui-fix-run plan-v3 (§3 A·B)

## 맥락

`scripts\open_ui.bat`이 `node server\dist\open-ui.js`를 실행해도 UI 창이 뜨지 않았다. `open-ui.ts` 끝의 직접 실행 판정(`import.meta.url === pathToFileURL(process.argv[1]).href`)이 Windows에서 거짓이 되어 `runOpenUi`가 호출되지 않고 종료 코드 0으로 조용히 끝났기 때문이다 (261118-parallel-tasks todo-v1-notes N1 — 사용자 확인: 같은 모듈을 `import()`해 `defaultFetchHealth`·`openUi`를 직접 부르면 창이 뜸). 또한 CLI가 Edge를 띄우는 `cmd.exe`가 끝날 때까지 기다리지 않아, 배치 콘솔이 닫히면 그 프로세스가 같이 꺼질 위험이 있었다.

## 결정

- **진입 파일 분리**(§3 A): `open-ui.ts`는 함수만(`OpenUiDeps`·`defaultFetchHealth`·`runOpenUi`)이고 직접 실행 블록을 없앤다. 새 `open-ui-main.ts`가 조건 없이 `runOpenUi`를 실행하며, `open_ui.bat`은 `node server\dist\open-ui-main.js`를 실행한다.
- **Edge 실행 대기**(§3 B): `openUi`가 spawn한 child(`Child | null`)를 반환하고, 새 `waitForExit(child, timeoutMs = 5000)`이 child 종료(exit·error) 또는 타임아웃까지 기다린다. `runOpenUi`는 `openUi`가 null이면 안내("UI 창을 띄우지 못했습니다 — Edge(msedge)가 설치되어 있는지 확인하세요")·종료 코드 1, 아니면 `waitForExit` 후 0.

## 결과

- ADR 0021의 진입점 이름(`server/src/open-ui.ts` / `node server\dist\open-ui.js`)은 `open-ui-main.js`로 대체된다(0021 본문은 기록 문서로 유지).
- Edge가 없으면 `cmd /c start`가 Windows 오류 대화상자를 띄우고 cmd는 끝남 → `waitForExit`은 resolve, 종료 0(오류 대화상자로 사용자에게 보임). spawn 자체 실패(cmd.exe 없음)는 null → 1·pause.

## 검토한 대안

- **경로 비교 정규화**(`fileURLToPath` + 대소문자 무시): Windows 표기 차이(드라이브 문자, 구분자, 8.3 이름, 심볼릭 링크)를 모두 맞춰야 함 → 진입 파일 분리.
- **`spawn`에 `detached: true`**: 새 콘솔로 분리돼 콘솔 종료 영향은 없지만 E-005처럼 detached가 다른 동작을 바꿀 수 있음 → 기다리기가 더 단순하고 확인이 쉬움.

# 0014. Windows 토스트는 PowerShell WinRT로, 사용자 할 일만

- 상태: 확정
- 날짜: 2026-11-14
- 출처: m2-coder-loop plan-v2 (§3 F)

## 맥락

브라우저 알림은 UI 탭이 열려 있고 알림 권한이 허용된 때에만 들린다. 사용자가 다른 창으로 떠 있는 동안 "사용자가 할 일" 알림(결정 필요, 게이트, BLOCKED, 구현 완료)을 놓치기 쉽다(G-5). Windows 토스트는 브라우저와 무관하게 띄울 수 있다.

## 결정

- **대상 (D3)**: `level === "warn"` 이거나 키가 `undeliverable-` 또는 `done-`으로 시작하는 알림만 토스트로. (warn = 결정 필요, 게이트, todo 게이트, BLOCKED, verify 없음, 연속 block 상한, 예상 못 한 상태, 세션 전환, bind 모호) 브라우저 알림은 지금처럼 전부 유지한다.
- **방식 (D4)**: `scripts/toast.ps1`(ASCII만) — 인자 `-B64 <base64(UTF-8 JSON {title, message})>`를 디코드해 WinRT `Windows.UI.Notifications.ToastNotificationManager`로 `ToastText02` 템플릿 토스트를 띄운다. AppId는 Windows PowerShell의 `{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`.
- **서버**: `server/src/toast.ts` `showToast(title, message)` — `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File <AISM_ROOT>/scripts/toast.ps1 -B64 <…>`를 `detached`, `stdio: "ignore"`로 띄운다. spawn 오류는 `console.warn` 1회(서버 프로세스당) 후 무시.
- **설정**: 최상위 선택 키 `toast?: boolean`(기본 true, `false`면 호출 안 함). 엄격 검증은 `OPTIONAL_TOP_KEYS = ["toast"]`로 — 닫힌 객체 검사에만 포함, 필수 키 검사는 기존 `TOP_KEYS`만. 예시 설정에 `"toast": true`.
- 제목은 "AISM" 고정(메시지에 버전이 있음), 작업 폴더를 붙이지 않는다. 클릭 동작 없음(M3).

## 결과

- Windows가 아니거나 PowerShell이 없으면 spawn 오류 → 경고 1회 후 브라우저 알림만. 서버는 계속 동작한다.
- 집중 지원(방해 금지) 중이면 Windows가 토스트를 숨긴다 — 동작은 정상, 표시만 안 됨.
- **E-005 확인 항목** (구현 후 체크리스트): 사용자 PC(Windows PowerShell 5.1)에서 `toast.ps1`이 한국어 메시지 토스트를 띄우는지. 안 되면 `toast: false`로 끄고 다음 plan에서 대안(node-notifier). 결과는 `docs/experiments.md`에 기록.

## 검토한 대안

- **node-notifier**: 의존성 추가 → PowerShell WinRT(D4, 추가 설치 없음)로 기각.
- **모든 알림을 토스트로**: info 알림까지 뜨면 방해가 됨 → 사용자 할 일만(D3)으로 기각.

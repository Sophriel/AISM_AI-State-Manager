# 0018. 프로젝트는 UI에서 로컬 폴더로 등록, 설정 파일에 저장하기 전에 검증

- 상태: 확정
- 날짜: 2026-11-17
- 출처: m3-commit-projects plan-v2 (§3 D)

## 맥락

프로젝트(대상 레포·폴더)는 설정 파일 `projects`를 직접 편집해서만 등록할 수 있었다 — JSON을 다루지 않는 사용자는 편집 후 서버 재시작까지 해야 반영됐다. 사용자 요청(D4): "다른 레포·폴더를 작업 공간으로 추가" = UI에서 **프로젝트 등록**. git 연동은 로컬 git 레포만(D5).

## 결정

- **API**: `POST /api/projects` 본문 `{ name, root, plansDir?, protectedPaths?, roleOverlay? }`. 검증: `name`은 비어 있지 않은 문자열이고 이미 있는 이름이 아니면 안 됨(409), `root`는 존재하는 폴더(400 `root not found`), `plansDir` 기본 `.claude/plans`, `protectedPaths` 기본 `[]`(문자열 배열), `roleOverlay`는 문자열 또는 생략.
- **저장**: `config.ts`의 `updateConfigFile(configPath, mutate)` — 읽기 → `JSON.parse` → `mutate` → 직렬화(2칸 들여쓰기·원본 줄바꿈) → 임시 파일 → **임시 파일을 `loadConfig`로 검증**(실패하면 임시 파일 삭제, false, 원본은 그대로) → rename. `saveWindowSize`도 이 함수를 사용한다(동작은 그대로).
- **성공 후**: 메모리 `config.projects[name]`에 추가, 프로젝트 정보 캐시 갱신, `broadcastState()`, 200 `{ ok: true }`. 저장 실패는 500 `{ error: "save failed" }`(경고 로그).
- **git 정보는 로컬 브랜치만**(D5): `projects.ts`의 `gitInfo(root)` — `.git`(폴더 또는 파일)이 없으면 null, 있으면 `git -C <root> rev-parse --abbrev-ref HEAD`(타임아웃 3초, 실패하면 `{ branch: null }`)의 현재 브랜치. clone·원격은 다루지 않는다. Orchestrator가 프로젝트별 `{ root, git }`를 캐시(서버 시작·프로젝트 추가·`newTask`·`closeTask` 시 갱신), `getState().projectInfo`로 노출.
- **활성 작업 중에도 등록 가능**: "프로젝트 추가" 버튼은 `busy`일 때만 비활성. 추가 성공 후 새 프로젝트를 select에서 선택하는 것은 활성 작업이 없을 때만.

## 결과

- 설정 파일 서식 정리: `updateConfigFile`이 2칸 들여쓰기·원본 줄바꿈으로 파일을 다시 쓰므로, 직접 편집한 파일은 다음 저장 시 서식이 정리된다.
- 서버 실행 중 설정 파일을 직접 고친 뒤 UI로 프로젝트를 추가하면: 파일의 현재 내용 위에 추가되지만, 메모리 설정에는 직접 고친 내용이 반영되지 않는다(재시작 필요) — README에 한 줄.
- 같은 설정 파일에 대한 동시 쓰기(프로젝트 추가 + 창 크기 저장): 둘 다 읽기-수정-교체이지만 동기 함수로만 쓰므로 Node 단일 스레드에서 겹치지 않는다.

## 검토한 대안

- **검증 없이 저장**: 엄격 검증에 걸리면 다음 서버 시작이 거부됨 → 임시 파일을 `loadConfig`로 검증 후 교체.
- **원격 clone**: D5로 제외(로컬 git 레포만).
- **작업별 추가 폴더(`--add-dir`)**: D4로 제외(프로젝트 등록으로 결정).

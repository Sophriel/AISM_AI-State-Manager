# Prior Art

검토한 도구와 이 프로젝트와의 차이. (2026-11 기준)

| 도구 | 성격 | 맞지 않는 점 | 참고할 점 |
|---|---|---|---|
| Herdr | 에이전트 상태 인식 터미널 멀티플렉서 (Windows GA) | 워크플로우 로직 없음, 상태 감지는 휴리스틱 | CLI/소켓으로 패널 제어하는 구조 |
| Hermes Agent | 자기 개선형 범용 자율 에이전트 | Claude Code를 대체하는 별도 하네스, LLM이 위임 판단 | — |
| orc | 결정적 상태 머신 + 파일 산출물 + 사람 게이트 | 헤드리스(`claude -p`) 전용, Windows 지원 불명확 | 철학이 가장 가까움. phase 종류(agent/gate/branch), 산출물 검증, `--from` 재개 |
| oh-my-braincrew | Claude Code 플러그인 (22 에이전트, 16 훅) | 무거움, 로컬 모델 컨텍스트 부담 | 계획 작성자 자기 승인 금지, 리뷰 체크포인트 |
| Routa | 칸반 레인별 전문 에이전트, Tauri 데스크톱 | 되돌림 루프·역할별 프롬프트 주입 불명확 | Models + Role Defaults로 역할별 엔드포인트 |
| Vibe Kanban | 칸반 + 작업별 git worktree | 카드 수동 이동, worktree가 UE 프로젝트에 부담 | diff 리뷰 UI |
| Paperclip | 에이전트 "회사" 컨트롤 플레인 | 자율 운영 지향, PostgreSQL 운영 부담 | — |
| BatonBot | 프롬프트 시퀀스 칸반 (Windows 포터블) | Claude Code 미지원, 일직선 대기열, 개발 일시 중단 | Windows 자식 프로세스 stdin 처리, 포터블 번들 |

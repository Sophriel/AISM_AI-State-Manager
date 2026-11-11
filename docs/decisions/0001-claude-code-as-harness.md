# 0001. 하네스는 Claude Code를 그대로 쓴다

- 상태: 확정
- 날짜: 2026-11-11

## 맥락

에이전트 실행(도구 호출, 권한, 컨텍스트 압축)을 직접 구현하거나 다른 하네스(Hermes, Aider, Cline 등)를 쓸 수도 있다.
하지만 로컬 Qwen + llama-server 스택은 Claude Code 기준으로 튜닝돼 있다 (채팅 템플릿, tool-call 안정성, autocompact 임계값).

## 결정

각 역할 세션은 Claude Code CLI로 실행한다. 이 도구는 Claude Code를 **띄우고, 설정을 주입하고, 끝난 것을 감지**하는 일만 한다.

## 결과

- 에이전트 기능 구현 비용이 없다.
- 역할 주입은 CLI 플래그(`--append-system-prompt-file`, `--settings`, `--disallowedTools`)와 환경변수(`ANTHROPIC_BASE_URL`)에 의존한다.
- Claude Code CLI의 플래그·훅 형식 변경에 영향받는다 → 버전 고정과 호환 체크가 필요하다.

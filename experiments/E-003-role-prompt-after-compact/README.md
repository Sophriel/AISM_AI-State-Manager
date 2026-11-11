# E-003. 역할 프롬프트는 컨텍스트 압축 후에도 유지되는가

FEATURES R-2의 전제: `--append-system-prompt-file`로 넣은 역할은 autocompact/`/compact` 후에도 사라지지 않는다.

## 방법

`run.sh` — 역할(코드네임 `ZEBRA-7` 포함)을 주입한 세션을 만들고, `/compact`를 실행한 뒤, 역할을 묻는다.
압축이 실제로 일어났는지는 transcript(`~/.claude/projects/*/<session-id>.jsonl`)의 `"subtype":"compact_boundary"`로 확인한다.

## 결과 — 2026-11-11, Linux 헤드리스, Claude Code 2.1.322

| 단계 | 결과 |
|---|---|
| 압축 발생 | ✅ transcript에 `compact_boundary` 1개, `isCompactSummary: true` 1개 |
| 압축 후 역할 질문 (플래그 재전달) | ✅ `역할: VERIFY / 코드네임: ZEBRA-7` |
| 압축 후 역할 질문 (`--resume`에 플래그 없음) | ✅ 같은 답 — 단, 압축 요약에 역할이 섞여 들어간 것으로 보이며 보장되지 않음 |

## 결론

- 대화형 세션(AISM의 기본)은 프로세스가 사는 동안 시스템 프롬프트가 고정이므로 압축과 무관하게 역할이 유지된다.
- `--resume`으로 이어 붙일 때(S-9, M2)는 **플래그를 반드시 다시 넘긴다.** 요약에 의존하지 않는다.
- 미확인: Windows 대화형 autocompact(자동 압축)에서의 동일 동작. 원리상 같으나 필요 시 재현.

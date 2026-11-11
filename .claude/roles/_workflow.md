# WORKFLOW CONTRACT (shared by all sessions)

This project uses three separate Claude Code sessions. You are exactly ONE of them (see ROLE section below).
Never perform another session's job. If the work requires another role, stop and tell the user which session to run next.

    PLAN  --plan-vN.md-->  VERIFY  --plan-vN-verify.md-->  PLAN --plan-v(N+1).md--> ...   (until verdict = PASS)
    PLAN  --todo.md-->  CODE

Language: talk to the user in Korean. Write documents in Korean. Keep identifiers, file paths and code in original form.

## Plan folder

Plans root for this project: `.claude/plans/` (git-ignored — plans are working files, not committed).
Every task gets its own folder: `.claude/plans/<YYMMDD>-<slug>/` (date the task started + short kebab-case name, e.g. `261111-weapon-system-refactor`).
PLAN creates the folder when a new task starts.

| File                  | Owner  | Others may            | Notes |
|-----------------------|--------|-----------------------|-------|
| plan-v1.md, plan-v2.md, ... | PLAN | read | one file per revision; never edit an older version |
| plan-vN-verify.md     | VERIFY | read                  | review of plan-vN.md |
| todo.md               | PLAN   | CODE: tick boxes only | written after PASS |
| code-log.md           | CODE   | read                  | |

Never edit a file you do not own (except: CODE ticking todo.md boxes and setting the Status line).
"Latest plan" = plan-vN.md with the highest N.

## Status line

The first line of every plan-vN.md is:

    Status: <DRAFT | NEEDS_DECISION | IN_REVIEW | APPROVED | TODO_READY | IN_PROGRESS | BLOCKED | DONE>

Only the latest plan's Status line is meaningful.
- PLAN sets DRAFT -> NEEDS_DECISION / IN_REVIEW, APPROVED, TODO_READY.
- CODE may set IN_PROGRESS, BLOCKED, DONE (only this line; nothing else in the plan).

## Verdict line

The last line of every plan-vN-verify.md is exactly one of:

    판정: PASS
    판정: REVISE

## Whose turn is it (the orchestrator decides the same way)

| Latest state | Next |
|---|---|
| plan-vN.md Status NEEDS_DECISION | user (discuss in the PLAN session) |
| plan-vN.md Status IN_REVIEW, no plan-vN-verify.md | VERIFY |
| plan-vN-verify.md 판정: REVISE | PLAN writes plan-v(N+1).md |
| plan-vN-verify.md 판정: PASS | PLAN sets APPROVED, writes todo.md, sets TODO_READY |
| Status TODO_READY / IN_PROGRESS | CODE |
| Status BLOCKED | PLAN (read code-log.md) |

## Human decisions

If something must be decided by the user (product intent, trade-off with no clear winner, scope), do NOT decide it yourself:
1. Add it under `## 결정 필요` in the latest plan as `D<n>: <question> — 선택지: A / B — 추천: <one, with one-line reason>`.
2. Set Status: NEEDS_DECISION and end your turn.
The orchestrator notifies the user, who will discuss it with you in this same session. After the user decides, move the item to `## 결정 기록` in the same file, set Status: IN_REVIEW and end your turn.

## Session start (all roles)

1. If the user did not name the task, list `.claude/plans/` and ask which one. Do not guess.
2. Find the latest plan and verify files and read only what your role needs. Do not re-explore the whole codebase.
3. In 3-5 lines, tell the user: task folder, latest plan version, Status, what you are going to do now.

## Session end (all roles)

Finish with exactly:

    ▶ 다음 세션: <PLAN | VERIFY | CODE | 사용자>
    ▶ 이유: <one line>

## Finding / issue IDs

- Review findings: `R<N>-<k>` where N = the plan version reviewed (e.g. R2-3 = 3rd finding on plan-v2.md). Severity: Blocker / Major / Minor / Question.
- Decisions: `D<n>`. TODO items: `T<n>`.
Always refer to these IDs instead of re-describing the issue.

# ROLE: CODE

You apply todo.md to the code. You do NOT make design decisions and you do NOT edit any plan file (except the latest plan's Status line) or verify file.

## Precondition
The latest plan's Status must be TODO_READY or IN_PROGRESS. Otherwise stop and tell the user to run PLAN.

## Phase 1 — Preflight (no edits yet)
For every unchecked todo item:
- Confirm the target file and symbol exist exactly as described (or that the new symbol does not exist yet).
- Confirm the 상세 is specific enough to write the code with no choice left to you.
- Confirm 선행 order is satisfiable.
Write the result to code-log.md:

    ## Preflight <date>
    - T<n>: OK | AMBIGUOUS: <what is unclear> | MISMATCH: <plan says X, code is Y (path:line)>

If ANY item is AMBIGUOUS or MISMATCH: set Status: BLOCKED, stop, and route to PLAN. Do not guess. Do not "fix" the plan yourself.

## Phase 2 — Apply
Set Status: IN_PROGRESS. Then, in todo order, one item at a time:
1. Make exactly the change described. Nothing outside the item's scope — no drive-by refactors, renames or formatting changes.
2. Tick the box in todo.md.
3. Append to code-log.md: `- T<n>: done — <touched paths>`.
If something unexpected appears mid-way (compile error caused by the plan, a hidden caller, etc.): log it under `## Blocked at T<n>`, set Status: BLOCKED, stop.
If you notice an unrelated problem: log it under `## Out of scope` and continue.

## Rules
- Do not commit or stage. The user stages manually (hunk-level).
- Keep code-log.md current after each item so a new session can resume from it.
- When all items are ticked: set Status: DONE and summarize touched files.

// T6 — 상태 머신 테스트. 판정표 행 0~11 + 알림 중복 방지.
import { describe, it, expect } from "vitest";
import {
  evaluate,
  instructionVerifyPlan,
  instructionPlanRevise,
  instructionVerdictLine,
  instructionApproveAndTodo,
  instructionFinishTodo,
  instructionReviewTodo,
  instructionTodoRevise,
  instructionTodoVerdictLine,
  instructionImplement,
  instructionBlocked,
  instructionChecklist,
  type MachineInput,
  type Action,
} from "./machine.js";

function input(overrides: Partial<MachineInput> = {}): MachineInput {
  return {
    sender: { sessionKey: "planner-1", role: "planner", bound: true },
    taskActive: true,
    snapshot: { latestN: 3, status: "IN_REVIEW", verifyExists: false, verdict: null },
    todo: { latestN: null, verifyExists: false, verdict: null, checklistExists: false },
    newPlanFolders: [],
    peers: {},
    record: { notified: [], consecutiveBlocks: {}, instructed: [] },
    config: { confirmFromVersion: 5, maxConsecutiveBlocks: 3 },
    ...overrides,
  };
}

const replies = (actions: Action[]) => actions.filter((a) => a.kind === "reply") as Extract<
  Action,
  { kind: "reply" }
>[];
const notifies = (actions: Action[]) => actions.filter((a) => a.kind === "notify") as Extract<
  Action,
  { kind: "notify" }
>[];
const records = (actions: Action[]) => actions.filter((a) => a.kind === "record") as Extract<
  Action,
  { kind: "record" }
>[];
const allowTo = (actions: Action[], key: string) =>
  replies(actions).some((r) => r.sessionKey === key && r.reply.action === "allow");
const blockTo = (actions: Action[], key: string) =>
  replies(actions).find((r) => r.sessionKey === key && r.reply.action === "block");

describe("행 0 — 비활성 작업", () => {
  it("평가 없이 allow, 알림 없음", () => {
    const actions = evaluate(
      input({ taskActive: false, snapshot: { latestN: null, status: null, verifyExists: false, verdict: null } }),
    );
    expect(actions).toEqual([{ kind: "reply", sessionKey: "planner-1", reply: { action: "allow" } }]);
  });
});

describe("행 1 — PLANNER unbound", () => {
  it("새 plan 폴더 0개 → allow", () => {
    const actions = evaluate(input({ sender: { sessionKey: "planner-1", role: "planner", bound: false } }));
    expect(actions).toEqual([{ kind: "reply", sessionKey: "planner-1", reply: { action: "allow" } }]);
  });

  it("새 plan 폴더 2개(≥2) → allow + notify(warn, bind-ambiguous)", () => {
    const actions = evaluate(
      input({
        sender: { sessionKey: "planner-1", role: "planner", bound: false },
        newPlanFolders: ["261111-alpha", "261111-beta"],
      }),
    );
    expect(allowTo(actions, "planner-1")).toBe(true);
    const n = notifies(actions);
    expect(n).toHaveLength(1);
    expect(n[0].key).toBe("bind-ambiguous");
    expect(n[0].level).toBe("warn");
  });
});

describe("행 2 — NEEDS_DECISION", () => {
  it("allow + notify(decision-v3)", () => {
    const actions = evaluate(
      input({ snapshot: { latestN: 3, status: "NEEDS_DECISION", verifyExists: false, verdict: null } }),
    );
    expect(allowTo(actions, "planner-1")).toBe(true);
    const n = notifies(actions);
    expect(n.map((x) => x.key)).toEqual(["decision-v3"]);
  });
});

describe("행 3 — IN_REVIEW, verify 없음 (peer 4가지)", () => {
  it("peer parked → hold + peer에 block(지시 문장)", () => {
    const actions = evaluate(
      input({
        snapshot: { latestN: 3, status: "IN_REVIEW", verifyExists: false, verdict: null },
        peers: { verifier: { sessionKey: "verifier-1", state: "parked" } },
      }),
    );
    expect(actions.some((a) => a.kind === "hold" && a.sessionKey === "planner-1")).toBe(true);
    const b = blockTo(actions, "verifier-1");
    expect(b?.reply).toEqual({ action: "block", reason: instructionVerifyPlan(3) });
    expect(allowTo(actions, "planner-1")).toBe(false);
  });

  it("peer working → hold만 (지시 전달 없음)", () => {
    const actions = evaluate(
      input({
        snapshot: { latestN: 3, status: "IN_REVIEW", verifyExists: false, verdict: null },
        peers: { verifier: { sessionKey: "verifier-1", state: "working" } },
      }),
    );
    expect(actions).toEqual([{ kind: "hold", sessionKey: "planner-1" }]);
  });

  it("peer idle → hold + undeliverable (notify 없음)", () => {
    const actions = evaluate(
      input({
        snapshot: { latestN: 3, status: "IN_REVIEW", verifyExists: false, verdict: null },
        peers: { verifier: { sessionKey: "verifier-1", state: "idle" } },
      }),
    );
    expect(actions.some((a) => a.kind === "hold" && a.sessionKey === "planner-1")).toBe(true);
    const u = actions.find((a) => a.kind === "undeliverable");
    expect(u).toEqual({ kind: "undeliverable", role: "verifier", text: instructionVerifyPlan(3) });
    expect(notifies(actions)).toHaveLength(0);
  });

  it("peer detached → hold + undeliverable, launch 없음 (verifier)", () => {
    const actions = evaluate(
      input({
        snapshot: { latestN: 3, status: "IN_REVIEW", verifyExists: false, verdict: null },
        peers: { verifier: { sessionKey: "verifier-1", state: "detached" } },
      }),
    );
    expect(actions.some((a) => a.kind === "hold" && a.sessionKey === "planner-1")).toBe(true);
    const u = actions.find((a) => a.kind === "undeliverable");
    expect(u).toEqual({ kind: "undeliverable", role: "verifier", text: instructionVerifyPlan(3) });
    expect(actions.some((a) => a.kind === "launch")).toBe(false);
  });

  it("peer 없음 → hold + launch(verifier, instructionVerifyPlan(3))", () => {
    const actions = evaluate(
      input({ snapshot: { latestN: 3, status: "IN_REVIEW", verifyExists: false, verdict: null } }),
    );
    expect(actions.some((a) => a.kind === "hold" && a.sessionKey === "planner-1")).toBe(true);
    expect(actions).toContainEqual({ kind: "launch", role: "verifier", instruction: instructionVerifyPlan(3) });
  });
});

describe("행 4 — IN_REVIEW, verify 있음", () => {
  it("allow만 (알림 없음)", () => {
    const actions = evaluate(
      input({ snapshot: { latestN: 3, status: "IN_REVIEW", verifyExists: true, verdict: "REVISE" } }),
    );
    expect(actions).toEqual([{ kind: "reply", sessionKey: "planner-1", reply: { action: "allow" } }]);
  });
});

describe("행 4a — DRAFT / Status 없음", () => {
  it("DRAFT → allow, 알림 없음", () => {
    const actions = evaluate(input({ snapshot: { latestN: 3, status: "DRAFT", verifyExists: false, verdict: null } }));
    expect(actions).toEqual([{ kind: "reply", sessionKey: "planner-1", reply: { action: "allow" } }]);
  });

  it("MISSING → allow, 알림 없음", () => {
    const actions = evaluate(input({ snapshot: { latestN: 3, status: "MISSING", verifyExists: false, verdict: null } }));
    expect(actions).toEqual([{ kind: "reply", sessionKey: "planner-1", reply: { action: "allow" } }]);
  });
});

describe("행 4p — IN_REVIEW + PASS (W5)", () => {
  it("미기록 → block(instructionApproveAndTodo) + instructed에 기록", () => {
    const actions = evaluate(
      input({ snapshot: { latestN: 3, status: "IN_REVIEW", verifyExists: true, verdict: "PASS" } }),
    );
    const b = blockTo(actions, "planner-1");
    expect(b?.reply).toEqual({ action: "block", reason: instructionApproveAndTodo(3) });
    const rec = records(actions)[0];
    expect(rec.instructed).toContain("todo-v3");
  });

  it("기록됨 → allow", () => {
    const actions = evaluate(
      input({
        snapshot: { latestN: 3, status: "IN_REVIEW", verifyExists: true, verdict: "PASS" },
        record: { notified: [], consecutiveBlocks: {}, instructed: ["todo-v3"] },
      }),
    );
    expect(actions).toEqual([{ kind: "reply", sessionKey: "planner-1", reply: { action: "allow" } }]);
  });

  it("미기록이지만 consecutiveBlocks[planner-1] === maxConsecutiveBlocks → allow + notify(blocks-planner-1), 미기록", () => {
    const actions = evaluate(
      input({
        snapshot: { latestN: 3, status: "IN_REVIEW", verifyExists: true, verdict: "PASS" },
        record: { notified: [], consecutiveBlocks: { "planner-1": 3 }, instructed: [] },
      }),
    );
    expect(allowTo(actions, "planner-1")).toBe(true);
    expect(notifies(actions).map((x) => x.key)).toContain("blocks-planner-1");
    const rec = records(actions)[0];
    expect(rec.instructed ?? []).not.toContain("todo-v3");
  });
});

describe("행 5 — APPROVED / TODO_READY / 그 이후 (W5)", () => {
  it("5a. APPROVED → block(instructionFinishTodo)", () => {
    const actions = evaluate(
      input({ snapshot: { latestN: 3, status: "APPROVED", verifyExists: true, verdict: "PASS" } }),
    );
    const b = blockTo(actions, "planner-1");
    expect(b?.reply).toEqual({ action: "block", reason: instructionFinishTodo(3) });
  });

  it("5t(a). TODO_READY, todo 없음 → allow + notify(notodo-v3, warn)", () => {
    const actions = evaluate(
      input({ snapshot: { latestN: 3, status: "TODO_READY", verifyExists: true, verdict: "PASS" } }),
    );
    expect(allowTo(actions, "planner-1")).toBe(true);
    const n = notifies(actions);
    expect(n.map((x) => [x.key, x.level])).toEqual([["notodo-v3", "warn"]]);
  });

  it("5t(b). TODO_READY, todo T=1·verify 없음, peers 없음 → hold(planner-1) + launch(coder, instructionReviewTodo(1))", () => {
    const actions = evaluate(
      input({
        snapshot: { latestN: 3, status: "TODO_READY", verifyExists: true, verdict: "PASS" },
        todo: { latestN: 1, verifyExists: false, verdict: null, checklistExists: false },
      }),
    );
    expect(actions.some((a) => a.kind === "hold" && a.sessionKey === "planner-1")).toBe(true);
    expect(actions).toContainEqual({ kind: "launch", role: "coder", instruction: instructionReviewTodo(1) });
  });

  it("5t(b'). 같은 조건 peers.coder parked → coder에 block(instructionReviewTodo(1))", () => {
    const actions = evaluate(
      input({
        snapshot: { latestN: 3, status: "TODO_READY", verifyExists: true, verdict: "PASS" },
        todo: { latestN: 1, verifyExists: false, verdict: null, checklistExists: false },
        peers: { coder: { sessionKey: "coder-1", state: "parked" } },
      }),
    );
    expect(actions.some((a) => a.kind === "hold" && a.sessionKey === "planner-1")).toBe(true);
    const b = blockTo(actions, "coder-1");
    expect(b?.reply).toEqual({ action: "block", reason: instructionReviewTodo(1) });
  });

  it("5t(c). TODO_READY, verify PASS → allow, 알림 없음", () => {
    const actions = evaluate(
      input({
        snapshot: { latestN: 3, status: "TODO_READY", verifyExists: true, verdict: "PASS" },
        todo: { latestN: 1, verifyExists: true, verdict: "PASS", checklistExists: false },
      }),
    );
    expect(actions).toEqual([{ kind: "reply", sessionKey: "planner-1", reply: { action: "allow" } }]);
  });

  it("5c. IN_PROGRESS / BLOCKED / DONE(T null) → allow, 알림 없음", () => {
    for (const status of ["IN_PROGRESS", "BLOCKED", "DONE"] as const) {
      const actions = evaluate(
        input({ snapshot: { latestN: 3, status, verifyExists: true, verdict: "PASS" } }),
      );
      expect(actions).toEqual([{ kind: "reply", sessionKey: "planner-1", reply: { action: "allow" } }]);
    }
  });

  it("5d. DONE, T=1, checklist 있음 → allow + checklist-v1 info", () => {
    const actions = evaluate(
      input({
        snapshot: { latestN: 3, status: "DONE", verifyExists: true, verdict: "PASS" },
        todo: { latestN: 1, verifyExists: true, verdict: "PASS", checklistExists: true },
      }),
    );
    expect(allowTo(actions, "planner-1")).toBe(true);
    const n = notifies(actions);
    expect(n.map((x) => [x.key, x.level])).toEqual([["checklist-v1", "info"]]);
  });

  it("5d. DONE, T=1, checklist 없음 → allow만 (알림 없음)", () => {
    const actions = evaluate(
      input({
        snapshot: { latestN: 3, status: "DONE", verifyExists: true, verdict: "PASS" },
        todo: { latestN: 1, verifyExists: true, verdict: "PASS", checklistExists: false },
      }),
    );
    expect(actions).toEqual([{ kind: "reply", sessionKey: "planner-1", reply: { action: "allow" } }]);
  });
});

describe("행 6 — VERIFIER REVISE, N < confirmFromVersion", () => {
  it("peer parked → hold + peer에 block(지시 문장)", () => {
    const actions = evaluate(
      input({
        sender: { sessionKey: "verifier-1", role: "verifier", bound: true },
        snapshot: { latestN: 3, status: "IN_PROGRESS", verifyExists: true, verdict: "REVISE" },
        peers: { planner: { sessionKey: "planner-1", state: "parked" } },
      }),
    );
    expect(actions.some((a) => a.kind === "hold" && a.sessionKey === "verifier-1")).toBe(true);
    const b = blockTo(actions, "planner-1");
    expect(b?.reply).toEqual({ action: "block", reason: instructionPlanRevise(3) });
  });

  it("peer 없음 → hold + launch(planner, instructionPlanRevise(3))", () => {
    const actions = evaluate(
      input({
        sender: { sessionKey: "verifier-1", role: "verifier", bound: true },
        snapshot: { latestN: 3, status: "IN_PROGRESS", verifyExists: true, verdict: "REVISE" },
      }),
    );
    expect(actions.some((a) => a.kind === "hold" && a.sessionKey === "verifier-1")).toBe(true);
    expect(actions).toContainEqual({ kind: "launch", role: "planner", instruction: instructionPlanRevise(3) });
  });

  it("peer detached → hold + undeliverable(planner), launch 없음", () => {
    const actions = evaluate(
      input({
        sender: { sessionKey: "verifier-1", role: "verifier", bound: true },
        snapshot: { latestN: 3, status: "IN_PROGRESS", verifyExists: true, verdict: "REVISE" },
        peers: { planner: { sessionKey: "planner-1", state: "detached" } },
      }),
    );
    expect(actions.some((a) => a.kind === "hold" && a.sessionKey === "verifier-1")).toBe(true);
    const u = actions.find((a) => a.kind === "undeliverable");
    expect(u).toEqual({ kind: "undeliverable", role: "planner", text: instructionPlanRevise(3) });
    expect(actions.some((a) => a.kind === "launch")).toBe(false);
  });
});

describe("행 7 — VERIFIER REVISE, N ≥ confirmFromVersion", () => {
  it("hold + notify(gate-v5), PLANNER 지시 없음", () => {
    const actions = evaluate(
      input({
        sender: { sessionKey: "verifier-1", role: "verifier", bound: true },
        snapshot: { latestN: 5, status: "IN_PROGRESS", verifyExists: true, verdict: "REVISE" },
        peers: { planner: { sessionKey: "planner-1", state: "parked" } },
      }),
    );
    expect(actions.some((a) => a.kind === "hold" && a.sessionKey === "verifier-1")).toBe(true);
    const n = notifies(actions);
    expect(n.map((x) => x.key)).toEqual(["gate-v5"]);
    expect(n[0].level).toBe("warn");
    // parked PLANNER에도 block을 보내지 않는다 (지시 없음).
    expect(blockTo(actions, "planner-1")).toBeUndefined();
  });
});

describe("행 8 — VERIFIER PASS (W5)", () => {
  it("PLANNER parked → PLANNER에 block(instructionApproveAndTodo) + record.instructed에 todo-v3", () => {
    const actions = evaluate(
      input({
        sender: { sessionKey: "verifier-1", role: "verifier", bound: true },
        snapshot: { latestN: 3, status: "IN_REVIEW", verifyExists: true, verdict: "PASS" },
        peers: { planner: { sessionKey: "planner-1", state: "parked" } },
      }),
    );
    expect(allowTo(actions, "verifier-1")).toBe(true);
    const b = blockTo(actions, "planner-1");
    expect(b?.reply).toEqual({ action: "block", reason: instructionApproveAndTodo(3) });
    expect(notifies(actions).map((x) => x.key)).toEqual(["pass-v3"]);
    const rec = records(actions)[0];
    expect(rec.instructed).toContain("todo-v3");
  });

  it("PLANNER working → PLANNER에 대한 Action 없음, instructed 미기록", () => {
    const actions = evaluate(
      input({
        sender: { sessionKey: "verifier-1", role: "verifier", bound: true },
        snapshot: { latestN: 3, status: "IN_REVIEW", verifyExists: true, verdict: "PASS" },
        peers: { planner: { sessionKey: "planner-1", state: "working" } },
      }),
    );
    expect(allowTo(actions, "verifier-1")).toBe(true);
    expect(replies(actions).some((r) => r.sessionKey === "planner-1")).toBe(false);
    const rec = records(actions)[0];
    expect(rec.instructed ?? []).not.toContain("todo-v3");
  });

  it("PLANNER idle → undeliverable, instructed 미기록", () => {
    const actions = evaluate(
      input({
        sender: { sessionKey: "verifier-1", role: "verifier", bound: true },
        snapshot: { latestN: 3, status: "IN_REVIEW", verifyExists: true, verdict: "PASS" },
        peers: { planner: { sessionKey: "planner-1", state: "idle" } },
      }),
    );
    expect(allowTo(actions, "verifier-1")).toBe(true);
    expect(actions).toContainEqual({ kind: "undeliverable", role: "planner", text: instructionApproveAndTodo(3) });
    const rec = records(actions)[0];
    expect(rec.instructed ?? []).not.toContain("todo-v3");
  });

  it("이미 instructed에 기록됨 → PLANNER에 대한 Action 없음", () => {
    const actions = evaluate(
      input({
        sender: { sessionKey: "verifier-1", role: "verifier", bound: true },
        snapshot: { latestN: 3, status: "IN_REVIEW", verifyExists: true, verdict: "PASS" },
        peers: { planner: { sessionKey: "planner-1", state: "parked" } },
        record: { notified: [], consecutiveBlocks: {}, instructed: ["todo-v3"] },
      }),
    );
    expect(allowTo(actions, "verifier-1")).toBe(true);
    expect(replies(actions).some((r) => r.sessionKey === "planner-1")).toBe(false);
  });
});

describe("행 9 — VERIFIER 판정 줄 형식 오류", () => {
  it("block(지시 문장) + 카운트 증가", () => {
    const actions = evaluate(
      input({
        sender: { sessionKey: "verifier-1", role: "verifier", bound: true },
        snapshot: { latestN: 3, status: "IN_PROGRESS", verifyExists: true, verdict: "MALFORMED" },
      }),
    );
    const b = blockTo(actions, "verifier-1");
    expect(b?.reply).toEqual({ action: "block", reason: instructionVerdictLine(3) });
    const rec = records(actions)[0];
    expect(rec.consecutiveBlocks?.["verifier-1"]).toBe(1);
  });

  it("연속 상한 초과 (카운트 3, max 3) → allow + notify(blocks-verifier-1) + 카운트 0", () => {
    const actions = evaluate(
      input({
        sender: { sessionKey: "verifier-1", role: "verifier", bound: true },
        snapshot: { latestN: 3, status: "IN_PROGRESS", verifyExists: true, verdict: "MALFORMED" },
        record: { notified: [], consecutiveBlocks: { "verifier-1": 3 }, instructed: [] },
      }),
    );
    expect(allowTo(actions, "verifier-1")).toBe(true);
    expect(blockTo(actions, "verifier-1")).toBeUndefined();
    const n = notifies(actions);
    expect(n.map((x) => [x.key, x.level])).toEqual([["blocks-verifier-1", "warn"]]);
    const rec = records(actions)[0];
    expect(rec.consecutiveBlocks?.["verifier-1"]).toBe(0);
  });
});

describe("N1 — hold가 연속 block 횟수 초기화", () => {
  it("행 3 hold(planner-1) → consecutiveBlocks[planner-1] 0으로 기록", () => {
    const actions = evaluate(
      input({
        snapshot: { latestN: 3, status: "IN_REVIEW", verifyExists: false, verdict: null },
        peers: { verifier: { sessionKey: "verifier-1", state: "parked" } },
        record: { notified: [], consecutiveBlocks: { "planner-1": 3 }, instructed: [] },
      }),
    );
    expect(actions.some((a) => a.kind === "hold" && a.sessionKey === "planner-1")).toBe(true);
    const rec = records(actions)[0];
    expect(rec.consecutiveBlocks?.["planner-1"]).toBe(0);
  });

  it("hold 사이에 block 왕복 — 4번째도 block, blocks- 알림 없음", () => {
    // 1) PLANNER Stop (행 3) → hold(planner-1) + verifier에 block.
    const a1 = evaluate(
      input({
        snapshot: { latestN: 3, status: "IN_REVIEW", verifyExists: false, verdict: null },
        peers: { verifier: { sessionKey: "verifier-1", state: "parked" } },
        record: { notified: [], consecutiveBlocks: { "planner-1": 3 }, instructed: [] },
      }),
    );
    const rec1 = records(a1)[0];
    // 2) VERIFIER Stop (행 6, N=1 < confirmFromVersion) → hold(verifier-1) + planner에 block.
    const a2 = evaluate(
      input({
        sender: { sessionKey: "verifier-1", role: "verifier", bound: true },
        snapshot: { latestN: 1, status: "IN_REVIEW", verifyExists: true, verdict: "REVISE" },
        peers: { planner: { sessionKey: "planner-1", state: "parked" } },
        record: {
          notified: rec1.notified,
          consecutiveBlocks: rec1.consecutiveBlocks,
          instructed: rec1.instructed,
        },
      }),
    );
    const b = blockTo(a2, "planner-1");
    expect(b?.reply).toEqual({ action: "block", reason: instructionPlanRevise(1) });
    expect(notifies(a2).some((n) => n.key.startsWith("blocks-"))).toBe(false);
  });
});

describe("행 10 — verify-vN 없음", () => {
  it("allow + notify(noverify-v3)", () => {
    const actions = evaluate(
      input({
        sender: { sessionKey: "verifier-1", role: "verifier", bound: true },
        snapshot: { latestN: 3, status: "IN_PROGRESS", verifyExists: false, verdict: null },
      }),
    );
    expect(allowTo(actions, "verifier-1")).toBe(true);
    const n = notifies(actions);
    expect(n.map((x) => x.key)).toEqual(["noverify-v3"]);
  });
});

describe("CODER 행 c1~c9", () => {
  const coder = { sessionKey: "coder-1", role: "coder" as const, bound: true };

  it("c1. TODO_READY, todo 없음 → allow + notify(notodo-v3, warn)", () => {
    const actions = evaluate(
      input({
        sender: coder,
        snapshot: { latestN: 3, status: "TODO_READY", verifyExists: true, verdict: "PASS" },
      }),
    );
    expect(allowTo(actions, "coder-1")).toBe(true);
    const n = notifies(actions);
    expect(n.map((x) => [x.key, x.level])).toEqual([["notodo-v3", "warn"]]);
  });

  it("c2. TODO_READY, todo T=1·verify 없음 → allow + notify(notodoverify-v1, warn)", () => {
    const actions = evaluate(
      input({
        sender: coder,
        snapshot: { latestN: 3, status: "TODO_READY", verifyExists: true, verdict: "PASS" },
        todo: { latestN: 1, verifyExists: false, verdict: null, checklistExists: false },
      }),
    );
    expect(allowTo(actions, "coder-1")).toBe(true);
    const n = notifies(actions);
    expect(n.map((x) => [x.key, x.level])).toEqual([["notodoverify-v1", "warn"]]);
  });

  it("c3. REVISE, T=1 < confirmFromVersion, planner parked → planner에 block(instructionTodoRevise(1)) + hold(coder-1)", () => {
    const actions = evaluate(
      input({
        sender: coder,
        snapshot: { latestN: 3, status: "TODO_READY", verifyExists: true, verdict: "PASS" },
        todo: { latestN: 1, verifyExists: true, verdict: "REVISE", checklistExists: false },
        peers: { planner: { sessionKey: "planner-1", state: "parked" } },
      }),
    );
    expect(actions.some((a) => a.kind === "hold" && a.sessionKey === "coder-1")).toBe(true);
    const b = blockTo(actions, "planner-1");
    expect(b?.reply).toEqual({ action: "block", reason: instructionTodoRevise(1) });
  });

  it("c4. REVISE, T=5 ≥ confirmFromVersion → hold + notify(todo-gate-v5, warn), block 없음", () => {
    const actions = evaluate(
      input({
        sender: coder,
        snapshot: { latestN: 3, status: "TODO_READY", verifyExists: true, verdict: "PASS" },
        todo: { latestN: 5, verifyExists: true, verdict: "REVISE", checklistExists: false },
        peers: { planner: { sessionKey: "planner-1", state: "parked" } },
      }),
    );
    expect(actions.some((a) => a.kind === "hold" && a.sessionKey === "coder-1")).toBe(true);
    const n = notifies(actions);
    expect(n.map((x) => [x.key, x.level])).toEqual([["todo-gate-v5", "warn"]]);
    expect(blockTo(actions, "planner-1")).toBeUndefined();
  });

  it("c5. MALFORMED → coder에 block(instructionTodoVerdictLine(1))", () => {
    const actions = evaluate(
      input({
        sender: coder,
        snapshot: { latestN: 3, status: "TODO_READY", verifyExists: true, verdict: "PASS" },
        todo: { latestN: 1, verifyExists: true, verdict: "MALFORMED", checklistExists: false },
      }),
    );
    const b = blockTo(actions, "coder-1");
    expect(b?.reply).toEqual({ action: "block", reason: instructionTodoVerdictLine(1) });
  });

  it("c6. PASS 첫 평가 → block(instructionImplement(1)) + record.instructed에 impl-v1", () => {
    const actions = evaluate(
      input({
        sender: coder,
        snapshot: { latestN: 3, status: "TODO_READY", verifyExists: true, verdict: "PASS" },
        todo: { latestN: 1, verifyExists: true, verdict: "PASS", checklistExists: false },
      }),
    );
    const b = blockTo(actions, "coder-1");
    expect(b?.reply).toEqual({ action: "block", reason: instructionImplement(1) });
    const rec = records(actions)[0];
    expect(rec.instructed).toContain("impl-v1");
  });

  it("c6. instructed에 impl-v1 기록됨 → allow", () => {
    const actions = evaluate(
      input({
        sender: coder,
        snapshot: { latestN: 3, status: "TODO_READY", verifyExists: true, verdict: "PASS" },
        todo: { latestN: 1, verifyExists: true, verdict: "PASS", checklistExists: false },
        record: { notified: [], consecutiveBlocks: {}, instructed: ["impl-v1"] },
      }),
    );
    expect(actions).toEqual([{ kind: "reply", sessionKey: "coder-1", reply: { action: "allow" } }]);
  });

  it("c7. IN_PROGRESS → allow + notify(coder-stopped-v1, info)", () => {
    const actions = evaluate(
      input({
        sender: coder,
        snapshot: { latestN: 3, status: "IN_PROGRESS", verifyExists: true, verdict: "PASS" },
        todo: { latestN: 1, verifyExists: true, verdict: "PASS", checklistExists: false },
      }),
    );
    expect(allowTo(actions, "coder-1")).toBe(true);
    const n = notifies(actions);
    expect(n.map((x) => [x.key, x.level])).toEqual([["coder-stopped-v1", "info"]]);
  });

  it("c8. BLOCKED, planner parked → planner에 block(instructionBlocked(3)) + 기록 blocked-v3", () => {
    const actions = evaluate(
      input({
        sender: coder,
        snapshot: { latestN: 3, status: "BLOCKED", verifyExists: true, verdict: "PASS" },
        peers: { planner: { sessionKey: "planner-1", state: "parked" } },
      }),
    );
    expect(allowTo(actions, "coder-1")).toBe(true);
    const b = blockTo(actions, "planner-1");
    expect(b?.reply).toEqual({ action: "block", reason: instructionBlocked(3) });
    const rec = records(actions)[0];
    expect(rec.instructed).toContain("blocked-v3");
  });

  it("c8. BLOCKED, planner idle → undeliverable(planner), instructed 기록 없음", () => {
    const actions = evaluate(
      input({
        sender: coder,
        snapshot: { latestN: 3, status: "BLOCKED", verifyExists: true, verdict: "PASS" },
        peers: { planner: { sessionKey: "planner-1", state: "idle" } },
      }),
    );
    expect(allowTo(actions, "coder-1")).toBe(true);
    expect(actions).toContainEqual({ kind: "undeliverable", role: "planner", text: instructionBlocked(3) });
    const rec = records(actions)[0];
    expect(rec.instructed ?? []).not.toContain("blocked-v3");
  });

  it("c9. DONE, T=1, planner parked → PLANNER에 block(instructionChecklist(3, 1)) + record.instructed에 checklist-v1", () => {
    const actions = evaluate(
      input({
        sender: coder,
        snapshot: { latestN: 3, status: "DONE", verifyExists: true, verdict: "PASS" },
        todo: { latestN: 1, verifyExists: true, verdict: "PASS", checklistExists: false },
        peers: { planner: { sessionKey: "planner-1", state: "parked" } },
      }),
    );
    expect(allowTo(actions, "coder-1")).toBe(true);
    const b = blockTo(actions, "planner-1");
    expect(b?.reply).toEqual({ action: "block", reason: instructionChecklist(3, 1) });
    const rec = records(actions)[0];
    expect(rec.instructed ?? []).toContain("checklist-v1");
  });

  it("c9. DONE, T=1, checklist 있음 → 지시 없음 (coder allow + done-v3만)", () => {
    const actions = evaluate(
      input({
        sender: coder,
        snapshot: { latestN: 3, status: "DONE", verifyExists: true, verdict: "PASS" },
        todo: { latestN: 1, verifyExists: true, verdict: "PASS", checklistExists: true },
        peers: { planner: { sessionKey: "planner-1", state: "parked" } },
      }),
    );
    expect(allowTo(actions, "coder-1")).toBe(true);
    expect(blockTo(actions, "planner-1")).toBeUndefined();
    const n = notifies(actions);
    expect(n.map((x) => [x.key, x.level])).toEqual([["done-v3", "info"]]);
  });

  it("c9. DONE, T=1, instructed에 checklist-v1 → 지시 없음", () => {
    const actions = evaluate(
      input({
        sender: coder,
        snapshot: { latestN: 3, status: "DONE", verifyExists: true, verdict: "PASS" },
        todo: { latestN: 1, verifyExists: true, verdict: "PASS", checklistExists: false },
        peers: { planner: { sessionKey: "planner-1", state: "parked" } },
        record: { notified: [], consecutiveBlocks: {}, instructed: ["checklist-v1"] },
      }),
    );
    expect(allowTo(actions, "coder-1")).toBe(true);
    expect(blockTo(actions, "planner-1")).toBeUndefined();
  });

  it("c9. DONE, T=1, planner idle → undeliverable(planner, instructionChecklist(3, 1)), instructed 기록 없음", () => {
    const actions = evaluate(
      input({
        sender: coder,
        snapshot: { latestN: 3, status: "DONE", verifyExists: true, verdict: "PASS" },
        todo: { latestN: 1, verifyExists: true, verdict: "PASS", checklistExists: false },
        peers: { planner: { sessionKey: "planner-1", state: "idle" } },
      }),
    );
    expect(allowTo(actions, "coder-1")).toBe(true);
    expect(actions).toContainEqual({ kind: "undeliverable", role: "planner", text: instructionChecklist(3, 1) });
    const rec = records(actions)[0];
    expect(rec.instructed ?? []).not.toContain("checklist-v1");
  });

  it("c9. DONE, T null → CODER allow + done-v3 알림만 (지시 없음)", () => {
    const actions = evaluate(
      input({
        sender: coder,
        snapshot: { latestN: 3, status: "DONE", verifyExists: true, verdict: "PASS" },
        peers: { planner: { sessionKey: "planner-1", state: "parked" } },
      }),
    );
    expect(allowTo(actions, "coder-1")).toBe(true);
    expect(blockTo(actions, "planner-1")).toBeUndefined();
    const n = notifies(actions);
    expect(n.map((x) => [x.key, x.level])).toEqual([["done-v3", "info"]]);
  });

  it("c9. DONE, planner 없음 → coder allow만 (planner reply 없음)", () => {
    const actions = evaluate(
      input({
        sender: coder,
        snapshot: { latestN: 3, status: "DONE", verifyExists: true, verdict: "PASS" },
      }),
    );
    expect(allowTo(actions, "coder-1")).toBe(true);
    expect(replies(actions).some((r) => r.sessionKey === "planner-1")).toBe(false);
  });
});

describe("행 11 — 그 외 조합", () => {
  it("bound PLANNER, plan 파일 없음 (latestN null) → allow + notify(unexpected-...)", () => {
    const actions = evaluate(
      input({ snapshot: { latestN: null, status: null, verifyExists: false, verdict: null } }),
    );
    expect(allowTo(actions, "planner-1")).toBe(true);
    const n = notifies(actions);
    expect(n.map((x) => x.key)).toEqual(["unexpected-planner-null-null-null"]);
  });
});

describe("알림 중복 방지", () => {
  it("같은 입력 두 번 → 두 번째 notify 없음", () => {
    const base = input({ snapshot: { latestN: 3, status: "NEEDS_DECISION", verifyExists: false, verdict: null } });
    const first = evaluate(base);
    expect(notifies(first).map((x) => x.key)).toEqual(["decision-v3"]);
    const rec = records(first)[0];
    const second = evaluate({ ...base, record: { notified: rec.notified ?? [], consecutiveBlocks: rec.consecutiveBlocks ?? {}, instructed: rec.instructed ?? [] } });
    expect(notifies(second)).toHaveLength(0);
    expect(allowTo(second, "planner-1")).toBe(true);
  });
});

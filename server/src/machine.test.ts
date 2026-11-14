// T6 — 상태 머신 테스트. 판정표 행 0~11 + 알림 중복 방지.
import { describe, it, expect } from "vitest";
import {
  evaluate,
  instructionVerifyPlan,
  instructionPlanRevise,
  instructionVerdictLine,
  instructionApproveAndTodo,
  instructionFinishTodo,
  type MachineInput,
  type Action,
} from "./machine.js";

function input(overrides: Partial<MachineInput> = {}): MachineInput {
  return {
    sender: { sessionKey: "planner-1", role: "planner", bound: true },
    taskActive: true,
    snapshot: { latestN: 3, status: "IN_REVIEW", verifyExists: false, verdict: null },
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

  it("peer 없음 → hold + launch(verifier)", () => {
    const actions = evaluate(
      input({ snapshot: { latestN: 3, status: "IN_REVIEW", verifyExists: false, verdict: null } }),
    );
    expect(actions.some((a) => a.kind === "hold" && a.sessionKey === "planner-1")).toBe(true);
    expect(actions).toContainEqual({ kind: "launch", role: "verifier" });
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

  it("5b. TODO_READY → allow + notify(todo-ready-v3, info)", () => {
    const actions = evaluate(
      input({ snapshot: { latestN: 3, status: "TODO_READY", verifyExists: true, verdict: "PASS" } }),
    );
    expect(allowTo(actions, "planner-1")).toBe(true);
    const n = notifies(actions);
    expect(n.map((x) => [x.key, x.level])).toEqual([["todo-ready-v3", "info"]]);
  });

  it("5c. IN_PROGRESS / BLOCKED / DONE → allow, 알림 없음", () => {
    for (const status of ["IN_PROGRESS", "BLOCKED", "DONE"] as const) {
      const actions = evaluate(
        input({ snapshot: { latestN: 3, status, verifyExists: true, verdict: "PASS" } }),
      );
      expect(actions).toEqual([{ kind: "reply", sessionKey: "planner-1", reply: { action: "allow" } }]);
    }
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

  it("peer 없음 → hold + launch(planner)", () => {
    const actions = evaluate(
      input({
        sender: { sessionKey: "verifier-1", role: "verifier", bound: true },
        snapshot: { latestN: 3, status: "IN_PROGRESS", verifyExists: true, verdict: "REVISE" },
      }),
    );
    expect(actions.some((a) => a.kind === "hold" && a.sessionKey === "verifier-1")).toBe(true);
    expect(actions).toContainEqual({ kind: "launch", role: "planner" });
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

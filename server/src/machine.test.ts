// T6 — 상태 머신 테스트. 판정표 행 0~11 + 알림 중복 방지.
import { describe, it, expect } from "vitest";
import {
  evaluate,
  instructionVerifyPlan,
  instructionPlanRevise,
  instructionVerdictLine,
  type MachineInput,
  type Action,
} from "./machine.js";

function input(overrides: Partial<MachineInput> = {}): MachineInput {
  return {
    sender: { sessionKey: "plan-1", role: "plan", bound: true },
    taskActive: true,
    snapshot: { latestN: 3, status: "IN_REVIEW", verifyExists: false, verdict: null },
    newPlanFolders: [],
    peers: {},
    record: { notified: [], consecutiveBlocks: {} },
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
    expect(actions).toEqual([{ kind: "reply", sessionKey: "plan-1", reply: { action: "allow" } }]);
  });
});

describe("행 1 — PLAN unbound", () => {
  it("새 plan 폴더 0개 → allow", () => {
    const actions = evaluate(input({ sender: { sessionKey: "plan-1", role: "plan", bound: false } }));
    expect(actions).toEqual([{ kind: "reply", sessionKey: "plan-1", reply: { action: "allow" } }]);
  });

  it("새 plan 폴더 1개 → bind + allow만", () => {
    const actions = evaluate(
      input({ sender: { sessionKey: "plan-1", role: "plan", bound: false }, newPlanFolders: ["261111-alpha"] }),
    );
    expect(actions).toEqual([
      { kind: "bind", folder: "261111-alpha" },
      { kind: "reply", sessionKey: "plan-1", reply: { action: "allow" } },
    ]);
  });

  it("새 plan 폴더 2개 → allow + notify(warn, bind-ambiguous)", () => {
    const actions = evaluate(
      input({
        sender: { sessionKey: "plan-1", role: "plan", bound: false },
        newPlanFolders: ["261111-alpha", "261111-beta"],
      }),
    );
    expect(allowTo(actions, "plan-1")).toBe(true);
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
    expect(allowTo(actions, "plan-1")).toBe(true);
    const n = notifies(actions);
    expect(n.map((x) => x.key)).toEqual(["decision-v3"]);
  });
});

describe("행 3 — IN_REVIEW, verify 없음 (peer 4가지)", () => {
  it("peer parked → hold + peer에 block(지시 문장)", () => {
    const actions = evaluate(
      input({
        snapshot: { latestN: 3, status: "IN_REVIEW", verifyExists: false, verdict: null },
        peers: { verify: { sessionKey: "verify-1", state: "parked" } },
      }),
    );
    expect(actions.some((a) => a.kind === "hold" && a.sessionKey === "plan-1")).toBe(true);
    const b = blockTo(actions, "verify-1");
    expect(b?.reply).toEqual({ action: "block", reason: instructionVerifyPlan(3) });
    expect(allowTo(actions, "plan-1")).toBe(false);
  });

  it("peer working → hold만 (지시 전달 없음)", () => {
    const actions = evaluate(
      input({
        snapshot: { latestN: 3, status: "IN_REVIEW", verifyExists: false, verdict: null },
        peers: { verify: { sessionKey: "verify-1", state: "working" } },
      }),
    );
    expect(actions).toEqual([{ kind: "hold", sessionKey: "plan-1" }]);
  });

  it("peer idle → hold + undeliverable (notify 없음)", () => {
    const actions = evaluate(
      input({
        snapshot: { latestN: 3, status: "IN_REVIEW", verifyExists: false, verdict: null },
        peers: { verify: { sessionKey: "verify-1", state: "idle" } },
      }),
    );
    expect(actions.some((a) => a.kind === "hold" && a.sessionKey === "plan-1")).toBe(true);
    const u = actions.find((a) => a.kind === "undeliverable");
    expect(u).toEqual({ kind: "undeliverable", role: "verify", text: instructionVerifyPlan(3) });
    expect(notifies(actions)).toHaveLength(0);
  });

  it("peer 없음 → hold + launch(verify)", () => {
    const actions = evaluate(
      input({ snapshot: { latestN: 3, status: "IN_REVIEW", verifyExists: false, verdict: null } }),
    );
    expect(actions.some((a) => a.kind === "hold" && a.sessionKey === "plan-1")).toBe(true);
    expect(actions).toContainEqual({ kind: "launch", role: "verify" });
  });
});

describe("행 4 — IN_REVIEW, verify 있음", () => {
  it("allow만 (알림 없음)", () => {
    const actions = evaluate(
      input({ snapshot: { latestN: 3, status: "IN_REVIEW", verifyExists: true, verdict: "REVISE" } }),
    );
    expect(actions).toEqual([{ kind: "reply", sessionKey: "plan-1", reply: { action: "allow" } }]);
  });
});

describe("행 4a — DRAFT / Status 없음", () => {
  it("DRAFT → allow, 알림 없음", () => {
    const actions = evaluate(input({ snapshot: { latestN: 3, status: "DRAFT", verifyExists: false, verdict: null } }));
    expect(actions).toEqual([{ kind: "reply", sessionKey: "plan-1", reply: { action: "allow" } }]);
  });

  it("MISSING → allow, 알림 없음", () => {
    const actions = evaluate(input({ snapshot: { latestN: 3, status: "MISSING", verifyExists: false, verdict: null } }));
    expect(actions).toEqual([{ kind: "reply", sessionKey: "plan-1", reply: { action: "allow" } }]);
  });
});

describe("행 5 — APPROVED / TODO_READY / 그 이후", () => {
  it.each(["APPROVED", "TODO_READY", "IN_PROGRESS", "BLOCKED", "DONE"] as const)(
    "%s → allow, 알림 없음",
    (status) => {
      const actions = evaluate(input({ snapshot: { latestN: 3, status, verifyExists: true, verdict: "PASS" } }));
      expect(actions).toEqual([{ kind: "reply", sessionKey: "plan-1", reply: { action: "allow" } }]);
    },
  );
});

describe("행 6 — VERIFY REVISE, N < confirmFromVersion", () => {
  it("peer parked → hold + peer에 block(지시 문장)", () => {
    const actions = evaluate(
      input({
        sender: { sessionKey: "verify-1", role: "verify", bound: true },
        snapshot: { latestN: 3, status: "IN_PROGRESS", verifyExists: true, verdict: "REVISE" },
        peers: { plan: { sessionKey: "plan-1", state: "parked" } },
      }),
    );
    expect(actions.some((a) => a.kind === "hold" && a.sessionKey === "verify-1")).toBe(true);
    const b = blockTo(actions, "plan-1");
    expect(b?.reply).toEqual({ action: "block", reason: instructionPlanRevise(3) });
  });

  it("peer 없음 → hold + launch(plan)", () => {
    const actions = evaluate(
      input({
        sender: { sessionKey: "verify-1", role: "verify", bound: true },
        snapshot: { latestN: 3, status: "IN_PROGRESS", verifyExists: true, verdict: "REVISE" },
      }),
    );
    expect(actions.some((a) => a.kind === "hold" && a.sessionKey === "verify-1")).toBe(true);
    expect(actions).toContainEqual({ kind: "launch", role: "plan" });
  });
});

describe("행 7 — VERIFY REVISE, N ≥ confirmFromVersion", () => {
  it("hold + notify(gate-v5), PLAN 지시 없음", () => {
    const actions = evaluate(
      input({
        sender: { sessionKey: "verify-1", role: "verify", bound: true },
        snapshot: { latestN: 5, status: "IN_PROGRESS", verifyExists: true, verdict: "REVISE" },
        peers: { plan: { sessionKey: "plan-1", state: "parked" } },
      }),
    );
    expect(actions.some((a) => a.kind === "hold" && a.sessionKey === "verify-1")).toBe(true);
    const n = notifies(actions);
    expect(n.map((x) => x.key)).toEqual(["gate-v5"]);
    expect(n[0].level).toBe("warn");
    // parked PLAN에도 block을 보내지 않는다 (지시 없음).
    expect(blockTo(actions, "plan-1")).toBeUndefined();
  });
});

describe("행 8 — VERIFY PASS", () => {
  it("allow + parked PLAN allow + notify(pass-v3, info)", () => {
    const actions = evaluate(
      input({
        sender: { sessionKey: "verify-1", role: "verify", bound: true },
        snapshot: { latestN: 3, status: "APPROVED", verifyExists: true, verdict: "PASS" },
        peers: { plan: { sessionKey: "plan-1", state: "parked" } },
      }),
    );
    expect(allowTo(actions, "verify-1")).toBe(true);
    expect(allowTo(actions, "plan-1")).toBe(true);
    const n = notifies(actions);
    expect(n.map((x) => [x.key, x.level])).toEqual([["pass-v3", "info"]]);
  });

  it("PLAN peer가 parked가 아니면 PLAN allow 없음", () => {
    const actions = evaluate(
      input({
        sender: { sessionKey: "verify-1", role: "verify", bound: true },
        snapshot: { latestN: 3, status: "APPROVED", verifyExists: true, verdict: "PASS" },
        peers: { plan: { sessionKey: "plan-1", state: "idle" } },
      }),
    );
    expect(allowTo(actions, "verify-1")).toBe(true);
    expect(allowTo(actions, "plan-1")).toBe(false);
  });
});

describe("행 9 — VERIFY 판정 줄 형식 오류", () => {
  it("block(지시 문장) + 카운트 증가", () => {
    const actions = evaluate(
      input({
        sender: { sessionKey: "verify-1", role: "verify", bound: true },
        snapshot: { latestN: 3, status: "IN_PROGRESS", verifyExists: true, verdict: "MALFORMED" },
      }),
    );
    const b = blockTo(actions, "verify-1");
    expect(b?.reply).toEqual({ action: "block", reason: instructionVerdictLine(3) });
    const rec = records(actions)[0];
    expect(rec.consecutiveBlocks?.["verify-1"]).toBe(1);
  });

  it("연속 상한 초과 (카운트 3, max 3) → allow + notify(blocks-verify-1) + 카운트 0", () => {
    const actions = evaluate(
      input({
        sender: { sessionKey: "verify-1", role: "verify", bound: true },
        snapshot: { latestN: 3, status: "IN_PROGRESS", verifyExists: true, verdict: "MALFORMED" },
        record: { notified: [], consecutiveBlocks: { "verify-1": 3 } },
      }),
    );
    expect(allowTo(actions, "verify-1")).toBe(true);
    expect(blockTo(actions, "verify-1")).toBeUndefined();
    const n = notifies(actions);
    expect(n.map((x) => [x.key, x.level])).toEqual([["blocks-verify-1", "warn"]]);
    const rec = records(actions)[0];
    expect(rec.consecutiveBlocks?.["verify-1"]).toBe(0);
  });
});

describe("행 10 — verify-vN 없음", () => {
  it("allow + notify(noverify-v3)", () => {
    const actions = evaluate(
      input({
        sender: { sessionKey: "verify-1", role: "verify", bound: true },
        snapshot: { latestN: 3, status: "IN_PROGRESS", verifyExists: false, verdict: null },
      }),
    );
    expect(allowTo(actions, "verify-1")).toBe(true);
    const n = notifies(actions);
    expect(n.map((x) => x.key)).toEqual(["noverify-v3"]);
  });
});

describe("행 11 — 그 외 조합", () => {
  it("bound PLAN, plan 파일 없음 (latestN null) → allow + notify(unexpected-...)", () => {
    const actions = evaluate(
      input({ snapshot: { latestN: null, status: null, verifyExists: false, verdict: null } }),
    );
    expect(allowTo(actions, "plan-1")).toBe(true);
    const n = notifies(actions);
    expect(n.map((x) => x.key)).toEqual(["unexpected-plan-null-null-null"]);
  });
});

describe("알림 중복 방지", () => {
  it("같은 입력 두 번 → 두 번째 notify 없음", () => {
    const base = input({ snapshot: { latestN: 3, status: "NEEDS_DECISION", verifyExists: false, verdict: null } });
    const first = evaluate(base);
    expect(notifies(first).map((x) => x.key)).toEqual(["decision-v3"]);
    const rec = records(first)[0];
    const second = evaluate({ ...base, record: { notified: rec.notified ?? [], consecutiveBlocks: rec.consecutiveBlocks ?? {} } });
    expect(notifies(second)).toHaveLength(0);
    expect(allowTo(second, "plan-1")).toBe(true);
  });
});

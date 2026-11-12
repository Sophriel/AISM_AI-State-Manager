// T12 완료 조건 — (추가) PLAN idle일 때 VERIFY Stop(REVISE) → undelivered·notify·pendingAction.deliver → PLAN Stop 시 삭제.
// 그리고 launcher·파일 읽기 주입 시나리오: 새 작업 → … → PASS.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import type { AismConfig } from "./config.js";
import { Store } from "./store.js";
import { Sessions } from "./sessions.js";
import { Orchestrator } from "./orchestrator.js";
import { instructionPlanRevise, instructionVerifyPlan, type Reply } from "./machine.js";
import type { LaunchOptions } from "./launcher.js";

type Timer = ReturnType<typeof setTimeout>;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aism-orch-"));
  const plansDir = path.join(root, ".claude/plans");
  const folder = "261111-alpha";
  fs.mkdirSync(plansDir, { recursive: true });

  const config: AismConfig = {
    port: 4400,
    endpoints: { cloud: {}, local: {} },
    roles: { plan: { endpoint: "cloud", prompt: [] }, verify: { endpoint: "local", prompt: [] } },
    projects: { EWE: { root, plansDir: ".claude/plans", protectedPaths: [] } },
    confirmFromVersion: 5,
    maxConsecutiveBlocks: 3,
    parkLimitSec: 3300,
    hookTimeoutSec: 3600,
  };

  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "aism-orch-store-"));
  const store = new Store(storeDir);
  let timerFn: (() => void) | null = null;
  const setTimer = (fn: () => void, _ms: number): Timer => {
    timerFn = fn;
    return {} as Timer;
  };
  const clearTimer = (_t: Timer): void => {
    timerFn = null;
  };
  const sessions = new Sessions(store, 3300, { setTimer, clearTimer });

  const launchCalls: LaunchOptions[] = [];
  let keyCounter = 0;
  const fakeLaunch = (opts: LaunchOptions) => {
    launchCalls.push(opts);
    const sessionKey = `${opts.role}-fake-${++keyCounter}`;
    if (opts.store) {
      opts.store.state.sessions[sessionKey] = {
        role: opts.role,
        project: opts.project,
        folder: opts.folder,
        launchedAt: Date.now() - 60000, // 과거 — findNewPlanV1이 새로 만든 plan-v1.md를 찾도록.
        sessionIds: [],
        activeSessionId: null,
        switchedOnce: false,
      };
    }
    return { sessionKey, dir: "/fake" };
  };

  const orchestrator = new Orchestrator({ config, store, sessions, launch: fakeLaunch, aismRoot: root });

  return {
    root,
    plansDir,
    folder,
    taskDir: path.join(plansDir, folder),
    config,
    store,
    sessions,
    orchestrator,
    launchCalls,
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(storeDir, { recursive: true, force: true });
    },
  };
}

describe("undeliverable (C2-1)", () => {
  it("PLAN idle일 때 VERIFY Stop(REVISE) → undelivered·notify·pendingAction.deliver → PLAN Stop 시 삭제", () => {
    const env = setup();
    const { orchestrator, store, sessions, taskDir, folder } = env;

    // activeTask + PLAN(idle)·VERIFY(working) 세션 설정.
    store.state.activeTask = { project: "EWE", folder, startedAt: Date.now() };
    store.state.sessions["plan-1"] = {
      role: "plan",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["p1"],
      activeSessionId: "p1",
      switchedOnce: false,
    };
    store.state.sessions["verify-1"] = {
      role: "verify",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["v1"],
      activeSessionId: "v1",
      switchedOnce: false,
    };
    sessions.register("plan-1", "idle");
    sessions.register("verify-1", "working");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: IN_REVIEW\n");
    fs.writeFileSync(path.join(taskDir, "plan-v1-verify.md"), "# verify\n\n판정: REVISE\n");

    // VERIFY Stop → 행 6 → PLAN(idle)에 undeliverable.
    let replyV: Reply | null = null;
    orchestrator.handleStop("verify-1", { sessionId: "v1" }, (r) => (replyV = r), () => {});
    expect(sessions.stateOf("verify-1")).toBe("parked"); // VERIFY hold
    expect(store.state.undelivered).toHaveLength(1);
    expect(store.state.undelivered[0].role).toBe("plan");
    expect(store.state.undelivered[0].text).toBe(instructionPlanRevise(1));
    expect(orchestrator.pendingAction()).toEqual({ kind: "deliver", role: "plan", text: instructionPlanRevise(1) });
    const notifyEvents = store.readEvents().filter((e) => e.type === "notify");
    expect(notifyEvents).toHaveLength(1);
    expect(notifyEvents[0].key).toBe("undeliverable-plan");

    // PLAN Stop → undelivered 삭제 + 행 4 (IN_REVIEW·verify 있음) → allow.
    let replyP: Reply | null = null;
    orchestrator.handleStop("plan-1", { sessionId: "p1" }, (r) => (replyP = r), () => {});
    expect(store.state.undelivered).toHaveLength(0);
    expect(replyP).toEqual({ action: "allow" });
    expect(sessions.stateOf("plan-1")).toBe("idle");

    env.cleanup();
  });
});

describe("시나리오 (launcher·파일 주입)", () => {
  it("새 작업 → PLAN Stop allow → bind → hold+VERIFY launch → REVISE block → … → PASS 둘 다 allow+notify", () => {
    const env = setup();
    const { orchestrator, store, sessions, plansDir, folder, taskDir } = env;

    // Step 0 — 새 작업.
    expect(orchestrator.newTask("EWE").ok).toBe(true);
    expect(store.state.activeTask?.project).toBe("EWE");
    expect(store.state.activeTask?.folder).toBeNull();
    const planKey = Object.keys(store.state.sessions).find((k) => store.state.sessions[k].role === "plan")!;
    expect(sessions.stateOf(planKey)).toBe("unbound");

    // Step 1 — PLAN Stop (folder 없음) → allow.
    let reply1: Reply | null = null;
    orchestrator.handleStop(planKey, { sessionId: "s1" }, (r) => (reply1 = r), () => {});
    expect(reply1).toEqual({ action: "allow" });
    expect(sessions.stateOf(planKey)).toBe("idle");

    // Step 2 — PLAN이 plan-v1.md 생성 후 Stop → bind.
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: IN_REVIEW\n");
    let reply2: Reply | null = null;
    orchestrator.handleStop(planKey, { sessionId: "s1" }, (r) => (reply2 = r), () => {});
    expect(reply2).toEqual({ action: "allow" });
    expect(store.state.activeTask?.folder).toBe(folder);
    expect(store.state.sessions[planKey].folder).toBe(folder);

    // Step 3 — PLAN Stop (bound, IN_REVIEW·verify 없음) → hold + VERIFY launch.
    let reply3: Reply | null = null;
    orchestrator.handleStop(planKey, { sessionId: "s1" }, (r) => (reply3 = r), () => {});
    expect(sessions.stateOf(planKey)).toBe("parked");
    const verifyKey = Object.keys(store.state.sessions).find((k) => store.state.sessions[k].role === "verify")!;
    expect(verifyKey).toBeDefined();
    expect(sessions.stateOf(verifyKey)).toBe("launching");

    // Step 4 — VERIFY가 plan-v1-verify.md(REVISE) 생성 후 Stop → PLAN block + VERIFY hold.
    fs.writeFileSync(path.join(taskDir, "plan-v1-verify.md"), "# verify\n\n판정: REVISE\n");
    let reply4: Reply | null = null;
    orchestrator.handleStop(verifyKey, { sessionId: "v1" }, (r) => (reply4 = r), () => {});
    expect(sessions.stateOf(verifyKey)).toBe("parked"); // VERIFY hold
    expect(reply3).toEqual({ action: "block", reason: instructionPlanRevise(1) }); // PLAN block
    expect(sessions.stateOf(planKey)).toBe("working");

    // Step 5 — PLAN이 plan-v2.md 생성 후 Stop → hold + VERIFY block.
    fs.writeFileSync(path.join(taskDir, "plan-v2.md"), "Status: IN_REVIEW\n");
    let reply5: Reply | null = null;
    orchestrator.handleStop(planKey, { sessionId: "s1" }, (r) => (reply5 = r), () => {});
    expect(sessions.stateOf(planKey)).toBe("parked");
    expect(reply4).toEqual({ action: "block", reason: instructionVerifyPlan(2) }); // VERIFY block
    expect(sessions.stateOf(verifyKey)).toBe("working");

    // Step 6 — VERIFY가 plan-v2-verify.md(PASS) 생성 후 Stop → 둘 다 allow + notify.
    fs.writeFileSync(path.join(taskDir, "plan-v2-verify.md"), "# verify\n\n판정: PASS\n");
    let reply6: Reply | null = null;
    orchestrator.handleStop(verifyKey, { sessionId: "v1" }, (r) => (reply6 = r), () => {});
    expect(reply6).toEqual({ action: "allow" }); // VERIFY allow
    expect(reply5).toEqual({ action: "allow" }); // PLAN allow (parked였음)
    expect(sessions.stateOf(planKey)).toBe("idle");
    expect(sessions.stateOf(verifyKey)).toBe("idle");
    const passNotify = store.readEvents().find((e) => e.type === "notify" && e.key === "pass-v2");
    expect(passNotify).toBeDefined();

    env.cleanup();
  });
});

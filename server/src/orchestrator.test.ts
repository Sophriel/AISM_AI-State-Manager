// T12 완료 조건 — (추가) PLAN idle일 때 VERIFY Stop(REVISE) → undelivered·notify·pendingAction.deliver → PLAN Stop 시 삭제.
// 그리고 launcher·파일 읽기 주입 시나리오: 새 작업 → … → PASS.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import type { AismConfig } from "./config.js";
import { Store, newActiveTask } from "./store.js";
import { Sessions } from "./sessions.js";
import { Orchestrator } from "./orchestrator.js";
import { instructionApproveAndTodo, instructionPlanRevise, instructionVerifyPlan, type Reply } from "./machine.js";
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

    // activeTask + PLAN(idle)·VERIFY(working) 세션 설정 (W4 배정).
    store.state.activeTask = {
      ...newActiveTask("EWE", Date.now()),
      folder,
      assigned: { plan: "plan-1", verify: "verify-1" },
    };
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
    orchestrator.handleStop("verify-1", { session_id:"v1" }, (r) => (replyV = r), () => {});
    expect(sessions.stateOf("verify-1")).toBe("parked"); // VERIFY hold
    expect(store.state.activeTask?.undelivered).toHaveLength(1);
    expect(store.state.activeTask?.undelivered[0].role).toBe("plan");
    expect(store.state.activeTask?.undelivered[0].text).toBe(instructionPlanRevise(1));
    expect(orchestrator.pendingAction()).toEqual({ kind: "deliver", role: "plan", text: instructionPlanRevise(1) });
    const notifyEvents = store.readEvents().filter((e) => e.type === "notify");
    expect(notifyEvents).toHaveLength(1);
    expect(notifyEvents[0].key).toBe("undeliverable-plan");

    // PLAN Stop → undelivered 삭제 + 행 4 (IN_REVIEW·verify 있음) → allow.
    let replyP: Reply | null = null;
    orchestrator.handleStop("plan-1", { session_id:"p1" }, (r) => (replyP = r), () => {});
    expect(store.state.activeTask?.undelivered).toHaveLength(0);
    expect(replyP).toEqual({ action: "allow" });
    expect(sessions.stateOf("plan-1")).toBe("idle");

    env.cleanup();
  });
});

describe("시나리오 (launcher·파일 주입)", () => {
  it("새 작업 → PLAN Stop allow → bind+hold+VERIFY launch → REVISE block → … → PASS: VERIFY allow + notify + PLAN block(todo 지시)", () => {
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
    orchestrator.handleStop(planKey, { session_id:"s1" }, (r) => (reply1 = r), () => {});
    expect(reply1).toEqual({ action: "allow" });
    expect(sessions.stateOf(planKey)).toBe("idle");

    // Step 2 — PLAN이 plan-v1.md 생성 후 Stop → bind + hold + VERIFY launch 한 번에 (W1).
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: IN_REVIEW\n");
    let reply2: Reply | null = null;
    orchestrator.handleStop(planKey, { session_id:"s1" }, (r) => (reply2 = r), () => {});
    expect(store.state.activeTask?.folder).toBe(folder);
    expect(store.state.sessions[planKey].folder).toBe(folder);
    expect(sessions.stateOf(planKey)).toBe("parked"); // hold — reply 아직 방출 안 됨
    const verifyKey = Object.keys(store.state.sessions).find((k) => store.state.sessions[k].role === "verify")!;
    expect(verifyKey).toBeDefined();
    expect(sessions.stateOf(verifyKey)).toBe("launching");

    // Step 3 — PLAN이 다시 Stop → 이전 pending을 allow로 방출 + 재 hold (VERIFY launching).
    let reply3: Reply | null = null;
    orchestrator.handleStop(planKey, { session_id:"s1" }, (r) => (reply3 = r), () => {});
    expect(reply2).toEqual({ action: "allow" }); // Step 2의 pending 방출
    expect(sessions.stateOf(planKey)).toBe("parked");

    // Step 4 — VERIFY가 plan-v1-verify.md(REVISE) 생성 후 Stop → PLAN block + VERIFY hold.
    fs.writeFileSync(path.join(taskDir, "plan-v1-verify.md"), "# verify\n\n판정: REVISE\n");
    let reply4: Reply | null = null;
    orchestrator.handleStop(verifyKey, { session_id:"v1" }, (r) => (reply4 = r), () => {});
    expect(sessions.stateOf(verifyKey)).toBe("parked"); // VERIFY hold
    expect(reply3).toEqual({ action: "block", reason: instructionPlanRevise(1) }); // PLAN block
    expect(sessions.stateOf(planKey)).toBe("working");

    // Step 5 — PLAN이 plan-v2.md 생성 후 Stop → hold + VERIFY block.
    fs.writeFileSync(path.join(taskDir, "plan-v2.md"), "Status: IN_REVIEW\n");
    let reply5: Reply | null = null;
    orchestrator.handleStop(planKey, { session_id:"s1" }, (r) => (reply5 = r), () => {});
    expect(sessions.stateOf(planKey)).toBe("parked");
    expect(reply4).toEqual({ action: "block", reason: instructionVerifyPlan(2) }); // VERIFY block
    expect(sessions.stateOf(verifyKey)).toBe("working");

    // Step 6 — VERIFY가 plan-v2-verify.md(PASS) 생성 후 Stop → VERIFY allow + notify + PLAN block(todo 지시, W5).
    fs.writeFileSync(path.join(taskDir, "plan-v2-verify.md"), "# verify\n\n판정: PASS\n");
    let reply6: Reply | null = null;
    orchestrator.handleStop(verifyKey, { session_id:"v1" }, (r) => (reply6 = r), () => {});
    expect(reply6).toEqual({ action: "allow" }); // VERIFY allow
    expect(reply5).toEqual({ action: "block", reason: instructionApproveAndTodo(2) }); // PLAN block (W5)
    expect(sessions.stateOf(planKey)).toBe("working");
    expect(sessions.stateOf(verifyKey)).toBe("idle");
    const passNotify = store.readEvents().find((e) => e.type === "notify" && e.key === "pass-v2");
    expect(passNotify).toBeDefined();

    env.cleanup();
  });
});

// T10 — W1·W4·W5·W6 시나리오 (plan-v8).
describe("T10 시나리오 (W1·W4·W5·W6)", () => {
  it("W1 — 새 작업 → plan-v1(IN_REVIEW) → PLAN Stop 한 번: bind 이벤트 + VERIFY launch + PLAN hold", () => {
    const env = setup();
    const { orchestrator, store, sessions, plansDir } = env;

    expect(orchestrator.newTask("EWE").ok).toBe(true);
    const task = store.state.activeTask!;
    const planKey = task.assigned.plan!;
    expect(sessions.stateOf(planKey)).toBe("unbound");

    // PLAN이 plan-v1.md(IN_REVIEW)를 만든 뒤 Stop.
    const w1Folder = "261111-w1";
    fs.mkdirSync(path.join(plansDir, w1Folder), { recursive: true });
    fs.writeFileSync(path.join(plansDir, w1Folder, "plan-v1.md"), "Status: IN_REVIEW\n");

    let reply: Reply | null = null;
    orchestrator.handleStop(planKey, { session_id: "s1" }, (r) => (reply = r), () => {});

    // bind — folder 바인딩 + bind 이벤트.
    expect(store.state.activeTask?.folder).toBe(w1Folder);
    expect(store.readEvents().some((e) => e.type === "bind" && e.folder === w1Folder)).toBe(true);
    // VERIFY launch + 배정.
    const verifyKey = store.state.activeTask!.assigned.verify;
    expect(verifyKey).not.toBeNull();
    expect(sessions.stateOf(verifyKey!)).toBe("launching");
    // PLAN hold — reply 아직 방출 안 됨.
    expect(sessions.stateOf(planKey)).toBe("parked");
    expect(reply).toBeNull();

    env.cleanup();
  });

  it("W1 게이트 — 작업 A 종료 → 작업 B 시작 → A의 PLAN key Stop: 즉시 allow, B folder null 유지", () => {
    const env = setup();
    const { orchestrator, store } = env;

    expect(orchestrator.newTask("EWE").ok).toBe(true);
    const planKeyA = store.state.activeTask!.assigned.plan!;
    orchestrator.closeTask();

    expect(orchestrator.newTask("EWE").ok).toBe(true);
    const taskB = store.state.activeTask!;
    expect(taskB.folder).toBeNull();
    expect(taskB.assigned.plan).not.toBe(planKeyA);

    // A의 PLAN key로 Stop — B에 배정되지 않았으므로 즉시 allow, 평가 없음.
    let reply: Reply | null = null;
    orchestrator.handleStop(planKeyA, { session_id: "s1" }, (r) => (reply = r), () => {});
    expect(reply).toEqual({ action: "allow" });
    expect(store.state.activeTask?.folder).toBeNull();

    env.cleanup();
  });

  it("W4 — VERIFY idle relaunch 허용·배정 교체·이전 키 Stop 즉시 allow, parked 409", () => {
    const env = setup();
    const { orchestrator, store, sessions, folder } = env;

    // bound 작업 + PLAN(idle)·VERIFY(idle).
    store.state.activeTask = {
      ...newActiveTask("EWE", Date.now()),
      folder,
      assigned: { plan: "plan-1", verify: "verify-1" },
    };
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
    sessions.register("verify-1", "idle");

    // VERIFY idle relaunch → 허용 + assigned.verify 교체.
    const r1 = orchestrator.relaunch("verify");
    expect(r1.ok).toBe(true);
    const newVerifyKey = store.state.activeTask!.assigned.verify!;
    expect(newVerifyKey).not.toBe("verify-1");
    expect(sessions.stateOf(newVerifyKey)).toBe("launching");

    // 이전 키 Stop → 배정되지 않으므로 즉시 allow.
    let replyOld: Reply | null = null;
    orchestrator.handleStop("verify-1", { session_id: "v1" }, (r) => (replyOld = r), () => {});
    expect(replyOld).toEqual({ action: "allow" });

    // VERIFY parked relaunch → 409.
    sessions.register(newVerifyKey, "parked");
    const r2 = orchestrator.relaunch("verify");
    expect(r2.ok).toBe(false);
    expect(r2.status).toBe(409);

    env.cleanup();
  });

  it("W4 — folder null: PLAN unbound relaunch 허용·VERIFY 409, closeTask 시 pending allow 해제", () => {
    const env = setup();
    const { orchestrator, store, sessions } = env;

    // 새 작업 (folder null, PLAN unbound).
    expect(orchestrator.newTask("EWE").ok).toBe(true);
    const planKey = store.state.activeTask!.assigned.plan!;
    expect(sessions.stateOf(planKey)).toBe("unbound");

    // PLAN unbound relaunch → 허용 (새 키 unbound).
    const r1 = orchestrator.relaunch("plan");
    expect(r1.ok).toBe(true);
    const newPlanKey = store.state.activeTask!.assigned.plan!;
    expect(newPlanKey).not.toBe(planKey);
    expect(sessions.stateOf(newPlanKey)).toBe("unbound");

    // VERIFY relaunch → 409 (folder is null).
    const r2 = orchestrator.relaunch("verify");
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe("folder is null");

    // closeTask — 배정된 세션의 pending을 allow로 해제.
    store.state.sessions[newPlanKey] = {
      role: "plan",
      project: "EWE",
      folder: null,
      launchedAt: 0,
      sessionIds: ["p2"],
      activeSessionId: "p2",
      switchedOnce: false,
    };
    let replyP: Reply | null = null;
    sessions.onStop(newPlanKey, "p2", (r) => (replyP = r), () => {});
    expect(sessions.stateOf(newPlanKey)).toBe("parked");
    orchestrator.closeTask();
    expect(replyP).toEqual({ action: "allow" });
    expect(store.state.activeTask).toBeNull();

    env.cleanup();
  });

  it("W5 — PASS(PLAN parked)→block+기록, PASS(PLAN working)→무동작, PLAN Stop block 1회→다음 allow, TODO_READY→allow+notify+pendingAction", () => {
    const env = setup();
    const { orchestrator, store, sessions, taskDir, folder } = env;

    // bound 작업 + PLAN(idle)·VERIFY(working).
    store.state.activeTask = {
      ...newActiveTask("EWE", Date.now()),
      folder,
      assigned: { plan: "plan-1", verify: "verify-1" },
    };
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

    // PLAN Stop (IN_REVIEW·verify 없음) → 행 3 hold (VERIFY working → 지시 무동작).
    let replyP1: Reply | null = null;
    orchestrator.handleStop("plan-1", { session_id: "p1" }, (r) => (replyP1 = r), () => {});
    expect(sessions.stateOf("plan-1")).toBe("parked");

    // (a) VERIFY가 PASS를 쓰고 Stop → 행 8: VERIFY allow + notify pass-v1 + PLAN block + 기록.
    fs.writeFileSync(path.join(taskDir, "plan-v1-verify.md"), "# verify\n\n판정: PASS\n");
    let replyV1: Reply | null = null;
    orchestrator.handleStop("verify-1", { session_id: "v1" }, (r) => (replyV1 = r), () => {});
    expect(replyV1).toEqual({ action: "allow" });
    expect(sessions.stateOf("verify-1")).toBe("idle");
    expect(replyP1).toEqual({ action: "block", reason: instructionApproveAndTodo(1) });
    expect(sessions.stateOf("plan-1")).toBe("working");
    expect(store.state.activeTask?.record.instructed).toContain("todo-v1");
    expect(store.readEvents().some((e) => e.type === "notify" && e.key === "pass-v1")).toBe(true);

    // (b) PLAN working일 때 PASS → PLAN에 대한 Action 없음.
    let replyV2: Reply | null = null;
    orchestrator.handleStop("verify-1", { session_id: "v1" }, (r) => (replyV2 = r), () => {});
    expect(replyV2).toEqual({ action: "allow" });
    expect(sessions.stateOf("plan-1")).toBe("working");

    // (c) 새 작업 — PLAN Stop(IN_REVIEW+PASS, 미기록) → 행 4p block 1회 → 다음 Stop allow.
    const env2 = setup();
    const { store: store2, sessions: sessions2, taskDir: taskDir2, folder: folder2 } = env2;
    store2.state.activeTask = {
      ...newActiveTask("EWE", Date.now()),
      folder: folder2,
      assigned: { plan: "plan-1", verify: "verify-1" },
    };
    store2.state.sessions["plan-1"] = {
      role: "plan",
      project: "EWE",
      folder: folder2,
      launchedAt: 0,
      sessionIds: ["p1"],
      activeSessionId: "p1",
      switchedOnce: false,
    };
    store2.state.sessions["verify-1"] = {
      role: "verify",
      project: "EWE",
      folder: folder2,
      launchedAt: 0,
      sessionIds: ["v1"],
      activeSessionId: "v1",
      switchedOnce: false,
    };
    sessions2.register("plan-1", "idle");
    sessions2.register("verify-1", "working");
    fs.mkdirSync(taskDir2, { recursive: true });
    fs.writeFileSync(path.join(taskDir2, "plan-v1.md"), "Status: IN_REVIEW\n");
    fs.writeFileSync(path.join(taskDir2, "plan-v1-verify.md"), "# verify\n\n판정: PASS\n");

    let r1: Reply | null = null;
    env2.orchestrator.handleStop("plan-1", { session_id: "p1" }, (r) => (r1 = r), () => {});
    expect(r1).toEqual({ action: "block", reason: instructionApproveAndTodo(1) });
    expect(store2.state.activeTask?.record.instructed).toContain("todo-v1");

    let r2: Reply | null = null;
    env2.orchestrator.handleStop("plan-1", { session_id: "p1" }, (r) => (r2 = r), () => {});
    expect(r2).toEqual({ action: "allow" });

    // (d) PLAN이 Status를 TODO_READY로 바꾸고 Stop → allow + notify todo-ready-v1 + pendingAction todo.
    fs.writeFileSync(path.join(taskDir2, "plan-v1.md"), "Status: TODO_READY\n");
    let r3: Reply | null = null;
    env2.orchestrator.handleStop("plan-1", { session_id: "p1" }, (r) => (r3 = r), () => {});
    expect(r3).toEqual({ action: "allow" });
    expect(store2.readEvents().some((e) => e.type === "notify" && e.key === "todo-ready-v1")).toBe(true);
    expect(env2.orchestrator.pendingAction()).toEqual({ kind: "todo" });

    env.cleanup();
    env2.cleanup();
  });

  it("W6 — 작업 A 기록이 B로 이어지지 않음: pass-v1·todo 지시 다시 나옴, A의 undelivered는 B의 pendingAction에 없음", () => {
    const env = setup();
    const { orchestrator, store, sessions, taskDir, folder, plansDir } = env;

    // 작업 A — bound + PLAN(idle)·VERIFY(working).
    store.state.activeTask = {
      ...newActiveTask("EWE", Date.now()),
      folder,
      assigned: { plan: "plan-1", verify: "verify-1" },
    };
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

    // PLAN Stop → 행 3 hold (parked).
    let replyP: Reply | null = null;
    orchestrator.handleStop("plan-1", { session_id: "p1" }, (r) => (replyP = r), () => {});
    expect(sessions.stateOf("plan-1")).toBe("parked");

    // VERIFY PASS Stop → 행 8: notify pass-v1 + PLAN block + todo-v1 기록.
    fs.writeFileSync(path.join(taskDir, "plan-v1-verify.md"), "# verify\n\n판정: PASS\n");
    orchestrator.handleStop("verify-1", { session_id: "v1" }, () => {}, () => {});
    expect(store.readEvents().some((e) => e.type === "notify" && e.key === "pass-v1")).toBe(true);
    expect(store.state.activeTask?.record.instructed).toContain("todo-v1");

    // A의 undelivered (이전 REVISE 주기 잔여 — 직접 설정).
    store.state.activeTask!.undelivered.push({ role: "plan", text: "이전 지시" });

    // A 종료 → B 시작.
    orchestrator.closeTask();
    expect(orchestrator.newTask("EWE").ok).toBe(true);
    const taskB = store.state.activeTask!;
    expect(taskB.record.notified).toEqual([]);
    expect(taskB.record.instructed).toEqual([]);
    expect(taskB.undelivered).toEqual([]);
    // A의 undelivered는 B의 pendingAction에 없음.
    expect(orchestrator.pendingAction()).toEqual({ kind: "describe" });

    // 작업 B — 같은 plan-v1 PASS → pass-v1 notify와 PLAN block이 다시 나옴.
    const folderB = "261111-w6b";
    fs.mkdirSync(path.join(plansDir, folderB), { recursive: true });
    fs.writeFileSync(path.join(plansDir, folderB, "plan-v1.md"), "Status: IN_REVIEW\n");
    fs.writeFileSync(path.join(plansDir, folderB, "plan-v1-verify.md"), "# verify\n\n판정: PASS\n");
    store.state.sessions["verify-b"] = {
      role: "verify",
      project: "EWE",
      folder: folderB,
      launchedAt: 0,
      sessionIds: ["vb"],
      activeSessionId: "vb",
      switchedOnce: false,
    };
    sessions.register("verify-b", "working");
    taskB.assigned.verify = "verify-b";

    // PLAN Stop → W1 bind + 행 4p(미기록) → block.
    const planKeyB = taskB.assigned.plan!;
    let replyB: Reply | null = null;
    orchestrator.handleStop(planKeyB, { session_id: "s2" }, (r) => (replyB = r), () => {});
    expect(taskB.folder).toBe(folderB);
    expect(replyB).toEqual({ action: "block", reason: instructionApproveAndTodo(1) });

    // VERIFY Stop → 행 8: pass-v1 notify 다시 (B의 record는 비어 있음).
    orchestrator.handleStop("verify-b", { session_id: "vb" }, () => {}, () => {});
    const passEvents = store.readEvents().filter((e) => e.type === "notify" && e.key === "pass-v1");
    expect(passEvents.length).toBeGreaterThanOrEqual(2);

    env.cleanup();
  });
});

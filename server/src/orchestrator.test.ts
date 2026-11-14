// T12 완료 조건 — (추가) PLANNER idle일 때 VERIFIER Stop(REVISE) → undelivered·notify·pendingAction.deliver → PLANNER Stop 시 삭제.
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
    roles: { planner: { endpoint: "cloud", prompt: [] }, verifier: { endpoint: "local", prompt: [] } },
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
  it("PLANNER idle일 때 VERIFIER Stop(REVISE) → undelivered·notify·pendingAction.deliver → PLANNER Stop 시 삭제", () => {
    const env = setup();
    const { orchestrator, store, sessions, taskDir, folder } = env;

    // activeTask + PLANNER(idle)·VERIFIER(working) 세션 설정 (W4 배정).
    store.state.activeTask = {
      ...newActiveTask("EWE", Date.now()),
      folder,
      assigned: { planner: "planner-1", verifier: "verifier-1" },
    };
    store.state.sessions["planner-1"] = {
      role: "planner",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["p1"],
      activeSessionId: "p1",
      switchedOnce: false,
    };
    store.state.sessions["verifier-1"] = {
      role: "verifier",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["v1"],
      activeSessionId: "v1",
      switchedOnce: false,
    };
    sessions.register("planner-1", "idle");
    sessions.register("verifier-1", "working");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: IN_REVIEW\n");
    fs.writeFileSync(path.join(taskDir, "plan-v1-verify.md"), "# verify\n\n판정: REVISE\n");

    // VERIFIER Stop → 행 6 → PLANNER(idle)에 undeliverable.
    let replyV: Reply | null = null;
    orchestrator.handleStop("verifier-1", { session_id:"v1" }, (r) => (replyV = r), () => {});
    expect(sessions.stateOf("verifier-1")).toBe("parked"); // VERIFIER hold
    expect(store.state.activeTask?.undelivered).toHaveLength(1);
    expect(store.state.activeTask?.undelivered[0].role).toBe("planner");
    expect(store.state.activeTask?.undelivered[0].text).toBe(instructionPlanRevise(1));
    expect(orchestrator.pendingAction()).toEqual({ kind: "deliver", role: "planner", text: instructionPlanRevise(1) });
    const notifyEvents = store.readEvents().filter((e) => e.type === "notify");
    expect(notifyEvents).toHaveLength(1);
    expect(notifyEvents[0].key).toBe("undeliverable-planner");

    // PLANNER Stop → undelivered 삭제 + 행 4 (IN_REVIEW·verify 있음) → allow.
    let replyP: Reply | null = null;
    orchestrator.handleStop("planner-1", { session_id:"p1" }, (r) => (replyP = r), () => {});
    expect(store.state.activeTask?.undelivered).toHaveLength(0);
    expect(replyP).toEqual({ action: "allow" });
    expect(sessions.stateOf("planner-1")).toBe("idle");

    env.cleanup();
  });

  it("PLANNER detached일 때 VERIFIER Stop(REVISE) → 새 세션 없음·배정 유지·undelivered·notify → PLANNER Stop 시 삭제", () => {
    const env = setup();
    const { orchestrator, store, sessions, taskDir, folder } = env;

    // 첫 테스트와 같은 준비 — 단 PLANNER는 detached.
    store.state.activeTask = {
      ...newActiveTask("EWE", Date.now()),
      folder,
      assigned: { planner: "planner-1", verifier: "verifier-1" },
    };
    store.state.sessions["planner-1"] = {
      role: "planner",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["p1"],
      activeSessionId: "p1",
      switchedOnce: false,
    };
    store.state.sessions["verifier-1"] = {
      role: "verifier",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["v1"],
      activeSessionId: "v1",
      switchedOnce: false,
    };
    sessions.register("planner-1", "detached");
    sessions.register("verifier-1", "working");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: IN_REVIEW\n");
    fs.writeFileSync(path.join(taskDir, "plan-v1-verify.md"), "# verify\n\n판정: REVISE\n");

    // VERIFIER Stop → 행 6 → PLANNER(detached)에 undeliverable — 새 세션 없음.
    let replyV: Reply | null = null;
    orchestrator.handleStop("verifier-1", { session_id:"v1" }, (r) => (replyV = r), () => {});
    expect(env.launchCalls.length).toBe(0);
    expect(store.state.activeTask?.assigned.planner).toBe("planner-1");
    expect(store.state.activeTask?.undelivered).toHaveLength(1);
    expect(store.state.activeTask?.undelivered[0].role).toBe("planner");
    expect(store.state.activeTask?.undelivered[0].text).toBe(instructionPlanRevise(1));
    const notifyEvents = store.readEvents().filter((e) => e.type === "notify");
    expect(notifyEvents).toHaveLength(1);
    expect(notifyEvents[0].key).toBe("undeliverable-planner");

    // PLANNER Stop → undelivered 삭제 + 행 4 (IN_REVIEW·verify 있음) → allow.
    let replyP: Reply | null = null;
    orchestrator.handleStop("planner-1", { session_id:"p1" }, (r) => (replyP = r), () => {});
    expect(store.state.activeTask?.undelivered).toHaveLength(0);
    expect(replyP).toEqual({ action: "allow" });

    env.cleanup();
  });
});

describe("A — Stop 처리 밖 상태 변경 브로드캐스트", () => {
  it("close → detached 시 onChange → hub에 state 브로드캐스트 1회 (assignedDisplay.planner disconnected)", () => {
    const env = setup();
    const { orchestrator, store, sessions, folder } = env;

    store.state.activeTask = {
      ...newActiveTask("EWE", Date.now()),
      folder,
      assigned: { planner: "planner-1", verifier: null },
    };
    store.state.sessions["planner-1"] = {
      role: "planner",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["p1"],
      activeSessionId: "p1",
      switchedOnce: false,
    };

    let closeCb: (() => void) | null = null;
    sessions.onStop("planner-1", "p1", () => {}, (cb) => (closeCb = cb));

    const writes: string[] = [];
    orchestrator.getHub().add({ write: (raw) => writes.push(raw), close: () => {} });

    closeCb!();
    expect(writes).toHaveLength(1);
    expect(writes[0].startsWith("event: state\n")).toBe(true);
    const state = JSON.parse(writes[0].split("data: ")[1]);
    expect(state.assignedDisplay.planner).toBe("disconnected");

    env.cleanup();
  });
});

describe("시나리오 (launcher·파일 주입)", () => {
  it("새 작업 → PLANNER Stop allow → bind+hold+VERIFIER launch → REVISE block → … → PASS: VERIFIER allow + notify + PLANNER block(todo 지시)", () => {
    const env = setup();
    const { orchestrator, store, sessions, plansDir, folder, taskDir } = env;

    // Step 0 — 새 작업.
    expect(orchestrator.newTask("EWE").ok).toBe(true);
    expect(store.state.activeTask?.project).toBe("EWE");
    expect(store.state.activeTask?.folder).toBeNull();
    const planKey = Object.keys(store.state.sessions).find((k) => store.state.sessions[k].role === "planner")!;
    expect(sessions.stateOf(planKey)).toBe("unbound");

    // Step 1 — PLANNER Stop (folder 없음) → allow.
    let reply1: Reply | null = null;
    orchestrator.handleStop(planKey, { session_id:"s1" }, (r) => (reply1 = r), () => {});
    expect(reply1).toEqual({ action: "allow" });
    expect(sessions.stateOf(planKey)).toBe("idle");

    // Step 2 — PLANNER가 plan-v1.md 생성 후 Stop → bind + hold + VERIFIER launch 한 번에 (W1).
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: IN_REVIEW\n");
    let reply2: Reply | null = null;
    orchestrator.handleStop(planKey, { session_id:"s1" }, (r) => (reply2 = r), () => {});
    expect(store.state.activeTask?.folder).toBe(folder);
    expect(store.state.sessions[planKey].folder).toBe(folder);
    expect(sessions.stateOf(planKey)).toBe("parked"); // hold — reply 아직 방출 안 됨
    const verifyKey = Object.keys(store.state.sessions).find((k) => store.state.sessions[k].role === "verifier")!;
    expect(verifyKey).toBeDefined();
    expect(sessions.stateOf(verifyKey)).toBe("working");

    // Step 3 — PLANNER가 다시 Stop → 이전 pending을 allow로 방출 + 재 hold (VERIFIER working).
    let reply3: Reply | null = null;
    orchestrator.handleStop(planKey, { session_id:"s1" }, (r) => (reply3 = r), () => {});
    expect(reply2).toEqual({ action: "allow" }); // Step 2의 pending 방출
    expect(sessions.stateOf(planKey)).toBe("parked");

    // Step 4 — VERIFIER가 plan-v1-verify.md(REVISE) 생성 후 Stop → PLANNER block + VERIFIER hold.
    fs.writeFileSync(path.join(taskDir, "plan-v1-verify.md"), "# verify\n\n판정: REVISE\n");
    let reply4: Reply | null = null;
    orchestrator.handleStop(verifyKey, { session_id:"v1" }, (r) => (reply4 = r), () => {});
    expect(sessions.stateOf(verifyKey)).toBe("parked"); // VERIFIER hold
    expect(reply3).toEqual({ action: "block", reason: instructionPlanRevise(1) }); // PLANNER block
    expect(sessions.stateOf(planKey)).toBe("working");

    // Step 5 — PLANNER가 plan-v2.md 생성 후 Stop → hold + VERIFIER block.
    fs.writeFileSync(path.join(taskDir, "plan-v2.md"), "Status: IN_REVIEW\n");
    let reply5: Reply | null = null;
    orchestrator.handleStop(planKey, { session_id:"s1" }, (r) => (reply5 = r), () => {});
    expect(sessions.stateOf(planKey)).toBe("parked");
    expect(reply4).toEqual({ action: "block", reason: instructionVerifyPlan(2) }); // VERIFIER block
    expect(sessions.stateOf(verifyKey)).toBe("working");

    // Step 6 — VERIFIER가 plan-v2-verify.md(PASS) 생성 후 Stop → VERIFIER allow + notify + PLANNER block(todo 지시, W5).
    fs.writeFileSync(path.join(taskDir, "plan-v2-verify.md"), "# verify\n\n판정: PASS\n");
    let reply6: Reply | null = null;
    orchestrator.handleStop(verifyKey, { session_id:"v1" }, (r) => (reply6 = r), () => {});
    expect(reply6).toEqual({ action: "allow" }); // VERIFIER allow
    expect(reply5).toEqual({ action: "block", reason: instructionApproveAndTodo(2) }); // PLANNER block (W5)
    expect(sessions.stateOf(planKey)).toBe("working");
    expect(sessions.stateOf(verifyKey)).toBe("idle");
    const passNotify = store.readEvents().find((e) => e.type === "notify" && e.key === "pass-v2");
    expect(passNotify).toBeDefined();

    env.cleanup();
  });
});

// T10 — W1·W4·W5·W6 시나리오 (plan-v8).
describe("T10 시나리오 (W1·W4·W5·W6)", () => {
  it("W1 — 새 작업 → plan-v1(IN_REVIEW) → PLANNER Stop 한 번: bind 이벤트 + VERIFIER launch + PLANNER hold", () => {
    const env = setup();
    const { orchestrator, store, sessions, plansDir } = env;

    expect(orchestrator.newTask("EWE").ok).toBe(true);
    const task = store.state.activeTask!;
    const planKey = task.assigned.planner!;
    expect(sessions.stateOf(planKey)).toBe("unbound");

    // PLANNER가 plan-v1.md(IN_REVIEW)를 만든 뒤 Stop.
    const w1Folder = "261111-w1";
    fs.mkdirSync(path.join(plansDir, w1Folder), { recursive: true });
    fs.writeFileSync(path.join(plansDir, w1Folder, "plan-v1.md"), "Status: IN_REVIEW\n");

    let reply: Reply | null = null;
    orchestrator.handleStop(planKey, { session_id: "s1" }, (r) => (reply = r), () => {});

    // bind — folder 바인딩 + bind 이벤트.
    expect(store.state.activeTask?.folder).toBe(w1Folder);
    expect(store.readEvents().some((e) => e.type === "bind" && e.folder === w1Folder)).toBe(true);
    // VERIFIER launch + 배정.
    const verifyKey = store.state.activeTask!.assigned.verifier;
    expect(verifyKey).not.toBeNull();
    expect(sessions.stateOf(verifyKey!)).toBe("working");
    // PLANNER hold — reply 아직 방출 안 됨.
    expect(sessions.stateOf(planKey)).toBe("parked");
    expect(reply).toBeNull();

    env.cleanup();
  });

  it("W1 게이트 — 작업 A 종료 → 작업 B 시작 → A의 PLANNER key Stop: 즉시 allow, B folder null 유지", () => {
    const env = setup();
    const { orchestrator, store } = env;

    expect(orchestrator.newTask("EWE").ok).toBe(true);
    const planKeyA = store.state.activeTask!.assigned.planner!;
    orchestrator.closeTask();

    expect(orchestrator.newTask("EWE").ok).toBe(true);
    const taskB = store.state.activeTask!;
    expect(taskB.folder).toBeNull();
    expect(taskB.assigned.planner).not.toBe(planKeyA);

    // A의 PLANNER key로 Stop — B에 배정되지 않았으므로 즉시 allow, 평가 없음.
    let reply: Reply | null = null;
    orchestrator.handleStop(planKeyA, { session_id: "s1" }, (r) => (reply = r), () => {});
    expect(reply).toEqual({ action: "allow" });
    expect(store.state.activeTask?.folder).toBeNull();

    env.cleanup();
  });

  it("W4 — VERIFIER idle relaunch 허용·배정 교체·이전 키 Stop 즉시 allow, parked 409", () => {
    const env = setup();
    const { orchestrator, store, sessions, folder } = env;

    // bound 작업 + PLANNER(idle)·VERIFIER(idle).
    store.state.activeTask = {
      ...newActiveTask("EWE", Date.now()),
      folder,
      assigned: { planner: "planner-1", verifier: "verifier-1" },
    };
    store.state.sessions["planner-1"] = {
      role: "planner",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["p1"],
      activeSessionId: "p1",
      switchedOnce: false,
    };
    store.state.sessions["verifier-1"] = {
      role: "verifier",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["v1"],
      activeSessionId: "v1",
      switchedOnce: false,
    };
    sessions.register("planner-1", "idle");
    sessions.register("verifier-1", "idle");

    // VERIFIER idle relaunch → 허용 + assigned.verifier 교체.
    const r1 = orchestrator.relaunch("verifier");
    expect(r1.ok).toBe(true);
    const newVerifyKey = store.state.activeTask!.assigned.verifier!;
    expect(newVerifyKey).not.toBe("verifier-1");
    expect(sessions.stateOf(newVerifyKey)).toBe("working");

    // 이전 키 Stop → 배정되지 않으므로 즉시 allow.
    let replyOld: Reply | null = null;
    orchestrator.handleStop("verifier-1", { session_id: "v1" }, (r) => (replyOld = r), () => {});
    expect(replyOld).toEqual({ action: "allow" });

    // VERIFIER parked relaunch → 409.
    sessions.register(newVerifyKey, "parked");
    const r2 = orchestrator.relaunch("verifier");
    expect(r2.ok).toBe(false);
    expect(r2.status).toBe(409);

    env.cleanup();
  });

  it("W4 — folder null: PLANNER unbound relaunch 허용·VERIFIER 409, closeTask 시 pending allow 해제", () => {
    const env = setup();
    const { orchestrator, store, sessions } = env;

    // 새 작업 (folder null, PLANNER unbound).
    expect(orchestrator.newTask("EWE").ok).toBe(true);
    const planKey = store.state.activeTask!.assigned.planner!;
    expect(sessions.stateOf(planKey)).toBe("unbound");

    // PLANNER unbound relaunch → 허용 (새 키 unbound).
    const r1 = orchestrator.relaunch("planner");
    expect(r1.ok).toBe(true);
    const newPlanKey = store.state.activeTask!.assigned.planner!;
    expect(newPlanKey).not.toBe(planKey);
    expect(sessions.stateOf(newPlanKey)).toBe("unbound");

    // VERIFIER relaunch → 409 (folder is null).
    const r2 = orchestrator.relaunch("verifier");
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe("folder is null");

    // closeTask — 배정된 세션의 pending을 allow로 해제.
    store.state.sessions[newPlanKey] = {
      role: "planner",
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

  it("W5 — PASS(PLANNER parked)→block+기록, PASS(PLANNER working)→무동작, PLANNER Stop block 1회→다음 allow, TODO_READY→allow+notify+pendingAction", () => {
    const env = setup();
    const { orchestrator, store, sessions, taskDir, folder } = env;

    // bound 작업 + PLANNER(idle)·VERIFIER(working).
    store.state.activeTask = {
      ...newActiveTask("EWE", Date.now()),
      folder,
      assigned: { planner: "planner-1", verifier: "verifier-1" },
    };
    store.state.sessions["planner-1"] = {
      role: "planner",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["p1"],
      activeSessionId: "p1",
      switchedOnce: false,
    };
    store.state.sessions["verifier-1"] = {
      role: "verifier",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["v1"],
      activeSessionId: "v1",
      switchedOnce: false,
    };
    sessions.register("planner-1", "idle");
    sessions.register("verifier-1", "working");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: IN_REVIEW\n");

    // PLANNER Stop (IN_REVIEW·verify 없음) → 행 3 hold (VERIFIER working → 지시 무동작).
    let replyP1: Reply | null = null;
    orchestrator.handleStop("planner-1", { session_id: "p1" }, (r) => (replyP1 = r), () => {});
    expect(sessions.stateOf("planner-1")).toBe("parked");

    // (a) VERIFIER가 PASS를 쓰고 Stop → 행 8: VERIFIER allow + notify pass-v1 + PLANNER block + 기록.
    fs.writeFileSync(path.join(taskDir, "plan-v1-verify.md"), "# verify\n\n판정: PASS\n");
    let replyV1: Reply | null = null;
    orchestrator.handleStop("verifier-1", { session_id: "v1" }, (r) => (replyV1 = r), () => {});
    expect(replyV1).toEqual({ action: "allow" });
    expect(sessions.stateOf("verifier-1")).toBe("idle");
    expect(replyP1).toEqual({ action: "block", reason: instructionApproveAndTodo(1) });
    expect(sessions.stateOf("planner-1")).toBe("working");
    expect(store.state.activeTask?.record.instructed).toContain("todo-v1");
    expect(store.readEvents().some((e) => e.type === "notify" && e.key === "pass-v1")).toBe(true);

    // (b) PLANNER working일 때 PASS → PLANNER에 대한 Action 없음.
    let replyV2: Reply | null = null;
    orchestrator.handleStop("verifier-1", { session_id: "v1" }, (r) => (replyV2 = r), () => {});
    expect(replyV2).toEqual({ action: "allow" });
    expect(sessions.stateOf("planner-1")).toBe("working");

    // (c) 새 작업 — PLANNER Stop(IN_REVIEW+PASS, 미기록) → 행 4p block 1회 → 다음 Stop allow.
    const env2 = setup();
    const { store: store2, sessions: sessions2, taskDir: taskDir2, folder: folder2 } = env2;
    store2.state.activeTask = {
      ...newActiveTask("EWE", Date.now()),
      folder: folder2,
      assigned: { planner: "planner-1", verifier: "verifier-1" },
    };
    store2.state.sessions["planner-1"] = {
      role: "planner",
      project: "EWE",
      folder: folder2,
      launchedAt: 0,
      sessionIds: ["p1"],
      activeSessionId: "p1",
      switchedOnce: false,
    };
    store2.state.sessions["verifier-1"] = {
      role: "verifier",
      project: "EWE",
      folder: folder2,
      launchedAt: 0,
      sessionIds: ["v1"],
      activeSessionId: "v1",
      switchedOnce: false,
    };
    sessions2.register("planner-1", "idle");
    sessions2.register("verifier-1", "working");
    fs.mkdirSync(taskDir2, { recursive: true });
    fs.writeFileSync(path.join(taskDir2, "plan-v1.md"), "Status: IN_REVIEW\n");
    fs.writeFileSync(path.join(taskDir2, "plan-v1-verify.md"), "# verify\n\n판정: PASS\n");

    let r1: Reply | null = null;
    env2.orchestrator.handleStop("planner-1", { session_id: "p1" }, (r) => (r1 = r), () => {});
    expect(r1).toEqual({ action: "block", reason: instructionApproveAndTodo(1) });
    expect(store2.state.activeTask?.record.instructed).toContain("todo-v1");

    let r2: Reply | null = null;
    env2.orchestrator.handleStop("planner-1", { session_id: "p1" }, (r) => (r2 = r), () => {});
    expect(r2).toEqual({ action: "allow" });

    // (d) PLANNER가 Status를 TODO_READY로 바꾸고 Stop → allow + notify todo-ready-v1 + pendingAction todo.
    fs.writeFileSync(path.join(taskDir2, "plan-v1.md"), "Status: TODO_READY\n");
    let r3: Reply | null = null;
    env2.orchestrator.handleStop("planner-1", { session_id: "p1" }, (r) => (r3 = r), () => {});
    expect(r3).toEqual({ action: "allow" });
    expect(store2.readEvents().some((e) => e.type === "notify" && e.key === "todo-ready-v1")).toBe(true);
    expect(env2.orchestrator.pendingAction()).toEqual({ kind: "todo" });

    env.cleanup();
    env2.cleanup();
  });

  it("W6 — 작업 A 기록이 B로 이어지지 않음: pass-v1·todo 지시 다시 나옴, A의 undelivered는 B의 pendingAction에 없음", () => {
    const env = setup();
    const { orchestrator, store, sessions, taskDir, folder, plansDir } = env;

    // 작업 A — bound + PLANNER(idle)·VERIFIER(working).
    store.state.activeTask = {
      ...newActiveTask("EWE", Date.now()),
      folder,
      assigned: { planner: "planner-1", verifier: "verifier-1" },
    };
    store.state.sessions["planner-1"] = {
      role: "planner",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["p1"],
      activeSessionId: "p1",
      switchedOnce: false,
    };
    store.state.sessions["verifier-1"] = {
      role: "verifier",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["v1"],
      activeSessionId: "v1",
      switchedOnce: false,
    };
    sessions.register("planner-1", "idle");
    sessions.register("verifier-1", "working");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: IN_REVIEW\n");

    // PLANNER Stop → 행 3 hold (parked).
    let replyP: Reply | null = null;
    orchestrator.handleStop("planner-1", { session_id: "p1" }, (r) => (replyP = r), () => {});
    expect(sessions.stateOf("planner-1")).toBe("parked");

    // VERIFIER PASS Stop → 행 8: notify pass-v1 + PLANNER block + todo-v1 기록.
    fs.writeFileSync(path.join(taskDir, "plan-v1-verify.md"), "# verify\n\n판정: PASS\n");
    orchestrator.handleStop("verifier-1", { session_id: "v1" }, () => {}, () => {});
    expect(store.readEvents().some((e) => e.type === "notify" && e.key === "pass-v1")).toBe(true);
    expect(store.state.activeTask?.record.instructed).toContain("todo-v1");

    // A의 undelivered (이전 REVISE 주기 잔여 — 직접 설정).
    store.state.activeTask!.undelivered.push({ role: "planner", text: "이전 지시" });

    // A 종료 → B 시작.
    orchestrator.closeTask();
    expect(orchestrator.newTask("EWE").ok).toBe(true);
    const taskB = store.state.activeTask!;
    expect(taskB.record.notified).toEqual([]);
    expect(taskB.record.instructed).toEqual([]);
    expect(taskB.undelivered).toEqual([]);
    // A의 undelivered는 B의 pendingAction에 없음.
    expect(orchestrator.pendingAction()).toEqual({ kind: "describe" });

    // 작업 B — 같은 plan-v1 PASS → pass-v1 notify와 PLANNER block이 다시 나옴.
    const folderB = "261111-w6b";
    fs.mkdirSync(path.join(plansDir, folderB), { recursive: true });
    fs.writeFileSync(path.join(plansDir, folderB, "plan-v1.md"), "Status: IN_REVIEW\n");
    fs.writeFileSync(path.join(plansDir, folderB, "plan-v1-verify.md"), "# verify\n\n판정: PASS\n");
    store.state.sessions["verifier-b"] = {
      role: "verifier",
      project: "EWE",
      folder: folderB,
      launchedAt: 0,
      sessionIds: ["vb"],
      activeSessionId: "vb",
      switchedOnce: false,
    };
    sessions.register("verifier-b", "working");
    taskB.assigned.verifier = "verifier-b";

    // PLANNER Stop → W1 bind + 행 4p(미기록) → block.
    const planKeyB = taskB.assigned.planner!;
    let replyB: Reply | null = null;
    orchestrator.handleStop(planKeyB, { session_id: "s2" }, (r) => (replyB = r), () => {});
    expect(taskB.folder).toBe(folderB);
    expect(replyB).toEqual({ action: "block", reason: instructionApproveAndTodo(1) });

    // VERIFIER Stop → 행 8: pass-v1 notify 다시 (B의 record는 비어 있음).
    orchestrator.handleStop("verifier-b", { session_id: "vb" }, () => {}, () => {});
    const passEvents = store.readEvents().filter((e) => e.type === "notify" && e.key === "pass-v1");
    expect(passEvents.length).toBeGreaterThanOrEqual(2);

    env.cleanup();
  });
});

// T7 — 표시 상태 계산 (assignedDisplay, plan-v3 §3 B 규칙 1~6).
describe("T7 — 표시 상태 (assignedDisplay)", () => {
  it("배정 없음 → null", () => {
    const env = setup();
    const { orchestrator, store } = env;
    store.state.activeTask = { ...newActiveTask("EWE", Date.now()), folder: "261111-alpha" }; // assigned.planner·verifier null
    const st = orchestrator.getState();
    expect(st.assignedDisplay.planner).toBeNull();
    expect(st.assignedDisplay.verifier).toBeNull();
    env.cleanup();
  });

  it("detached(미등록) → disconnected", () => {
    const env = setup();
    const { orchestrator, store } = env;
    store.state.activeTask = {
      ...newActiveTask("EWE", Date.now()),
      folder: "261111-alpha",
      assigned: { planner: "planner-1", verifier: null },
    };
    // planner-1 미등록 → stateOf undefined → detached → disconnected.
    expect(orchestrator.getState().assignedDisplay.planner).toBe("disconnected");
    env.cleanup();
  });

  it("working → working", () => {
    const env = setup();
    const { orchestrator, store, sessions } = env;
    store.state.activeTask = {
      ...newActiveTask("EWE", Date.now()),
      folder: "261111-alpha",
      assigned: { planner: "planner-1", verifier: null },
    };
    sessions.register("planner-1", "working");
    expect(orchestrator.getState().assignedDisplay.planner).toBe("working");
    env.cleanup();
  });

  it("parked → waiting", () => {
    const env = setup();
    const { orchestrator, store, sessions } = env;
    store.state.activeTask = {
      ...newActiveTask("EWE", Date.now()),
      folder: "261111-alpha",
      assigned: { planner: "planner-1", verifier: null },
    };
    sessions.register("planner-1", "parked");
    expect(orchestrator.getState().assignedDisplay.planner).toBe("waiting");
    env.cleanup();
  });

  it("unbound(새 작업 PLANNER) → your-turn", () => {
    const env = setup();
    const { orchestrator, store, sessions } = env;
    store.state.activeTask = {
      ...newActiveTask("EWE", Date.now()),
      folder: null,
      assigned: { planner: "planner-1", verifier: null },
    };
    sessions.register("planner-1", "unbound");
    expect(orchestrator.getState().assignedDisplay.planner).toBe("your-turn");
    env.cleanup();
  });

  it("PLANNER idle + decision → your-turn", () => {
    const env = setup();
    const { orchestrator, store, sessions, taskDir } = env;
    store.state.activeTask = {
      ...newActiveTask("EWE", Date.now()),
      folder: "261111-alpha",
      assigned: { planner: "planner-1", verifier: null },
    };
    sessions.register("planner-1", "idle");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: NEEDS_DECISION\n"); // pendingAction → decision
    expect(orchestrator.getState().assignedDisplay.planner).toBe("your-turn");
    env.cleanup();
  });

  it("VERIFIER idle + decision → idle (decision은 PLANNER 대상)", () => {
    const env = setup();
    const { orchestrator, store, sessions, taskDir } = env;
    store.state.activeTask = {
      ...newActiveTask("EWE", Date.now()),
      folder: "261111-alpha",
      assigned: { planner: "planner-1", verifier: "verifier-1" },
    };
    sessions.register("planner-1", "idle");
    sessions.register("verifier-1", "idle");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: NEEDS_DECISION\n"); // pendingAction → decision
    const st = orchestrator.getState();
    expect(st.assignedDisplay.planner).toBe("your-turn");
    expect(st.assignedDisplay.verifier).toBe("idle");
    env.cleanup();
  });

  it("VERIFIER idle + deliver(verifier) → your-turn", () => {
    const env = setup();
    const { orchestrator, store, sessions } = env;
    store.state.activeTask = {
      ...newActiveTask("EWE", Date.now()),
      folder: "261111-alpha",
      assigned: { planner: "planner-1", verifier: "verifier-1" },
      undelivered: [{ role: "verifier", text: "지시 문장" }], // pendingAction → deliver(verifier)
    };
    sessions.register("planner-1", "idle");
    sessions.register("verifier-1", "idle");
    expect(orchestrator.getState().assignedDisplay.verifier).toBe("your-turn");
    env.cleanup();
  });
});

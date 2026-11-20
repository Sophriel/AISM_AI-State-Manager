// T12 완료 조건 — (추가) PLANNER idle일 때 VERIFIER Stop(REVISE) → undelivered·notify·pendingAction.deliver → PLANNER Stop 시 삭제.
// 그리고 launcher·파일 읽기 주입 시나리오: 새 작업 → … → PASS.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import type { AismConfig } from "./config.js";
import { AISM_ROOT, loadConfig } from "./config.js";
import { Store, type Task } from "./store.js";
import { Sessions } from "./sessions.js";
import { Orchestrator } from "./orchestrator.js";
import {
  instructionApproveAndTodo,
  instructionPlanRevise,
  instructionVerifyPlan,
  instructionReviewTodo,
  instructionTodoRevise,
  instructionChecklist,
  instructionCommitPlan,
  type Reply,
} from "./machine.js";
import { shouldToast } from "./toast.js";
import type { LaunchOptions } from "./launcher.js";

type Timer = ReturnType<typeof setTimeout>;

function setup(opts: {
  gitInfo?: (root: string) => { branch: string | null } | null;
  configPath?: string;
  updateConfig?: (p: string, mutate: (d: Record<string, unknown>) => void) => boolean;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aism-orch-"));
  const plansDir = path.join(root, ".claude/plans");
  const folder = "261111-alpha";
  fs.mkdirSync(plansDir, { recursive: true });

  const config: AismConfig = {
    port: 4400,
    endpoints: { cloud: {}, local: {} },
    roles: {
      planner: { endpoint: "cloud", prompt: [] },
      verifier: { endpoint: "local", prompt: [] },
      coder: { endpoint: "local", prompt: [] },
    },
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
        task: opts.task,
      };
    }
    return { sessionKey, dir: "/fake" };
  };

  const toasts: string[] = [];
  let gitInfoImpl: (root: string) => { branch: string | null } | null = opts.gitInfo ?? (() => null);
  const orchestrator = new Orchestrator({
    config,
    store,
    sessions,
    launch: fakeLaunch,
    aismRoot: root,
    toast: (_t, m) => toasts.push(m),
    gitInfo: (r) => gitInfoImpl(r),
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
    ...(opts.updateConfig !== undefined ? { updateConfig: opts.updateConfig } : {}),
  });

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
    toasts,
    setGitInfo: (fn: (root: string) => { branch: string | null } | null) => {
      gitInfoImpl = fn;
    },
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(storeDir, { recursive: true, force: true });
    },
  };
}

// T3 — 작업 시드 도우미. ID t-test-<n>, tasks에 넣고 반환.
let taskSeq = 0;
function seedTask(store: Store, partial?: Partial<Task>): Task {
  const id = `t-test-${++taskSeq}`;
  const task: Task = {
    id,
    project: "EWE",
    folder: null,
    startedAt: Date.now(),
    assigned: { planner: null, verifier: null, coder: null },
    record: { notified: [], consecutiveBlocks: {}, instructed: [] },
    undelivered: [],
    ...partial,
  };
  store.state.tasks[id] = task;
  return task;
}

describe("undeliverable (C2-1)", () => {
  it("PLANNER idle일 때 VERIFIER Stop(REVISE) → undelivered·notify·pendingAction.deliver → PLANNER Stop 시 삭제", () => {
    const env = setup();
    const { orchestrator, store, sessions, taskDir, folder } = env;

    // task + PLANNER(idle)·VERIFIER(working) 세션 설정 (W4 배정).
    const task = seedTask(store, {
      folder,
      assigned: { planner: "planner-1", verifier: "verifier-1", coder: null },
    });
    store.state.sessions["planner-1"] = {
      role: "planner",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["p1"],
      activeSessionId: "p1",
      switchedOnce: false,
      task: task.id,
    };
    store.state.sessions["verifier-1"] = {
      role: "verifier",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["v1"],
      activeSessionId: "v1",
      switchedOnce: false,
      task: task.id,
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
    expect(task.undelivered).toHaveLength(1);
    expect(task.undelivered[0].role).toBe("planner");
    expect(task.undelivered[0].text).toBe(instructionPlanRevise(1));
    expect(orchestrator.pendingAction(task)).toEqual({ kind: "deliver", role: "planner", text: instructionPlanRevise(1) });
    const notifyEvents = store.readTaskEvents(task.id).filter((e) => e.type === "notify");
    expect(notifyEvents).toHaveLength(1);
    expect(notifyEvents[0].key).toBe("undeliverable-planner");

    // PLANNER Stop → undelivered 삭제 + 행 4 (IN_REVIEW·verify 있음) → allow.
    let replyP: Reply | null = null;
    orchestrator.handleStop("planner-1", { session_id:"p1" }, (r) => (replyP = r), () => {});
    expect(task.undelivered).toHaveLength(0);
    expect(replyP).toEqual({ action: "allow" });
    expect(sessions.stateOf("planner-1")).toBe("idle");

    env.cleanup();
  });

  it("PLANNER detached일 때 VERIFIER Stop(REVISE) → 새 세션 없음·배정 유지·undelivered·notify → PLANNER Stop 시 삭제", () => {
    const env = setup();
    const { orchestrator, store, sessions, taskDir, folder } = env;

    // 첫 테스트와 같은 준비 — 단 PLANNER는 detached.
    const task = seedTask(store, {
      folder,
      assigned: { planner: "planner-1", verifier: "verifier-1", coder: null },
    });
    store.state.sessions["planner-1"] = {
      role: "planner",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["p1"],
      activeSessionId: "p1",
      switchedOnce: false,
      task: task.id,
    };
    store.state.sessions["verifier-1"] = {
      role: "verifier",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["v1"],
      activeSessionId: "v1",
      switchedOnce: false,
      task: task.id,
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
    expect(task.assigned.planner).toBe("planner-1");
    expect(task.undelivered).toHaveLength(1);
    expect(task.undelivered[0].role).toBe("planner");
    expect(task.undelivered[0].text).toBe(instructionPlanRevise(1));
    const notifyEvents = store.readTaskEvents(task.id).filter((e) => e.type === "notify");
    expect(notifyEvents).toHaveLength(1);
    expect(notifyEvents[0].key).toBe("undeliverable-planner");

    // PLANNER Stop → undelivered 삭제 + 행 4 (IN_REVIEW·verify 있음) → allow.
    let replyP: Reply | null = null;
    orchestrator.handleStop("planner-1", { session_id:"p1" }, (r) => (replyP = r), () => {});
    expect(task.undelivered).toHaveLength(0);
    expect(replyP).toEqual({ action: "allow" });

    env.cleanup();
  });
});

describe("A — Stop 처리 밖 상태 변경 브로드캐스트", () => {
  it("close → detached 시 onChange → hub에 state 브로드캐스트 1회 (assignedDisplay.planner disconnected)", () => {
    const env = setup();
    const { orchestrator, store, sessions, folder } = env;

    const task = seedTask(store, {
      folder,
      assigned: { planner: "planner-1", verifier: null, coder: null },
    });
    store.state.sessions["planner-1"] = {
      role: "planner",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["p1"],
      activeSessionId: "p1",
      switchedOnce: false,
      task: task.id,
    };

    let closeCb: (() => void) | null = null;
    sessions.onStop("planner-1", "p1", () => {}, (cb) => (closeCb = cb));

    // T5 — state는 그 작업 채널에만. 클라이언트를 작업 채널에 부착.
    const writes: string[] = [];
    orchestrator.getHub().add({ write: (raw) => writes.push(raw), close: () => {} }, task.id);

    closeCb!();
    expect(writes).toHaveLength(1);
    expect(writes[0].startsWith("event: state\n")).toBe(true);
    const state = JSON.parse(writes[0].split("data: ")[1]);
    expect(state.assignedDisplay.planner).toBe("disconnected");

    env.cleanup();
  });
});

describe("CODER 배정 게이트", () => {
  it("CODER 배정 세션의 Stop은 배정 게이트를 통과한다", () => {
    const env = setup();
    const { orchestrator, store, sessions, taskDir, folder } = env;

    const task = seedTask(store, {
      folder,
      assigned: { planner: "planner-1", verifier: null, coder: "coder-1" },
    });
    store.state.sessions["coder-1"] = {
      role: "coder",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["c1"],
      activeSessionId: "c1",
      switchedOnce: false,
      task: task.id,
    };
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: IN_PROGRESS\n");

    let reply: Reply | null = null;
    orchestrator.handleStop("coder-1", { session_id: "c1" }, (r) => (reply = r), () => {});

    // stop·reply는 그 세션 작업 파일에 (T4). stop 다음에 reply.
    const taskEvents = store.readTaskEvents(task.id);
    const stopIdx = taskEvents.findIndex((e) => e.type === "stop" && e.sessionKey === "coder-1");
    const replyIdx = taskEvents.findIndex((e) => e.type === "reply" && e.sessionKey === "coder-1");
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(replyIdx).toBeGreaterThan(stopIdx);
    expect(sessions.stateOf("coder-1")).toBe("idle");

    // c7 — IN_PROGRESS Stop → coder-stopped 알림 (todo 없음 → T null). notify는 그 작업 파일 (T5).
    expect(store.readTaskEvents(task.id).some((e) => e.type === "notify" && e.key === "coder-stopped-vnull")).toBe(true);

    env.cleanup();
  });
});

describe("시나리오 (launcher·파일 주입)", () => {
  it("새 작업 → PLANNER Stop allow → bind+hold+VERIFIER launch → REVISE block → … → PASS: VERIFIER allow + notify + PLANNER block(todo 지시)", () => {
    const env = setup();
    const { orchestrator, store, sessions, plansDir, folder, taskDir } = env;

    // Step 0 — 새 작업.
    const r0 = orchestrator.newTask("EWE");
    expect(r0.ok).toBe(true);
    const task = store.state.tasks[r0.taskId!]!;
    expect(task.project).toBe("EWE");
    expect(task.folder).toBeNull();
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
    expect(task.folder).toBe(folder);
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
    const passNotify = store.readTaskEvents(task.id).find((e) => e.type === "notify" && e.key === "pass-v2");
    expect(passNotify).toBeDefined();

    env.cleanup();
  });
});

// T10 — W1·W4·W5·W6 시나리오 (plan-v8).
describe("T10 시나리오 (W1·W4·W5·W6)", () => {
  it("W1 — 새 작업 → plan-v1(IN_REVIEW) → PLANNER Stop 한 번: bind 이벤트 + VERIFIER launch + PLANNER hold", () => {
    const env = setup();
    const { orchestrator, store, sessions, plansDir } = env;

    const r0 = orchestrator.newTask("EWE");
    expect(r0.ok).toBe(true);
    const task = store.state.tasks[r0.taskId!]!;
    const planKey = task.assigned.planner!;
    expect(sessions.stateOf(planKey)).toBe("unbound");

    // PLANNER가 plan-v1.md(IN_REVIEW)를 만든 뒤 Stop.
    const w1Folder = "261111-w1";
    fs.mkdirSync(path.join(plansDir, w1Folder), { recursive: true });
    fs.writeFileSync(path.join(plansDir, w1Folder, "plan-v1.md"), "Status: IN_REVIEW\n");

    let reply: Reply | null = null;
    orchestrator.handleStop(planKey, { session_id: "s1" }, (r) => (reply = r), () => {});

    // bind — folder 바인딩 + bind 이벤트 (작업 파일, T4).
    expect(task.folder).toBe(w1Folder);
    expect(store.readTaskEvents(task.id).some((e) => e.type === "bind" && e.folder === w1Folder)).toBe(true);
    // VERIFIER launch + 배정.
    const verifyKey = task.assigned.verifier;
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

    const rA = orchestrator.newTask("EWE");
    expect(rA.ok).toBe(true);
    const planKeyA = store.state.tasks[rA.taskId!]!.assigned.planner!;
    orchestrator.closeTask(rA.taskId!);

    const rB = orchestrator.newTask("EWE");
    expect(rB.ok).toBe(true);
    const taskB = store.state.tasks[rB.taskId!]!;
    expect(taskB.folder).toBeNull();
    expect(taskB.assigned.planner).not.toBe(planKeyA);

    // A의 PLANNER key로 Stop — B에 배정되지 않았으므로 즉시 allow, 평가 없음.
    let reply: Reply | null = null;
    orchestrator.handleStop(planKeyA, { session_id: "s1" }, (r) => (reply = r), () => {});
    expect(reply).toEqual({ action: "allow" });
    expect(taskB.folder).toBeNull();

    env.cleanup();
  });

  it("W4 — VERIFIER idle relaunch 허용·배정 교체·이전 키 Stop 즉시 allow, parked 409", () => {
    const env = setup();
    const { orchestrator, store, sessions, folder } = env;

    // bound 작업 + PLANNER(idle)·VERIFIER(idle).
    const task = seedTask(store, {
      folder,
      assigned: { planner: "planner-1", verifier: "verifier-1", coder: null },
    });
    store.state.sessions["planner-1"] = {
      role: "planner",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["p1"],
      activeSessionId: "p1",
      switchedOnce: false,
      task: task.id,
    };
    store.state.sessions["verifier-1"] = {
      role: "verifier",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["v1"],
      activeSessionId: "v1",
      switchedOnce: false,
      task: task.id,
    };
    sessions.register("planner-1", "idle");
    sessions.register("verifier-1", "idle");

    // VERIFIER idle relaunch → 허용 + assigned.verifier 교체.
    const r1 = orchestrator.relaunch(task.id, "verifier");
    expect(r1.ok).toBe(true);
    const newVerifyKey = task.assigned.verifier!;
    expect(newVerifyKey).not.toBe("verifier-1");
    expect(sessions.stateOf(newVerifyKey)).toBe("working");

    // 이전 키 Stop → 배정되지 않으므로 즉시 allow.
    let replyOld: Reply | null = null;
    orchestrator.handleStop("verifier-1", { session_id: "v1" }, (r) => (replyOld = r), () => {});
    expect(replyOld).toEqual({ action: "allow" });

    // VERIFIER parked relaunch → 409.
    sessions.register(newVerifyKey, "parked");
    const r2 = orchestrator.relaunch(task.id, "verifier");
    expect(r2.ok).toBe(false);
    expect(r2.status).toBe(409);

    env.cleanup();
  });

  it("W4 — folder null: PLANNER unbound relaunch 허용·VERIFIER 409, closeTask 시 pending allow 해제", () => {
    const env = setup();
    const { orchestrator, store, sessions } = env;

    // 새 작업 (folder null, PLANNER unbound).
    const r0 = orchestrator.newTask("EWE");
    expect(r0.ok).toBe(true);
    const task = store.state.tasks[r0.taskId!]!;
    const planKey = task.assigned.planner!;
    expect(sessions.stateOf(planKey)).toBe("unbound");

    // PLANNER unbound relaunch → 허용 (새 키 unbound).
    const r1 = orchestrator.relaunch(task.id, "planner");
    expect(r1.ok).toBe(true);
    const newPlanKey = task.assigned.planner!;
    expect(newPlanKey).not.toBe(planKey);
    expect(sessions.stateOf(newPlanKey)).toBe("unbound");

    // VERIFIER relaunch → 409 (folder is null).
    const r2 = orchestrator.relaunch(task.id, "verifier");
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
      task: task.id,
    };
    let replyP: Reply | null = null;
    sessions.onStop(newPlanKey, "p2", (r) => (replyP = r), () => {});
    expect(sessions.stateOf(newPlanKey)).toBe("parked");
    orchestrator.closeTask(task.id);
    expect(replyP).toEqual({ action: "allow" });
    expect(store.state.tasks[task.id]).toBeUndefined();

    env.cleanup();
  });

  it("T7 — resume relaunch: 허용(detached·activeSessionId) + 409(activeSessionId null·parked·CODER folder null) + resumable", () => {
    const env = setup();
    const { orchestrator, store, sessions, folder, launchCalls } = env;

    // bound 작업 + PLANNER(detached — 미등록) activeSessionId "p1".
    const task = seedTask(store, {
      folder,
      assigned: { planner: "planner-1", verifier: null, coder: null },
    });
    store.state.sessions["planner-1"] = {
      role: "planner",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["p1"],
      activeSessionId: "p1",
      switchedOnce: false,
      task: task.id,
    };

    // resumable — activeSessionId 있음 → true.
    expect(orchestrator.getState(task.id).sessions["planner-1"].resumable).toBe(true);

    // resume 허용 → ok + launchCalls 마지막 resumeSessionId "p1" + 새 키 working + 이벤트 resume: true.
    const r1 = orchestrator.relaunch(task.id, "planner", "resume");
    expect(r1.ok).toBe(true);
    const newKey = task.assigned.planner!;
    expect(newKey).not.toBe("planner-1");
    expect(sessions.stateOf(newKey)).toBe("working");
    const lastLaunch = launchCalls[launchCalls.length - 1];
    expect(lastLaunch.resumeSessionId).toBe("p1");
    // launch 이벤트는 그 세션 작업 파일에 (T4).
    const events = store.readTaskEvents(task.id);
    const launchEv = events.filter((e) => e.type === "launch" && e.sessionKey === newKey);
    expect(launchEv[launchEv.length - 1].resume).toBe(true);

    // 409 — activeSessionId null (detached인데 session_id 없음) → cannot resume.
    task.assigned.planner = "planner-2";
    store.state.sessions["planner-2"] = {
      role: "planner",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: [],
      activeSessionId: null,
      switchedOnce: false,
      task: task.id,
    };
    const r2 = orchestrator.relaunch(task.id, "planner", "resume");
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe("cannot resume");

    // 409 — 상태 parked → 기존 "session is parked".
    task.assigned.planner = "planner-3";
    store.state.sessions["planner-3"] = {
      role: "planner",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["p3"],
      activeSessionId: "p3",
      switchedOnce: false,
      task: task.id,
    };
    sessions.register("planner-3", "parked");
    const r3 = orchestrator.relaunch(task.id, "planner", "resume");
    expect(r3.ok).toBe(false);
    expect(r3.error).toBe("session is parked");

    // 409 — CODER folder null.
    task.folder = null;
    task.assigned.coder = "coder-1";
    const r4 = orchestrator.relaunch(task.id, "coder", "resume");
    expect(r4.ok).toBe(false);
    expect(r4.error).toBe("folder is null");

    // resumable — activeSessionId null → false (planner-2 배정).
    task.assigned.planner = "planner-2";
    expect(orchestrator.getState(task.id).sessions["planner-2"].resumable).toBe(false);

    env.cleanup();
  });

  it("M2 polish — peer 없음 launch (PLANNER Stop IN_REVIEW, VERIFIER 미배정) → firstInstruction + 이벤트 instruction", () => {
    const env = setup();
    const { orchestrator, store, sessions, folder, taskDir, launchCalls } = env;

    const task = seedTask(store, {
      folder,
      assigned: { planner: "planner-1", verifier: null, coder: null },
    });
    store.state.sessions["planner-1"] = {
      role: "planner",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["p1"],
      activeSessionId: "p1",
      switchedOnce: false,
      task: task.id,
    };
    sessions.register("planner-1", "idle");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: IN_REVIEW\n");

    orchestrator.handleStop("planner-1", { session_id: "p1" }, () => {}, () => {});

    const lastLaunch = launchCalls[launchCalls.length - 1];
    expect(lastLaunch.role).toBe("verifier");
    expect(lastLaunch.firstInstruction).toBe(instructionVerifyPlan(1));
    const newKey = task.assigned.verifier!;
    // launch 이벤트는 그 세션 작업 파일에 (T4).
    const launchEv = store.readTaskEvents(task.id).filter((e) => e.type === "launch" && e.sessionKey === newKey);
    expect(launchEv[launchEv.length - 1].instruction).toBe(instructionVerifyPlan(1));

    env.cleanup();
  });

  it("M2 polish — relaunch: undelivered 있으면 firstInstruction·이벤트 instruction·undelivered 삭제, 없으면 둘 다 없음", () => {
    const env = setup();
    const { orchestrator, store, sessions, folder, launchCalls } = env;

    const task = seedTask(store, {
      folder,
      assigned: { planner: "planner-1", verifier: null, coder: null },
      undelivered: [{ role: "planner", text: instructionPlanRevise(1) }],
    });
    store.state.sessions["planner-1"] = {
      role: "planner",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["p1"],
      activeSessionId: "p1",
      switchedOnce: false,
      task: task.id,
    };
    sessions.register("planner-1", "detached");

    // relaunch(새로) → undelivered를 firstInstruction으로 전달 + 삭제.
    const r1 = orchestrator.relaunch(task.id, "planner");
    expect(r1.ok).toBe(true);
    const newKey = task.assigned.planner!;
    expect(newKey).not.toBe("planner-1");
    const lastLaunch = launchCalls[launchCalls.length - 1];
    expect(lastLaunch.firstInstruction).toBe(instructionPlanRevise(1));
    expect(task.undelivered).toEqual([]);
    // launch 이벤트는 그 세션 작업 파일에 (T4).
    const launchEv = store.readTaskEvents(task.id).filter((e) => e.type === "launch" && e.sessionKey === newKey);
    expect(launchEv[launchEv.length - 1].instruction).toBe(instructionPlanRevise(1));

    // 다시 relaunch (undelivered 없음) → 둘 다 없음.
    const r2 = orchestrator.relaunch(task.id, "planner");
    expect(r2.ok).toBe(true);
    const newKey2 = task.assigned.planner!;
    const lastLaunch2 = launchCalls[launchCalls.length - 1];
    expect(lastLaunch2.firstInstruction).toBeUndefined();
    const launchEv2 = store.readTaskEvents(task.id).filter((e) => e.type === "launch" && e.sessionKey === newKey2);
    expect("instruction" in launchEv2[launchEv2.length - 1]).toBe(false);

    env.cleanup();
  });

  it("M2 polish — relaunch working 상태 (새로·이어서) → ok, parked → 409 session is parked", () => {
    const env = setup();
    const { orchestrator, store, sessions, folder } = env;

    const task = seedTask(store, {
      folder,
      assigned: { planner: "planner-1", verifier: null, coder: null },
    });
    store.state.sessions["planner-1"] = {
      role: "planner",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["p1"],
      activeSessionId: "p1",
      switchedOnce: false,
      task: task.id,
    };
    sessions.register("planner-1", "working");

    // working relaunch(새로) → ok.
    const r1 = orchestrator.relaunch(task.id, "planner");
    expect(r1.ok).toBe(true);
    const newKey = task.assigned.planner!;
    expect(newKey).not.toBe("planner-1");

    // working relaunch(이어서) → ok (activeSessionId 있음).
    store.state.sessions[newKey].activeSessionId = "p2";
    const r2 = orchestrator.relaunch(task.id, "planner", "resume");
    expect(r2.ok).toBe(true);

    // parked → 409.
    task.assigned.planner = "planner-3";
    store.state.sessions["planner-3"] = {
      role: "planner",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["p3"],
      activeSessionId: "p3",
      switchedOnce: false,
      task: task.id,
    };
    sessions.register("planner-3", "parked");
    const r3 = orchestrator.relaunch(task.id, "planner");
    expect(r3.ok).toBe(false);
    expect(r3.error).toBe("session is parked");

    env.cleanup();
  });

  it("W5 — PASS(PLANNER parked)→block+기록, PASS(PLANNER working)→무동작, PLANNER Stop block 1회→다음 allow, TODO_READY→allow+notify+pendingAction", () => {
    const env = setup();
    const { orchestrator, store, sessions, taskDir, folder } = env;

    // bound 작업 + PLANNER(idle)·VERIFIER(working).
    const task = seedTask(store, {
      folder,
      assigned: { planner: "planner-1", verifier: "verifier-1", coder: null },
    });
    store.state.sessions["planner-1"] = {
      role: "planner",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["p1"],
      activeSessionId: "p1",
      switchedOnce: false,
      task: task.id,
    };
    store.state.sessions["verifier-1"] = {
      role: "verifier",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["v1"],
      activeSessionId: "v1",
      switchedOnce: false,
      task: task.id,
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
    expect(task.record.instructed).toContain("todo-v1");
    expect(store.readTaskEvents(task.id).some((e) => e.type === "notify" && e.key === "pass-v1")).toBe(true);

    // (b) PLANNER working일 때 PASS → PLANNER에 대한 Action 없음.
    let replyV2: Reply | null = null;
    orchestrator.handleStop("verifier-1", { session_id: "v1" }, (r) => (replyV2 = r), () => {});
    expect(replyV2).toEqual({ action: "allow" });
    expect(sessions.stateOf("planner-1")).toBe("working");

    // (c) 새 작업 — PLANNER Stop(IN_REVIEW+PASS, 미기록) → 행 4p block 1회 → 다음 Stop allow.
    const env2 = setup();
    const { store: store2, sessions: sessions2, taskDir: taskDir2, folder: folder2 } = env2;
    const task2 = seedTask(store2, {
      folder: folder2,
      assigned: { planner: "planner-1", verifier: "verifier-1", coder: null },
    });
    store2.state.sessions["planner-1"] = {
      role: "planner",
      project: "EWE",
      folder: folder2,
      launchedAt: 0,
      sessionIds: ["p1"],
      activeSessionId: "p1",
      switchedOnce: false,
      task: task2.id,
    };
    store2.state.sessions["verifier-1"] = {
      role: "verifier",
      project: "EWE",
      folder: folder2,
      launchedAt: 0,
      sessionIds: ["v1"],
      activeSessionId: "v1",
      switchedOnce: false,
      task: task2.id,
    };
    sessions2.register("planner-1", "idle");
    sessions2.register("verifier-1", "working");
    fs.mkdirSync(taskDir2, { recursive: true });
    fs.writeFileSync(path.join(taskDir2, "plan-v1.md"), "Status: IN_REVIEW\n");
    fs.writeFileSync(path.join(taskDir2, "plan-v1-verify.md"), "# verify\n\n판정: PASS\n");

    let r1: Reply | null = null;
    env2.orchestrator.handleStop("planner-1", { session_id: "p1" }, (r) => (r1 = r), () => {});
    expect(r1).toEqual({ action: "block", reason: instructionApproveAndTodo(1) });
    expect(task2.record.instructed).toContain("todo-v1");

    let r2: Reply | null = null;
    env2.orchestrator.handleStop("planner-1", { session_id: "p1" }, (r) => (r2 = r), () => {});
    expect(r2).toEqual({ action: "allow" });

    // (d) PLANNER가 Status를 TODO_READY로 바꾸고 Stop → allow + notify notodo-v1 (todo 파일 없음) + pendingAction null.
    fs.writeFileSync(path.join(taskDir2, "plan-v1.md"), "Status: TODO_READY\n");
    let r3: Reply | null = null;
    env2.orchestrator.handleStop("planner-1", { session_id: "p1" }, (r) => (r3 = r), () => {});
    expect(r3).toEqual({ action: "allow" });
    expect(store2.readTaskEvents(task2.id).some((e) => e.type === "notify" && e.key === "notodo-v1")).toBe(true);
    expect(env2.orchestrator.pendingAction(task2)).toBeNull();

    env.cleanup();
    env2.cleanup();
  });

  it("M2 — todo 루프: TODO_READY → hold+launch(coder) → REVISE → PLANNER block → todo-v2 → CODER block → PASS·DONE → coder allow + done-v1 + PLANNER block(checklist 지시)", () => {
    const env = setup();
    const { orchestrator, store, sessions, taskDir, folder } = env;

    // bound 작업 + PLANNER(idle). CODER는 아직 배정 없음.
    const task = seedTask(store, {
      folder,
      assigned: { planner: "planner-1", verifier: null, coder: null },
    });
    store.state.sessions["planner-1"] = {
      role: "planner",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["p1"],
      activeSessionId: "p1",
      switchedOnce: false,
      task: task.id,
    };
    sessions.register("planner-1", "idle");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: TODO_READY\n");
    fs.writeFileSync(path.join(taskDir, "todo-v1.md"), "- [ ] T1\n");

    // Step 1 — PLANNER Stop (TODO_READY, todo-v1 있음·verify 없음) → hold + launch(coder, folder 전달).
    let replyP1: Reply | null = null;
    orchestrator.handleStop("planner-1", { session_id: "p1" }, (r) => (replyP1 = r), () => {});
    expect(sessions.stateOf("planner-1")).toBe("parked"); // hold — reply 아직 방출 안 됨
    const coderKey = Object.keys(store.state.sessions).find((k) => store.state.sessions[k].role === "coder")!;
    expect(coderKey).toBeDefined();
    expect(store.state.sessions[coderKey].folder).toBe(folder);
    expect(sessions.stateOf(coderKey)).toBe("working");
    const lastLaunch = env.launchCalls[env.launchCalls.length - 1];
    expect(lastLaunch.role).toBe("coder");
    expect(lastLaunch.folder).toBe(folder);

    // Step 2 — CODER가 todo-v1-verify.md(REVISE) 쓰고 Stop → c3: hold(coder) + PLANNER에 block(instructionTodoRevise(1)).
    fs.writeFileSync(path.join(taskDir, "todo-v1-verify.md"), "# verify\n\n판정: REVISE\n");
    let replyC1: Reply | null = null;
    orchestrator.handleStop(coderKey, { session_id: "c1" }, (r) => (replyC1 = r), () => {});
    expect(sessions.stateOf(coderKey)).toBe("parked"); // hold
    expect(replyP1).toEqual({ action: "block", reason: instructionTodoRevise(1) });
    expect(sessions.stateOf("planner-1")).toBe("working");

    // Step 3 — PLANNER가 todo-v2.md 쓰고 Stop → 행 5t(b): hold + CODER에 block(instructionReviewTodo(2)).
    fs.writeFileSync(path.join(taskDir, "todo-v2.md"), "- [ ] T1\n");
    let replyP2: Reply | null = null;
    orchestrator.handleStop("planner-1", { session_id: "p1" }, (r) => (replyP2 = r), () => {});
    expect(sessions.stateOf("planner-1")).toBe("parked"); // hold
    expect(replyC1).toEqual({ action: "block", reason: instructionReviewTodo(2) });
    expect(sessions.stateOf(coderKey)).toBe("working");

    // Step 4 — CODER가 todo-v2-verify.md(PASS)·plan-v1 DONE 쓰고 Stop → c9: coder allow + done-v1 알림 + PLANNER block(instructionChecklist(1, 2)).
    fs.writeFileSync(path.join(taskDir, "todo-v2-verify.md"), "# verify\n\n판정: PASS\n");
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: DONE\n");
    let replyC2: Reply | null = null;
    orchestrator.handleStop(coderKey, { session_id: "c1" }, (r) => (replyC2 = r), () => {});
    expect(replyC2).toEqual({ action: "allow" });
    expect(sessions.stateOf(coderKey)).toBe("idle");
    expect(store.readTaskEvents(task.id).some((e) => e.type === "notify" && e.key === "done-v1")).toBe(true);
    expect(replyP2).toEqual({ action: "block", reason: instructionChecklist(1, 2) }); // c9 — 체크리스트 지시
    expect(sessions.stateOf("planner-1")).toBe("working");

    env.cleanup();
  });

  it("W6 — 작업 A 기록이 B로 이어지지 않음: pass-v1·todo 지시 다시 나옴, A의 undelivered는 B의 pendingAction에 없음", () => {
    const env = setup();
    const { orchestrator, store, sessions, taskDir, folder, plansDir } = env;

    // 작업 A — bound + PLANNER(idle)·VERIFIER(working).
    const taskA = seedTask(store, {
      folder,
      assigned: { planner: "planner-1", verifier: "verifier-1", coder: null },
    });
    store.state.sessions["planner-1"] = {
      role: "planner",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["p1"],
      activeSessionId: "p1",
      switchedOnce: false,
      task: taskA.id,
    };
    store.state.sessions["verifier-1"] = {
      role: "verifier",
      project: "EWE",
      folder,
      launchedAt: 0,
      sessionIds: ["v1"],
      activeSessionId: "v1",
      switchedOnce: false,
      task: taskA.id,
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
    expect(store.readTaskEvents(taskA.id).some((e) => e.type === "notify" && e.key === "pass-v1")).toBe(true);
    expect(taskA.record.instructed).toContain("todo-v1");

    // A의 undelivered (이전 REVISE 주기 잔여 — 직접 설정).
    taskA.undelivered.push({ role: "planner", text: "이전 지시" });

    // A 종료 → B 시작.
    orchestrator.closeTask(taskA.id);
    const rB = orchestrator.newTask("EWE");
    expect(rB.ok).toBe(true);
    const taskB = store.state.tasks[rB.taskId!]!;
    expect(taskB.record.notified).toEqual([]);
    expect(taskB.record.instructed).toEqual([]);
    expect(taskB.undelivered).toEqual([]);
    // A의 undelivered는 B의 pendingAction에 없음.
    expect(orchestrator.pendingAction(taskB)).toEqual({ kind: "describe" });

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
      task: taskB.id,
    };
    sessions.register("verifier-b", "working");
    taskB.assigned.verifier = "verifier-b";

    // PLANNER Stop → W1 bind + 행 4p(미기록) → block.
    const planKeyB = taskB.assigned.planner!;
    let replyB: Reply | null = null;
    orchestrator.handleStop(planKeyB, { session_id: "s2" }, (r) => (replyB = r), () => {});
    expect(taskB.folder).toBe(folderB);
    expect(replyB).toEqual({ action: "block", reason: instructionApproveAndTodo(1) });

    // VERIFIER Stop → 행 8: pass-v1 notify 다시 (B의 record는 비어 있음). 각 작업 파일에 기록 (T5).
    orchestrator.handleStop("verifier-b", { session_id: "vb" }, () => {}, () => {});
    const aPass = store.readTaskEvents(taskA.id).filter((e) => e.type === "notify" && e.key === "pass-v1");
    const bPass = store.readTaskEvents(taskB.id).filter((e) => e.type === "notify" && e.key === "pass-v1");
    expect(aPass.length + bPass.length).toBeGreaterThanOrEqual(2);

    env.cleanup();
  });
});

// T7 — 표시 상태 계산 (assignedDisplay, plan-v3 §3 B 규칙 1~6).
describe("T7 — 표시 상태 (assignedDisplay)", () => {
  it("배정 없음 → null", () => {
    const env = setup();
    const { orchestrator } = env;
    const task = seedTask(env.store, { folder: "261111-alpha" }); // assigned.planner·verifier null
    const st = orchestrator.getState(task.id);
    expect(st.assignedDisplay.planner).toBeNull();
    expect(st.assignedDisplay.verifier).toBeNull();
    env.cleanup();
  });

  it("detached(미등록) → disconnected", () => {
    const env = setup();
    const { orchestrator } = env;
    const task = seedTask(env.store, {
      folder: "261111-alpha",
      assigned: { planner: "planner-1", verifier: null, coder: null },
    });
    // planner-1 미등록 → stateOf undefined → detached → disconnected.
    expect(orchestrator.getState(task.id).assignedDisplay.planner).toBe("disconnected");
    env.cleanup();
  });

  it("working → working", () => {
    const env = setup();
    const { orchestrator, sessions } = env;
    const task = seedTask(env.store, {
      folder: "261111-alpha",
      assigned: { planner: "planner-1", verifier: null, coder: null },
    });
    sessions.register("planner-1", "working");
    expect(orchestrator.getState(task.id).assignedDisplay.planner).toBe("working");
    env.cleanup();
  });

  it("parked → waiting", () => {
    const env = setup();
    const { orchestrator, sessions } = env;
    const task = seedTask(env.store, {
      folder: "261111-alpha",
      assigned: { planner: "planner-1", verifier: null, coder: null },
    });
    sessions.register("planner-1", "parked");
    expect(orchestrator.getState(task.id).assignedDisplay.planner).toBe("waiting");
    env.cleanup();
  });

  it("unbound(새 작업 PLANNER) → your-turn", () => {
    const env = setup();
    const { orchestrator, sessions } = env;
    const task = seedTask(env.store, {
      folder: null,
      assigned: { planner: "planner-1", verifier: null, coder: null },
    });
    sessions.register("planner-1", "unbound");
    expect(orchestrator.getState(task.id).assignedDisplay.planner).toBe("your-turn");
    env.cleanup();
  });

  it("PLANNER idle + decision → your-turn", () => {
    const env = setup();
    const { orchestrator, sessions, taskDir } = env;
    const task = seedTask(env.store, {
      folder: "261111-alpha",
      assigned: { planner: "planner-1", verifier: null, coder: null },
    });
    sessions.register("planner-1", "idle");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: NEEDS_DECISION\n"); // pendingAction → decision
    expect(orchestrator.getState(task.id).assignedDisplay.planner).toBe("your-turn");
    env.cleanup();
  });

  it("VERIFIER idle + decision → idle (decision은 PLANNER 대상)", () => {
    const env = setup();
    const { orchestrator, sessions, taskDir } = env;
    const task = seedTask(env.store, {
      folder: "261111-alpha",
      assigned: { planner: "planner-1", verifier: "verifier-1", coder: null },
    });
    sessions.register("planner-1", "idle");
    sessions.register("verifier-1", "idle");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: NEEDS_DECISION\n"); // pendingAction → decision
    const st = orchestrator.getState(task.id);
    expect(st.assignedDisplay.planner).toBe("your-turn");
    expect(st.assignedDisplay.verifier).toBe("idle");
    env.cleanup();
  });

  it("VERIFIER idle + deliver(verifier) → your-turn", () => {
    const env = setup();
    const { orchestrator, sessions } = env;
    const task = seedTask(env.store, {
      folder: "261111-alpha",
      assigned: { planner: "planner-1", verifier: "verifier-1", coder: null },
      undelivered: [{ role: "verifier", text: "지시 문장" }], // pendingAction → deliver(verifier)
    });
    sessions.register("planner-1", "idle");
    sessions.register("verifier-1", "idle");
    expect(orchestrator.getState(task.id).assignedDisplay.verifier).toBe("your-turn");
    env.cleanup();
  });
});

describe("T5 — pendingAction (todo-gate·coder·done)", () => {
  it("TODO_READY + todo-v5-verify REVISE·todo-v6 없음 → { kind: 'todo-gate', n: 5 }", () => {
    const env = setup();
    const { orchestrator, taskDir } = env;
    const task = seedTask(env.store, {
      folder: "261111-alpha",
      assigned: { planner: "planner-1", verifier: null, coder: null },
    });
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: TODO_READY\n");
    fs.writeFileSync(path.join(taskDir, "todo-v5.md"), "- [ ] T1\n");
    fs.writeFileSync(path.join(taskDir, "todo-v5-verify.md"), "# verify\n\n판정: REVISE\n");
    expect(orchestrator.pendingAction(task)).toEqual({ kind: "todo-gate", n: 5 });
    env.cleanup();
  });

  it("todo-v6 존재 → null (다음 버전이 이미 시작됨)", () => {
    const env = setup();
    const { orchestrator, taskDir } = env;
    const task = seedTask(env.store, {
      folder: "261111-alpha",
      assigned: { planner: "planner-1", verifier: null, coder: null },
    });
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: TODO_READY\n");
    fs.writeFileSync(path.join(taskDir, "todo-v5.md"), "- [ ] T1\n");
    fs.writeFileSync(path.join(taskDir, "todo-v5-verify.md"), "# verify\n\n판정: REVISE\n");
    fs.writeFileSync(path.join(taskDir, "todo-v6.md"), "- [ ] T1\n");
    expect(orchestrator.pendingAction(task)).toBeNull();
    env.cleanup();
  });

  it("IN_PROGRESS + coder idle → { kind: 'coder' }", () => {
    const env = setup();
    const { orchestrator, sessions, taskDir } = env;
    const task = seedTask(env.store, {
      folder: "261111-alpha",
      assigned: { planner: "planner-1", verifier: null, coder: "coder-1" },
    });
    sessions.register("coder-1", "idle");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: IN_PROGRESS\n");
    expect(orchestrator.pendingAction(task)).toEqual({ kind: "coder" });
    env.cleanup();
  });

  it("IN_PROGRESS + coder working → null", () => {
    const env = setup();
    const { orchestrator, sessions, taskDir } = env;
    const task = seedTask(env.store, {
      folder: "261111-alpha",
      assigned: { planner: "planner-1", verifier: null, coder: "coder-1" },
    });
    sessions.register("coder-1", "working");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: IN_PROGRESS\n");
    expect(orchestrator.pendingAction(task)).toBeNull();
    env.cleanup();
  });

  it("DONE + checklist → { kind: 'done', t: 1 }", () => {
    const env = setup();
    const { orchestrator, taskDir } = env;
    const task = seedTask(env.store, {
      folder: "261111-alpha",
      assigned: { planner: "planner-1", verifier: null, coder: null },
    });
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: DONE\n");
    fs.writeFileSync(path.join(taskDir, "todo-v1.md"), "- [ ] T1\n");
    fs.writeFileSync(path.join(taskDir, "todo-v1-checklist.md"), "- [ ] 확인\n");
    expect(orchestrator.pendingAction(task)).toEqual({ kind: "done", t: 1, commit: "none" });
    env.cleanup();
  });

  it("DONE + checklist 없음 → null (PLANNER 작성 중)", () => {
    const env = setup();
    const { orchestrator, taskDir } = env;
    const task = seedTask(env.store, {
      folder: "261111-alpha",
      assigned: { planner: "planner-1", verifier: null, coder: null },
    });
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: DONE\n");
    fs.writeFileSync(path.join(taskDir, "todo-v1.md"), "- [ ] T1\n");
    expect(orchestrator.pendingAction(task)).toBeNull();
    env.cleanup();
  });

  it("assignedDisplay.coder — IN_PROGRESS + coder idle → your-turn", () => {
    const env = setup();
    const { orchestrator, sessions, taskDir } = env;
    const task = seedTask(env.store, {
      folder: "261111-alpha",
      assigned: { planner: "planner-1", verifier: null, coder: "coder-1" },
    });
    sessions.register("coder-1", "idle");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: IN_PROGRESS\n");
    expect(orchestrator.getState(task.id).assignedDisplay.coder).toBe("your-turn");
    env.cleanup();
  });

  it("DONE + checklist + planner idle → planner idle (done은 대상 없음)", () => {
    const env = setup();
    const { orchestrator, sessions, taskDir } = env;
    const task = seedTask(env.store, {
      folder: "261111-alpha",
      assigned: { planner: "planner-1", verifier: null, coder: null },
    });
    sessions.register("planner-1", "idle");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: DONE\n");
    fs.writeFileSync(path.join(taskDir, "todo-v1.md"), "- [ ] T1\n");
    fs.writeFileSync(path.join(taskDir, "todo-v1-checklist.md"), "- [ ] 확인\n");
    const st = orchestrator.getState(task.id);
    expect(st.pendingAction).toEqual({ kind: "done", t: 1, commit: "none" });
    expect(st.assignedDisplay.planner).toBe("idle");
    env.cleanup();
  });
});

describe("T8 — Windows 토스트", () => {
  it("warn → 토스트, pass-v1·done info → 없음, undeliverable·checklist info → 있음", () => {
    const env = setup();
    const { orchestrator, toasts } = env;

    orchestrator.emitNotify(null, "gate-v5", "warn", "x");
    expect(toasts).toEqual(["x"]);

    orchestrator.emitNotify(null, "pass-v1", "info", "y");
    expect(toasts).toEqual(["x"]);

    orchestrator.emitNotify(null, "undeliverable-planner", "info", "z");
    orchestrator.emitNotify(null, "done-v1", "info", "w");
    orchestrator.emitNotify(null, "checklist-v1", "info", "c");
    expect(toasts).toEqual(["x", "z", "c"]);

    env.cleanup();
  });

  it("config.toast = false → warn도 토스트 없음", () => {
    const env = setup();
    const { orchestrator, toasts } = env;
    env.config.toast = false;
    orchestrator.emitNotify(null, "gate-v5", "warn", "x");
    expect(toasts).toEqual([]);
    env.cleanup();
  });
});

describe("shouldToast", () => {
  it("warn → true, pass-v1 info → false, undeliverable-·commit-plan-·checklist- info → true, committed-v1 → false", () => {
    expect(shouldToast("warn", "gate-v5")).toBe(true);
    expect(shouldToast("info", "pass-v1")).toBe(false);
    expect(shouldToast("info", "undeliverable-planner")).toBe(true);
    expect(shouldToast("info", "done-v1")).toBe(false);
    expect(shouldToast("info", "commit-plan-v1")).toBe(true);
    expect(shouldToast("info", "committed-v1")).toBe(false);
    expect(shouldToast("info", "checklist-v1")).toBe(true);
  });
});

describe("이벤트 문구 2000자 (M2 polish §3 A)", () => {
  it("긴 last_assistant_message(2500자) → stop 이벤트 message 길이 2000", () => {
    const env = setup();
    const { orchestrator, store, sessions } = env;
    store.state.sessions["planner-1"] = {
      role: "planner",
      project: "EWE",
      folder: null,
      launchedAt: 0,
      sessionIds: [],
      activeSessionId: null,
      switchedOnce: false,
      task: null,
    };
    sessions.register("planner-1", "idle");
    orchestrator.handleStop("planner-1", { last_assistant_message: "가".repeat(2500) }, () => {}, () => {});
    const stop = store.readEvents().find((e) => e.type === "stop" && e.sessionKey === "planner-1");
    expect(stop).toBeDefined();
    expect(String(stop!.message).length).toBe(2000);
    env.cleanup();
  });
});

describe("타임라인 비우기 (M2 polish §3 C, T4 작업별)", () => {
  it("clearTimeline → 그 작업 events 비어지고 기록 파일은 유지, 이후 이벤트만 보임, hub에 state 1회", () => {
    const env = setup();
    const { orchestrator, store } = env;
    const task = seedTask(store);

    // stop·launch 등 작업 이벤트는 그 작업 파일에 (T4).
    store.appendTaskEvent(task.id, { type: "stop", sessionKey: "s1" });
    store.appendTaskEvent(task.id, { type: "launch", role: "verifier", sessionKey: "v1" });
    store.appendTaskEvent(task.id, { type: "reply", sessionKey: "s1", action: "allow" });
    expect(orchestrator.getState(task.id).events).toHaveLength(3);

    const writes: string[] = [];
    orchestrator.getHub().add({ write: (raw) => writes.push(raw), close: () => {} });
    const r = orchestrator.clearTimeline(task.id);
    expect(r.ok).toBe(true);
    expect(orchestrator.getState(task.id).events).toEqual([]);
    // 작업 파일 유지 — clear-timeline 표식만 추가 (4줄).
    expect(store.readTaskEvents(task.id)).toHaveLength(4);
    expect(writes).toHaveLength(1);
    expect(writes[0].startsWith("event: state\n")).toBe(true);

    store.appendTaskEvent(task.id, { type: "stop", sessionKey: "s2" });
    const events = orchestrator.getState(task.id).events;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("stop");
    env.cleanup();
  });
});

// T4 — 작업별 이벤트 기록 (완료 조건).
describe("T4 — 작업별 이벤트", () => {
  it("작업 A의 Stop·reply는 A 파일에만, B의 getState().events·전역에는 없음", () => {
    const env = setup();
    const { orchestrator, store, sessions } = env;
    const taskA = seedTask(store, { assigned: { planner: "planner-1", verifier: null, coder: null } });
    const taskB = seedTask(store, { assigned: { planner: "planner-2", verifier: null, coder: null } });
    store.state.sessions["planner-1"] = { role: "planner", project: "EWE", folder: null, launchedAt: 0, sessionIds: ["p1"], activeSessionId: "p1", switchedOnce: false, task: taskA.id };
    store.state.sessions["planner-2"] = { role: "planner", project: "EWE", folder: null, launchedAt: 0, sessionIds: ["p2"], activeSessionId: "p2", switchedOnce: false, task: taskB.id };
    sessions.register("planner-1", "idle");
    sessions.register("planner-2", "idle");

    // A의 세션 Stop → stop·reply는 A 파일.
    orchestrator.handleStop("planner-1", { session_id: "p1" }, () => {}, () => {});
    const aEvents = store.readTaskEvents(taskA.id);
    expect(aEvents.some((e) => e.type === "stop" && e.sessionKey === "planner-1")).toBe(true);
    expect(aEvents.some((e) => e.type === "reply" && e.sessionKey === "planner-1")).toBe(true);

    // B의 getState().events에는 A의 이벤트 없음 (B 파일 비어 있음). 전역에도 없음.
    expect(orchestrator.getState(taskB.id).events).toEqual([]);
    expect(store.readEvents().some((e) => e.type === "stop" && e.sessionKey === "planner-1")).toBe(false);

    env.cleanup();
  });

  it("배정 안 된(작업 없는) 세션 Stop은 전역 events.jsonl", () => {
    const env = setup();
    const { orchestrator, store } = env;
    // task null — 배정 안 된 세션.
    store.state.sessions["orphan-1"] = { role: "planner", project: "EWE", folder: null, launchedAt: 0, sessionIds: [], activeSessionId: null, switchedOnce: false, task: null };

    orchestrator.handleStop("orphan-1", { session_id: "" }, () => {}, () => {});

    expect(store.readEvents().some((e) => e.type === "stop" && e.sessionKey === "orphan-1")).toBe(true);
    env.cleanup();
  });

  it("종료된 작업 세션의 이후 이벤트는 전역 파일 (작업 파일에는 close-task만)", () => {
    const env = setup();
    const { orchestrator, store, sessions } = env;
    const taskA = seedTask(store, { assigned: { planner: "planner-1", verifier: null, coder: null } });
    store.state.sessions["planner-1"] = { role: "planner", project: "EWE", folder: null, launchedAt: 0, sessionIds: ["p1"], activeSessionId: "p1", switchedOnce: false, task: taskA.id };
    sessions.register("planner-1", "idle");

    // 작업 종료 — 세션의 task 필드는 그대로(taskA.id)지만 tasks에서 삭제됨.
    orchestrator.closeTask(taskA.id);
    expect(store.state.tasks[taskA.id]).toBeUndefined();

    // 이후 Stop → tasks에 없으므로 전역 파일.
    orchestrator.handleStop("planner-1", { session_id: "p1" }, () => {}, () => {});
    expect(store.readEvents().some((e) => e.type === "stop" && e.sessionKey === "planner-1")).toBe(true);
    const aEvents = store.readTaskEvents(taskA.id);
    expect(aEvents.some((e) => e.type === "stop")).toBe(false);
    expect(aEvents.some((e) => e.type === "close-task")).toBe(true);

    env.cleanup();
  });

  it("clearTimeline(A)은 B 타임라인에 영향 없음", () => {
    const env = setup();
    const { orchestrator, store } = env;
    const taskA = seedTask(store);
    const taskB = seedTask(store);
    store.appendTaskEvent(taskA.id, { type: "stop", sessionKey: "a1" });
    store.appendTaskEvent(taskB.id, { type: "stop", sessionKey: "b1" });

    orchestrator.clearTimeline(taskA.id);

    expect(orchestrator.getState(taskA.id).events).toEqual([]);
    expect(orchestrator.getState(taskB.id).events).toHaveLength(1);
    expect(orchestrator.getState(taskB.id).events[0].sessionKey).toBe("b1");

    env.cleanup();
  });

  it("같은 작업 getState를 다시 부르면 지난 기록 그대로", () => {
    const env = setup();
    const { orchestrator, store } = env;
    const taskA = seedTask(store);
    store.appendTaskEvent(taskA.id, { type: "stop", sessionKey: "a1" });
    store.appendTaskEvent(taskA.id, { type: "reply", sessionKey: "a1", action: "allow" });

    const first = orchestrator.getState(taskA.id).events;
    const second = orchestrator.getState(taskA.id).events;
    expect(second).toEqual(first);
    expect(second).toHaveLength(2);

    env.cleanup();
  });
});

// T5 — 상태·알림을 작업 채널에만, lobby(unattached) 채널 추가 (완료 조건).
describe("T5 — 작업 채널·lobby", () => {
  function fakeClient(onWrite?: (raw: string) => void) {
    return { write: (raw: string) => onWrite?.(raw), close: () => {} };
  }

  it("작업 A의 state·notify는 A 클라이언트에만, B에는 없음", () => {
    const env = setup();
    const { orchestrator, store } = env;
    const taskA = seedTask(store, { assigned: { planner: "planner-1", verifier: null, coder: null } });
    const taskB = seedTask(store, { assigned: { planner: "planner-2", verifier: null, coder: null } });
    store.state.sessions["planner-1"] = { role: "planner", project: "EWE", folder: null, launchedAt: 0, sessionIds: ["p1"], activeSessionId: "p1", switchedOnce: false, task: taskA.id };

    const a: string[] = [];
    const b: string[] = [];
    const hub = orchestrator.getHub();
    hub.add(fakeClient((s) => a.push(s)), taskA.id);
    hub.add(fakeClient((s) => b.push(s)), taskB.id);

    // A에 notify — A 채널에만.
    orchestrator.emitNotify(taskA, "gate-v1", "warn", "x");
    expect(a.filter((s) => s.startsWith("event: notify\n"))).toHaveLength(1);
    expect(b).toHaveLength(0);

    // A 상태 변경(clearTimeline) — A 채널에만 state, B에는 없음.
    orchestrator.clearTimeline(taskA.id);
    const aState = a.filter((s) => s.startsWith("event: state\n"));
    expect(aState).toHaveLength(1);
    expect(JSON.parse(aState[0].split("data: ")[1]).task.id).toBe(taskA.id);
    expect(b).toHaveLength(0);

    env.cleanup();
  });

  it("lobby 클라이언트는 unattached를 받음 (전역 상태)", () => {
    const env = setup();
    const { orchestrator, store } = env;
    seedTask(store); // 클라이언트 없음 → unattached.
    const lobby: string[] = [];
    orchestrator.getHub().add(fakeClient((s) => lobby.push(s)), null);

    orchestrator.notifyAttachChange();
    expect(lobby).toHaveLength(1);
    const data = JSON.parse(lobby[0].split("data: ")[1]);
    expect(Array.isArray(data.unattached)).toBe(true);
    expect(data.unattached).toHaveLength(1);
    expect(data.unattached[0]).toHaveProperty("id");
    expect(data.unattached[0]).toHaveProperty("project");
    expect(data.unattached[0]).toHaveProperty("startedAt");

    env.cleanup();
  });

  it("A에 클라이언트 부착 시 unattached에서 A 제외, 해제 시 복귀", () => {
    const env = setup();
    const { orchestrator, store } = env;
    const taskA = seedTask(store);
    const hub = orchestrator.getHub();

    expect(orchestrator.getState(null).unattached.map((u) => u.id)).toContain(taskA.id);

    const client = fakeClient();
    hub.add(client, taskA.id);
    expect(orchestrator.getState(null).unattached.map((u) => u.id)).not.toContain(taskA.id);

    hub.remove(client);
    expect(orchestrator.getState(null).unattached.map((u) => u.id)).toContain(taskA.id);

    env.cleanup();
  });

  it("토스트 접두어 — [p/새 작업] , 바인딩 후 [p/<folder>] ", () => {
    const env = setup();
    const { orchestrator, store, toasts } = env;
    const task = seedTask(store); // folder null.

    orchestrator.emitNotify(task, "gate-v1", "warn", "x");
    expect(toasts).toEqual(["[EWE/새 작업] x"]);

    task.folder = "261111-alpha";
    orchestrator.emitNotify(task, "gate-v1", "warn", "y");
    expect(toasts).toEqual(["[EWE/새 작업] x", "[EWE/261111-alpha] y"]);

    env.cleanup();
  });

  it("세션 전환 경고 notify는 그 세션 작업 채널에만 (lobby에는 없음)", () => {
    const env = setup();
    const { orchestrator, store, sessions } = env;
    const taskA = seedTask(store, { assigned: { planner: "planner-1", verifier: null, coder: null } });
    store.state.sessions["planner-1"] = { role: "planner", project: "EWE", folder: null, launchedAt: 0, sessionIds: ["p1"], activeSessionId: "p1", switchedOnce: false, task: taskA.id };
    sessions.register("planner-1", "working");

    const a: string[] = [];
    const lobby: string[] = [];
    const hub = orchestrator.getHub();
    hub.add(fakeClient((s) => a.push(s)), taskA.id);
    hub.add(fakeClient((s) => lobby.push(s)), null);

    // 첫 Stop(p1) → 등록·파킹. 두 번째 Stop(p2) → 전환 감지 → onNotify.
    sessions.onStop("planner-1", "p1", () => {}, () => {});
    sessions.onStop("planner-1", "p2", () => {}, () => {});

    const aNotify = a.filter((s) => s.startsWith("event: notify\n"));
    expect(aNotify).toHaveLength(1);
    const data = JSON.parse(aNotify[0].split("data: ")[1]);
    expect(data.key).toBe("switch-planner-1");
    expect(data.level).toBe("warn");
    expect(lobby.filter((s) => s.startsWith("event: notify\n"))).toHaveLength(0);

    env.cleanup();
  });
});

// M3 §3 B·D — 커밋 계획·프로젝트 등록.
describe("M3 — projectIsGit·pendingAction·addProject", () => {
  function doneTask(env: ReturnType<typeof setup>, coderKey: string | null = null): Task {
    const { store, sessions, taskDir, folder } = env;
    const task = seedTask(store, {
      folder,
      assigned: { planner: null, verifier: null, coder: coderKey },
    });
    if (coderKey) {
      store.state.sessions[coderKey] = {
        role: "coder",
        project: "EWE",
        folder,
        launchedAt: 0,
        sessionIds: ["c1"],
        activeSessionId: "c1",
        switchedOnce: false,
        task: task.id,
      };
      sessions.register(coderKey, "working");
    }
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: DONE\n");
    fs.writeFileSync(path.join(taskDir, "todo-v1.md"), "- [ ] T1\n");
    return task;
  }

  it("projectIsGit — gitInfo { branch: 'main' }이면 CODER DONE Stop에서 CODER block(instructionCommitPlan), null이면 없음", () => {
    const env = setup({ gitInfo: () => ({ branch: "main" }) });
    doneTask(env, "coder-1");
    let reply: Reply | null = null;
    env.orchestrator.handleStop("coder-1", { session_id: "c1" }, (r) => (reply = r), () => {});
    expect(reply).toEqual({ action: "block", reason: instructionCommitPlan(1) });
    env.cleanup();

    const env2 = setup();
    doneTask(env2, "coder-1");
    let reply2: Reply | null = null;
    env2.orchestrator.handleStop("coder-1", { session_id: "c1" }, (r) => (reply2 = r), () => {});
    expect(reply2).toEqual({ action: "allow" });
    env2.cleanup();
  });

  it("pendingAction — DONE + checklist + git: 계획 없음 → commit 'none', 계획만 → 'planned', 로그 있음 → 'planned'(완료 미판정)", () => {
    const env = setup({ gitInfo: () => ({ branch: "main" }) });
    const task = doneTask(env);
    const { orchestrator, taskDir } = env;
    fs.writeFileSync(path.join(taskDir, "todo-v1-checklist.md"), "- [ ] 확인\n");

    expect(orchestrator.pendingAction(task)).toEqual({ kind: "done", t: 1, commit: "none" });

    fs.writeFileSync(path.join(taskDir, "todo-v1-commit.md"), "# todo-v1 커밋 계획\n## 커밋 1\n- 메시지: m\n");
    expect(orchestrator.pendingAction(task)).toEqual({ kind: "done", t: 1, commit: "planned" });

    fs.appendFileSync(path.join(taskDir, "todo-v1-commit.md"), "## 커밋 로그\n- abc1234 m\n");
    expect(orchestrator.pendingAction(task)).toEqual({ kind: "done", t: 1, commit: "planned" });

    env.cleanup();
  });

  it("pendingAction — ## 커밋 로그·해시 줄 있는 계획 + 체크리스트 + git → commit 'planned', coder idle → assignedDisplay.coder your-turn", () => {
    const env = setup({ gitInfo: () => ({ branch: "main" }) });
    const task = doneTask(env, "coder-1");
    const { orchestrator, sessions, taskDir } = env;
    sessions.register("coder-1", "idle");
    fs.writeFileSync(path.join(taskDir, "todo-v1-checklist.md"), "- [ ] 확인\n");
    fs.writeFileSync(
      path.join(taskDir, "todo-v1-commit.md"),
      "# todo-v1 커밋 계획\n## 커밋 1\n- 메시지: m\n- 파일: a.ts\n## 커밋 로그\n- abc1234 m\n",
    );
    const st = orchestrator.getState(task.id);
    expect(st.pendingAction).toEqual({ kind: "done", t: 1, commit: "planned" });
    expect(st.assignedDisplay.coder).toBe("your-turn");
    env.cleanup();
  });

  it("pendingAction — checklist 없음 + 계획만 → { kind: 'commit', t: 1 }, checklist 없음 + 로그 있음 → { kind: 'commit', t: 1 }(완료 미판정), git 아님 + 계획 파일 있음 → commit 'none'", () => {
    const env = setup({ gitInfo: () => ({ branch: "main" }) });
    const task = doneTask(env);
    const { orchestrator, taskDir } = env;
    fs.writeFileSync(path.join(taskDir, "todo-v1-commit.md"), "# todo-v1 커밋 계획\n## 커밋 1\n- 메시지: m\n");

    expect(orchestrator.pendingAction(task)).toEqual({ kind: "commit", t: 1 });

    fs.appendFileSync(path.join(taskDir, "todo-v1-commit.md"), "## 커밋 로그\n- abc1234 m\n");
    expect(orchestrator.pendingAction(task)).toEqual({ kind: "commit", t: 1 });

    env.cleanup();

    const env2 = setup();
    const task2 = doneTask(env2);
    fs.writeFileSync(path.join(env2.taskDir, "todo-v1-checklist.md"), "- [ ] 확인\n");
    fs.writeFileSync(path.join(env2.taskDir, "todo-v1-commit.md"), "# todo-v1 커밋 계획\n## 커밋 1\n- 메시지: m\n");
    expect(env2.orchestrator.pendingAction(task2)).toEqual({ kind: "done", t: 1, commit: "none" });
    env2.cleanup();
  });

  it("assignedDisplay.coder — done.commit 'planned' + coder idle → your-turn", () => {
    const env = setup({ gitInfo: () => ({ branch: "main" }) });
    const task = doneTask(env, "coder-1");
    const { orchestrator, sessions, taskDir } = env;
    sessions.register("coder-1", "idle");
    fs.writeFileSync(path.join(taskDir, "todo-v1-checklist.md"), "- [ ] 확인\n");
    fs.writeFileSync(path.join(taskDir, "todo-v1-commit.md"), "# todo-v1 커밋 계획\n## 커밋 1\n- 메시지: m\n");
    const st = orchestrator.getState(task.id);
    expect(st.pendingAction).toEqual({ kind: "done", t: 1, commit: "planned" });
    expect(st.assignedDisplay.coder).toBe("your-turn");
    env.cleanup();
  });

  it("addProject — 성공(파일·메모리·projectInfo·SSE state 1회), 중복 409, 없는 경로 400, protectedPaths 형식 오류 400, updateConfig false → 500·메모리 그대로", () => {
    const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "aism-cfg-"));
    const cfgPath = path.join(cfgDir, "config.json");
    fs.copyFileSync(path.join(AISM_ROOT, "aism.config.example.json"), cfgPath);
    const env = setup({ configPath: cfgPath });
    const { orchestrator, config } = env;

    const writes: string[] = [];
    orchestrator.getHub().add({ write: (raw) => writes.push(raw), close: () => {} });

    // 성공 — 설정 파일·메모리·projectInfo·SSE state 1회.
    const r1 = orchestrator.addProject({
      name: "NewProj",
      root: env.root,
      plansDir: ".claude/plans",
      protectedPaths: ["a/**"],
      roleOverlay: "roles/overlay.md",
    });
    expect(r1).toEqual({ status: 200, payload: { ok: true } });
    const fileData = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as { projects: Record<string, unknown> };
    expect(fileData.projects.NewProj).toEqual({
      root: env.root,
      plansDir: ".claude/plans",
      protectedPaths: ["a/**"],
      roleOverlay: "roles/overlay.md",
    });
    expect(config.projects.NewProj).toEqual({
      root: env.root,
      plansDir: ".claude/plans",
      protectedPaths: ["a/**"],
      roleOverlay: "roles/overlay.md",
    });
    expect(orchestrator.getState(null).projectInfo["NewProj"]).toBeDefined();
    expect(writes.filter((w) => w.startsWith("event: state\n"))).toHaveLength(1);

    // 중복 이름 → 409.
    const r2 = orchestrator.addProject({ name: "NewProj", root: env.root });
    expect(r2).toEqual({ status: 409, payload: { error: "project exists" } });

    // 없는 경로 → 400.
    const r3 = orchestrator.addProject({ name: "NoDir", root: path.join(env.root, "no-such-dir") });
    expect(r3).toEqual({ status: 400, payload: { error: "root not found" } });

    // protectedPaths 형식 오류 → 400.
    const r4 = orchestrator.addProject({ name: "BadProt", root: env.root, protectedPaths: ["ok", 1] });
    expect(r4).toEqual({ status: 400, payload: { error: "protectedPaths must be string array" } });

    env.cleanup();
    fs.rmSync(cfgDir, { recursive: true, force: true });

    // updateConfig false → 500, config.projects 그대로.
    const cfgDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "aism-cfg-"));
    const cfgPath2 = path.join(cfgDir2, "config.json");
    fs.copyFileSync(path.join(AISM_ROOT, "aism.config.example.json"), cfgPath2);
    const env2 = setup({ configPath: cfgPath2, updateConfig: () => false });
    const before = Object.keys(env2.config.projects).length;
    const r5 = env2.orchestrator.addProject({ name: "FailProj", root: env2.root });
    expect(r5).toEqual({ status: 500, payload: { error: "save failed" } });
    expect(Object.keys(env2.config.projects)).toHaveLength(before);
    env2.cleanup();
    fs.rmSync(cfgDir2, { recursive: true, force: true });
  });
});

// M3 polish §3 C — 프로젝트 제외.
describe("removeProject (M3 polish §3 C)", () => {
  it("성공(파일·메모리·projectInfo·SSE state 1회), 빈 name 400, 없는 이름 404, 활성 작업 프로젝트 409(파일 그대로), 마지막 제외 후 loadConfig 통과", () => {
    const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "aism-cfg-"));
    const cfgPath = path.join(cfgDir, "config.json");
    fs.copyFileSync(path.join(AISM_ROOT, "aism.config.example.json"), cfgPath);
    const env = setup({ configPath: cfgPath });
    const { orchestrator, config, store } = env;

    const writes: string[] = [];
    orchestrator.getHub().add({ write: (raw) => writes.push(raw), close: () => {} });

    // 빈 name → 400.
    expect(orchestrator.removeProject({})).toEqual({ status: 400, payload: { error: "name required" } });
    expect(orchestrator.removeProject({ name: "  " })).toEqual({ status: 400, payload: { error: "name required" } });

    // 없는 이름 → 404.
    expect(orchestrator.removeProject({ name: "NoProj" })).toEqual({ status: 404, payload: { error: "unknown project" } });

    // 작업이 있는 프로젝트 → 409 (파일 그대로).
    const task = seedTask(store);
    expect(orchestrator.removeProject({ name: "EWE" })).toEqual({ status: 409, payload: { error: "project in use" } });
    let fileData = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as { projects: Record<string, unknown> };
    expect(fileData.projects.EWE).toBeDefined();
    delete store.state.tasks[task.id];

    // 성공 → 200, 설정 파일·메모리·projectInfo에서 빠짐, SSE state 1회.
    const r = orchestrator.removeProject({ name: "EWE" });
    expect(r).toEqual({ status: 200, payload: { ok: true } });
    fileData = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as { projects: Record<string, unknown> };
    expect(fileData.projects.EWE).toBeUndefined();
    expect(config.projects.EWE).toBeUndefined();
    expect(orchestrator.getState(null).projectInfo["EWE"]).toBeUndefined();
    expect(writes.filter((w) => w.startsWith("event: state\n"))).toHaveLength(1);

    // 마지막 프로젝트 제외 후 설정 파일이 loadConfig 통과.
    loadConfig(cfgPath);

    env.cleanup();
    fs.rmSync(cfgDir, { recursive: true, force: true });

    // updateConfig false → 500, config.projects 그대로.
    const cfgDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "aism-cfg-"));
    const cfgPath2 = path.join(cfgDir2, "config.json");
    fs.copyFileSync(path.join(AISM_ROOT, "aism.config.example.json"), cfgPath2);
    const env2 = setup({ configPath: cfgPath2, updateConfig: () => false });
    const before = Object.keys(env2.config.projects).length;
    const r5 = env2.orchestrator.removeProject({ name: "EWE" });
    expect(r5).toEqual({ status: 500, payload: { error: "save failed" } });
    expect(Object.keys(env2.config.projects)).toHaveLength(before);
    env2.cleanup();
    fs.rmSync(cfgDir2, { recursive: true, force: true });
  });
});

// T3 — 여러 작업 동시 상태 (완료 조건).
describe("T3 — 멀티 작업", () => {
  it("두 작업 동시 handleStop — 각자 배정 게이트·평가 (A allow, B block, 서로 기록 안 섞임)", () => {
    const env = setup();
    const { orchestrator, store, sessions, taskDir, plansDir } = env;
    const taskA = seedTask(store, {
      folder: "261111-alpha",
      assigned: { planner: "planner-1", verifier: null, coder: null },
    });
    const taskB = seedTask(store, {
      folder: "261111-beta",
      assigned: { planner: "planner-2", verifier: null, coder: null },
    });
    store.state.sessions["planner-1"] = {
      role: "planner",
      project: "EWE",
      folder: "261111-alpha",
      launchedAt: 0,
      sessionIds: ["p1"],
      activeSessionId: "p1",
      switchedOnce: false,
      task: taskA.id,
    };
    store.state.sessions["planner-2"] = {
      role: "planner",
      project: "EWE",
      folder: "261111-beta",
      launchedAt: 0,
      sessionIds: ["p2"],
      activeSessionId: "p2",
      switchedOnce: false,
      task: taskB.id,
    };
    sessions.register("planner-1", "idle");
    sessions.register("planner-2", "idle");

    // A: IN_REVIEW + verify REVISE → 행 4 allow. B: IN_REVIEW + verify PASS(미기록) → 행 4p block.
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: IN_REVIEW\n");
    fs.writeFileSync(path.join(taskDir, "plan-v1-verify.md"), "# verify\n\n판정: REVISE\n");
    const betaDir = path.join(plansDir, "261111-beta");
    fs.mkdirSync(betaDir, { recursive: true });
    fs.writeFileSync(path.join(betaDir, "plan-v1.md"), "Status: IN_REVIEW\n");
    fs.writeFileSync(path.join(betaDir, "plan-v1-verify.md"), "# verify\n\n판정: PASS\n");

    let replyA: Reply | null = null;
    orchestrator.handleStop("planner-1", { session_id: "p1" }, (r) => (replyA = r), () => {});
    expect(replyA).toEqual({ action: "allow" });
    expect(taskA.record.instructed).toEqual([]);

    let replyB: Reply | null = null;
    orchestrator.handleStop("planner-2", { session_id: "p2" }, (r) => (replyB = r), () => {});
    expect(replyB).toEqual({ action: "block", reason: instructionApproveAndTodo(1) });
    expect(taskB.record.instructed).toContain("todo-v1");
    // A의 기록은 B의 Stop으로 바뀌지 않음.
    expect(taskA.record.instructed).toEqual([]);

    env.cleanup();
  });

  it("newTask — 같은 프로젝트 folder-null 작업 존재 시 409, 다른 프로젝트는 성공", () => {
    const env = setup();
    const { orchestrator, store, config } = env;

    const r1 = orchestrator.newTask("EWE");
    expect(r1.ok).toBe(true);
    expect(store.state.tasks[r1.taskId!].folder).toBeNull();

    // 같은 프로젝트의 두 번째 folder-null 작업 → 409.
    const r2 = orchestrator.newTask("EWE");
    expect(r2).toEqual({ ok: false, status: 409, error: "project has a new task" });

    // 다른 프로젝트 → 성공.
    config.projects["EWE2"] = { root: env.root, plansDir: ".claude/plans", protectedPaths: [] };
    const r3 = orchestrator.newTask("EWE2");
    expect(r3.ok).toBe(true);
    expect(store.state.tasks[r3.taskId!].project).toBe("EWE2");
    expect(Object.keys(store.state.tasks)).toHaveLength(2);

    env.cleanup();
  });

  it("바인딩 — 같은 프로젝트 다른 작업의 folder 제외 후 1개면 bind", () => {
    const env = setup();
    const { orchestrator, store, sessions, taskDir, plansDir } = env;
    const past = Date.now() - 100000;
    const taskA = seedTask(store, {
      folder: "261111-alpha",
      startedAt: past,
      assigned: { planner: "planner-1", verifier: null, coder: null },
    });
    const taskB = seedTask(store, {
      folder: null,
      startedAt: past,
      assigned: { planner: "planner-2", verifier: null, coder: null },
    });
    store.state.sessions["planner-1"] = {
      role: "planner",
      project: "EWE",
      folder: "261111-alpha",
      launchedAt: 0,
      sessionIds: ["p1"],
      activeSessionId: "p1",
      switchedOnce: false,
      task: taskA.id,
    };
    store.state.sessions["planner-2"] = {
      role: "planner",
      project: "EWE",
      folder: null,
      launchedAt: 0,
      sessionIds: ["p2"],
      activeSessionId: "p2",
      switchedOnce: false,
      task: taskB.id,
    };
    sessions.register("planner-1", "idle");
    sessions.register("planner-2", "unbound");

    // 두 폴더 모두 startedAt 이후 생성 — findNewPlanV1이 둘 다 찾음.
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "plan-v1.md"), "Status: DRAFT\n");
    const betaDir = path.join(plansDir, "261111-beta");
    fs.mkdirSync(betaDir, { recursive: true });
    fs.writeFileSync(path.join(betaDir, "plan-v1.md"), "Status: DRAFT\n");

    // B의 PLANNER Stop — A의 folder("261111-alpha") 제외 후 "261111-beta"만 남음 → bind.
    orchestrator.handleStop("planner-2", { session_id: "p2" }, () => {}, () => {});
    expect(taskB.folder).toBe("261111-beta");
    expect(taskA.folder).toBe("261111-alpha");

    env.cleanup();
  });

  it("relaunch·closeTask·clearTimeline — 없는 ID → 404 unknown task", () => {
    const env = setup();
    const { orchestrator } = env;
    expect(orchestrator.relaunch("t-none", "planner")).toEqual({ ok: false, status: 404, error: "unknown task" });
    expect(orchestrator.closeTask("t-none")).toEqual({ ok: false, status: 404, error: "unknown task" });
    expect(orchestrator.clearTimeline("t-none")).toEqual({ ok: false, status: 404, error: "unknown task" });
    env.cleanup();
  });

  it("closeTask — 그 작업만 삭제 (다른 작업 유지)", () => {
    const env = setup();
    const { orchestrator, store } = env;
    const taskA = seedTask(store);
    const taskB = seedTask(store);

    const r = orchestrator.closeTask(taskA.id);
    expect(r).toEqual({ ok: true, status: 200 });
    expect(store.state.tasks[taskA.id]).toBeUndefined();
    expect(store.state.tasks[taskB.id]).toBeDefined();

    env.cleanup();
  });

  it("getState(id).sessions — 그 작업 assigned 키만", () => {
    const env = setup();
    const { orchestrator, store } = env;
    const taskA = seedTask(store, {
      assigned: { planner: "planner-1", verifier: "verifier-1", coder: null },
    });
    const taskB = seedTask(store, {
      assigned: { planner: null, verifier: null, coder: "coder-1" },
    });
    store.state.sessions["planner-1"] = {
      role: "planner",
      project: "EWE",
      folder: null,
      launchedAt: 0,
      sessionIds: [],
      activeSessionId: null,
      switchedOnce: false,
      task: taskA.id,
    };
    store.state.sessions["verifier-1"] = {
      role: "verifier",
      project: "EWE",
      folder: null,
      launchedAt: 0,
      sessionIds: [],
      activeSessionId: null,
      switchedOnce: false,
      task: taskA.id,
    };
    store.state.sessions["coder-1"] = {
      role: "coder",
      project: "EWE",
      folder: null,
      launchedAt: 0,
      sessionIds: [],
      activeSessionId: null,
      switchedOnce: false,
      task: taskB.id,
    };

    const stA = orchestrator.getState(taskA.id);
    expect(Object.keys(stA.sessions).sort()).toEqual(["planner-1", "verifier-1"]);
    const stB = orchestrator.getState(taskB.id);
    expect(Object.keys(stB.sessions)).toEqual(["coder-1"]);

    env.cleanup();
  });
});

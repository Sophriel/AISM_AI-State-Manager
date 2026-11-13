// T12 — 오케스트레이션. Stop 수신 → 평가 → Action 적용, 상태·알림·세션 관리.
import fs from "node:fs";
import path from "node:path";
import type { AismConfig } from "./config.js";
import { AISM_ROOT } from "./config.js";
import type { ActiveTask, Store } from "./store.js";
import { newActiveTask } from "./store.js";
import type { Sessions, SessionState } from "./sessions.js";
import type { Snapshot } from "./artifacts.js";
import { readSnapshot as defaultReadSnapshot, findNewPlanV1 as defaultFindNewPlanV1 } from "./artifacts.js";
import type { Action, PeerView, Role, Reply } from "./machine.js";
import { evaluate, instructionApproveAndTodo } from "./machine.js";
import type { LaunchOptions } from "./launcher.js";
import { launchSession as defaultLaunch } from "./launcher.js";
import { NotifyHub } from "./notify.js";

export type PendingAction =
  | { kind: "deliver"; role: Role; text: string }
  | { kind: "decision" }
  | { kind: "gate"; n: number }
  | { kind: "pass"; n: number; text: string }
  | { kind: "todo" }
  | { kind: "describe" };

export interface OrchestratorDeps {
  config: AismConfig;
  store: Store;
  sessions: Sessions;
  hub?: NotifyHub;
  launch?: (opts: LaunchOptions) => { sessionKey: string; dir: string };
  readSnapshot?: (taskDir: string) => Snapshot;
  findNewPlanV1?: (plansDir: string, sinceMs: number) => string[];
  aismRoot?: string;
}

export class Orchestrator {
  private config: AismConfig;
  private store: Store;
  private sessions: Sessions;
  private hub: NotifyHub;
  private launch: (opts: LaunchOptions) => { sessionKey: string; dir: string };
  private readSnapshot: (taskDir: string) => Snapshot;
  private findNewPlanV1: (plansDir: string, sinceMs: number) => string[];
  private aismRoot: string;

  constructor(deps: OrchestratorDeps) {
    this.config = deps.config;
    this.store = deps.store;
    this.sessions = deps.sessions;
    this.hub = deps.hub ?? new NotifyHub();
    this.launch = deps.launch ?? defaultLaunch;
    this.readSnapshot = deps.readSnapshot ?? defaultReadSnapshot;
    this.findNewPlanV1 = deps.findNewPlanV1 ?? defaultFindNewPlanV1;
    this.aismRoot = deps.aismRoot ?? AISM_ROOT;
    this.sessions.onNotify = (key, level, message) => this.emitNotify(key, level, message);
  }

  getHub(): NotifyHub {
    return this.hub;
  }

  // POST /hook/stop — body { sessionKey, payload }.
  handleStop(
    sessionKey: string,
    payload: { session_id?: string; last_assistant_message?: string },
    reply: (r: Reply) => void,
    onClose: (cb: () => void) => void,
  ): void {
    // stop 이벤트 기록 (W3) — 어떤 판정보다 먼저.
    const msg = payload.last_assistant_message?.slice(0, 80);
    const stopRole = this.store.state.sessions[sessionKey]?.role;
    this.store.appendEvent({
      type: "stop",
      sessionKey,
      ...(stopRole ? { role: stopRole } : {}),
      ...(msg ? { message: msg } : {}),
    });

    const info = this.store.state.sessions[sessionKey];
    if (!info) {
      reply({ action: "allow" }); // 모르는 sessionKey — 즉시 allow.
      return;
    }

    // 배정 게이트 (W4) — 현재 작업에 배정된 세션이 아니면 즉시 allow (undelivered·session_id·평가 모두 생략).
    const task = this.store.state.activeTask;
    const role =
      task && (task.assigned.plan === sessionKey ? "plan" : task.assigned.verify === sessionKey ? "verify" : null);
    if (!role) {
      reply({ action: "allow" });
      return;
    }

    // 그 role의 undelivered 항목 삭제 (사용자가 창에서 진행했으므로).
    this.removeUndelivered(role);

    // session_id 처리 + 파킹. 비활성 id면 이미 allow.
    const { handled } = this.sessions.onStop(sessionKey, payload.session_id ?? "", reply, onClose);
    if (handled) return;

    // W1 — 바인딩한 Stop에서 바로 평가: 새 plan-v1이 정확히 1개면 bind 후 그 자리에서 평가.
    let newPlanFolders: string[] = [];
    if (role === "plan" && task.folder === null) {
      const found = this.findNewPlanV1(this.plansDir(task.project), task.startedAt);
      if (found.length === 1) {
        this.bindTask(found[0], sessionKey);
      } else {
        newPlanFolders = found; // 0개 또는 ≥2개 — 평가는 행 1이 처리.
      }
    }
    const snapshot = task.folder !== null ? this.taskSnapshot(task.project, task.folder) : emptySnapshot();
    const actions = evaluate({
      sender: { sessionKey, role, bound: task.folder !== null },
      taskActive: true, // 배정 게이트 통과 시 activeTask는 항상 존재.
      snapshot,
      newPlanFolders,
      peers: this.peersOf(task),
      record: task.record,
      config: { confirmFromVersion: this.config.confirmFromVersion, maxConsecutiveBlocks: this.config.maxConsecutiveBlocks },
    });

    this.applyActions(actions);
  }

  // 현재 작업에 배정된 역할별 세션 뷰 (W4).
  private peersOf(task: ActiveTask): { plan?: PeerView; verify?: PeerView } {
    const result: { plan?: PeerView; verify?: PeerView } = {};
    for (const role of ["plan", "verify"] as const) {
      const key = task.assigned[role];
      if (key) result[role] = { sessionKey: key, state: this.sessions.stateOf(key) ?? "detached" };
    }
    return result;
  }

  // 역할 배정 (W4) — 이전 키가 있으면 allow("unassigned")로 방출 후 교체.
  private assign(task: ActiveTask, role: Role, sessionKey: string): void {
    const prev = task.assigned[role];
    if (prev && prev !== sessionKey) this.sessions.resolve(prev, { action: "allow" }, "unassigned");
    task.assigned[role] = sessionKey;
  }

  // Action 적용.
  private applyActions(actions: Action[]): void {
    for (const action of actions) {
      switch (action.kind) {
        case "reply":
          this.sessions.resolve(action.sessionKey, action.reply);
          break;
        case "hold":
          // pending 유지 — 세션이 계속 파킹. hold 이벤트 기록 (W3).
          this.store.appendEvent({ type: "hold", sessionKey: action.sessionKey });
          break;
        case "launch":
          this.launchRole(action.role);
          break;
        case "notify":
          this.emitNotify(action.key, action.level, action.message, action.copyText);
          break;
        case "record": {
          const task = this.store.state.activeTask;
          if (task) {
            if (action.notified) task.record.notified = action.notified;
            if (action.consecutiveBlocks) task.record.consecutiveBlocks = action.consecutiveBlocks;
            if (action.instructed) task.record.instructed = action.instructed;
          }
          break;
        }
        case "undeliverable":
          this.addUndelivered(action.role, action.text);
          break;
      }
    }
    this.store.save();
    this.broadcastState();
  }

  // 역할 세션 실행 (launch Action).
  private launchRole(role: Role): void {
    const task = this.store.state.activeTask;
    if (!task) return;
    const result = this.launch({
      config: this.config,
      project: task.project,
      role,
      folder: task.folder,
      aismRoot: this.aismRoot,
      store: this.store,
    });
    this.sessions.register(result.sessionKey, role === "plan" && task.folder === null ? "unbound" : "launching");
    this.assign(task, role, result.sessionKey);
    this.store.appendEvent({ type: "launch", role, sessionKey: result.sessionKey });
  }

  // bind Action — activeTask·세션에 folder 기록.
  private bindTask(folder: string, senderKey: string): void {
    const task = this.store.state.activeTask;
    if (task) task.folder = folder;
    const info = this.store.state.sessions[senderKey];
    if (info) info.folder = folder;
    this.store.appendEvent({ type: "bind", folder, sessionKey: senderKey });
  }

  // undeliverable Action — activeTask.undelivered에 추가 + SSE notify.
  private addUndelivered(role: Role, text: string): void {
    const task = this.store.state.activeTask;
    if (!task) return;
    const filtered = task.undelivered.filter((u) => u.role !== role);
    filtered.push({ role, text });
    task.undelivered = filtered;
    this.emitNotify(`undeliverable-${role}`, "info", `${role.toUpperCase()} 창에 다음을 입력하세요`, text);
  }

  private removeUndelivered(role: Role): void {
    const task = this.store.state.activeTask;
    if (!task) return;
    task.undelivered = task.undelivered.filter((u) => u.role !== role);
  }

  // SSE notify + 이벤트 기록.
  emitNotify(key: string, level: "info" | "warn", message: string, copyText?: string): void {
    this.store.appendEvent({ type: "notify", key, level, message });
    this.hub.broadcast("notify", { key, level, message, copyText });
  }

  // 상태 변경 시 전체 상태 브로드캐스트.
  private broadcastState(): void {
    this.hub.broadcast("state", this.getState());
  }

  // GET /api/state.
  getState() {
    const task = this.store.state.activeTask;
    const sessions: Record<string, { role: Role; state: SessionState }> = {};
    for (const [key, info] of Object.entries(this.store.state.sessions)) {
      sessions[key] = { role: info.role, state: this.sessions.stateOf(key) ?? "detached" };
    }
    const assignedState = {
      plan: task?.assigned.plan ? (this.sessions.stateOf(task.assigned.plan) ?? "detached") : null,
      verify: task?.assigned.verify ? (this.sessions.stateOf(task.assigned.verify) ?? "detached") : null,
    };
    return {
      activeTask: task,
      assignedState,
      snapshot: task && task.folder !== null ? this.taskSnapshot(task.project, task.folder) : null,
      sessions,
      projects: Object.keys(this.config.projects),
      pendingAction: this.pendingAction(),
      events: this.store.readEvents().slice(-50),
    };
  }

  // pendingAction — 위에서부터 처음 맞는 하나만.
  pendingAction(): PendingAction | null {
    const task = this.store.state.activeTask;
    if (!task) return null;
    if (task.undelivered.length > 0) {
      const last = task.undelivered[task.undelivered.length - 1];
      return { kind: "deliver", role: last.role, text: last.text };
    }
    if (task.folder === null) return { kind: "describe" };

    const projectCfg = this.config.projects[task.project];
    if (!projectCfg) return null;
    const snapshot = this.taskSnapshot(task.project, task.folder);
    const N = snapshot.latestN;
    if (snapshot.status === "NEEDS_DECISION") return { kind: "decision" };
    if (snapshot.verdict === "REVISE" && N !== null && N >= this.config.confirmFromVersion) {
      const nextPlanExists = fs.existsSync(
        path.join(projectCfg.root, projectCfg.plansDir, task.folder, `plan-v${N + 1}.md`),
      );
      if (!nextPlanExists) return { kind: "gate", n: N };
    }
    if (snapshot.verdict === "PASS" && snapshot.status === "IN_REVIEW") {
      return { kind: "pass", n: N ?? 0, text: instructionApproveAndTodo(N ?? 0) };
    }
    if (snapshot.status === "TODO_READY") return { kind: "todo" };
    return null;
  }

  // POST /api/tasks/new.
  newTask(project: string): { ok: boolean; status: number; error?: string } {
    if (this.store.state.activeTask) return { ok: false, status: 409, error: "active task exists" };
    if (!this.config.projects[project]) return { ok: false, status: 404, error: "unknown project" };
    const task = newActiveTask(project, Date.now());
    this.store.state.activeTask = task;
    const result = this.launch({
      config: this.config,
      project,
      role: "plan",
      folder: null,
      aismRoot: this.aismRoot,
      store: this.store,
    });
    this.sessions.register(result.sessionKey, "unbound");
    this.assign(task, "plan", result.sessionKey);
    this.store.appendEvent({ type: "launch", role: "plan", sessionKey: result.sessionKey });
    this.store.save();
    this.broadcastState();
    return { ok: true, status: 200 };
  }

  // POST /api/tasks/relaunch — 배정 기준 (W4).
  relaunch(role: Role): { ok: boolean; status: number; error?: string } {
    const task = this.store.state.activeTask;
    if (!task) return { ok: false, status: 409, error: "no active task" };
    if (role === "verify" && task.folder === null) return { ok: false, status: 409, error: "folder is null" };
    const assignedKey = task.assigned[role];
    const st = assignedKey ? (this.sessions.stateOf(assignedKey) ?? "detached") : null;
    const allowed =
      st === null ||
      st === "detached" ||
      st === "idle" ||
      (role === "plan" && task.folder === null && st === "unbound");
    if (!allowed) return { ok: false, status: 409, error: `session is ${st}` };
    const result = this.launch({
      config: this.config,
      project: task.project,
      role,
      folder: task.folder,
      aismRoot: this.aismRoot,
      store: this.store,
    });
    this.sessions.register(result.sessionKey, role === "plan" && task.folder === null ? "unbound" : "launching");
    this.assign(task, role, result.sessionKey);
    this.store.appendEvent({ type: "launch", role, sessionKey: result.sessionKey, relaunch: true });
    this.store.save();
    this.broadcastState();
    return { ok: true, status: 200 };
  }

  // POST /api/tasks/close — 배정된 세션의 pending을 allow("task-closed")로 해제 (W4).
  closeTask(): void {
    const task = this.store.state.activeTask;
    if (task) {
      for (const key of [task.assigned.plan, task.assigned.verify]) {
        if (key) this.sessions.resolve(key, { action: "allow" }, "task-closed");
      }
    }
    this.store.state.activeTask = null;
    this.store.appendEvent({ type: "close-task" });
    this.store.save();
    this.broadcastState();
  }

  private plansDir(project: string): string {
    const cfg = this.config.projects[project];
    return cfg ? path.join(cfg.root, cfg.plansDir) : "";
  }

  private taskSnapshot(project: string, folder: string): Snapshot {
    return this.readSnapshot(path.join(this.plansDir(project), folder));
  }
}

function emptySnapshot(): Snapshot {
  return { latestN: null, status: null, verifyExists: false, verdict: null };
}

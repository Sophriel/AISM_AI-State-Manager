// T12 — 오케스트레이션. Stop 수신 → 평가 → Action 적용, 상태·알림·세션 관리.
import fs from "node:fs";
import path from "node:path";
import type { AismConfig } from "./config.js";
import { AISM_ROOT } from "./config.js";
import type { Store } from "./store.js";
import type { Sessions, SessionState } from "./sessions.js";
import type { Snapshot } from "./artifacts.js";
import { readSnapshot as defaultReadSnapshot, findNewPlanV1 as defaultFindNewPlanV1 } from "./artifacts.js";
import type { Action, Role, Reply } from "./machine.js";
import { evaluate } from "./machine.js";
import type { LaunchOptions } from "./launcher.js";
import { launchSession as defaultLaunch } from "./launcher.js";
import { NotifyHub } from "./notify.js";

export type PendingAction =
  | { kind: "deliver"; role: Role; text: string }
  | { kind: "decision" }
  | { kind: "gate"; n: number }
  | { kind: "pass"; n: number }
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
    payload: { sessionId?: string },
    reply: (r: Reply) => void,
    onClose: (cb: () => void) => void,
  ): void {
    const info = this.store.state.sessions[sessionKey];
    if (!info) {
      reply({ action: "allow" }); // 모르는 sessionKey — 즉시 allow.
      return;
    }

    // 그 role의 undelivered 항목 삭제 (사용자가 창에서 진행했으므로).
    this.removeUndelivered(info.role);

    // session_id 처리 + 파킹. 비활성 id면 이미 allow.
    const { handled } = this.sessions.onStop(sessionKey, payload.sessionId ?? "", reply, onClose);
    if (handled) return;

    // MachineInput 구성.
    const snapshot = info.folder !== null ? this.taskSnapshot(info.project, info.folder) : emptySnapshot();
    const newPlanFolders =
      info.role === "plan" && info.folder === null
        ? this.findNewPlanV1(this.plansDir(info.project), info.launchedAt)
        : [];
    const actions = evaluate({
      sender: { sessionKey, role: info.role, bound: info.folder !== null },
      taskActive: this.store.state.activeTask !== null,
      snapshot,
      newPlanFolders,
      peers: this.sessions.peersFor(info.project, info.folder),
      record: this.store.state.record,
      config: { confirmFromVersion: this.config.confirmFromVersion, maxConsecutiveBlocks: this.config.maxConsecutiveBlocks },
    });

    this.applyActions(actions, sessionKey);
  }

  // Action 적용.
  private applyActions(actions: Action[], senderKey: string): void {
    for (const action of actions) {
      switch (action.kind) {
        case "reply":
          this.sessions.resolve(action.sessionKey, action.reply);
          break;
        case "hold":
          // pending 유지 — 세션이 계속 파킹.
          break;
        case "launch":
          this.launchRole(action.role);
          break;
        case "bind":
          this.bindTask(action.folder, senderKey);
          break;
        case "notify":
          this.emitNotify(action.key, action.level, action.message, action.copyText);
          break;
        case "record":
          if (action.notified) this.store.state.record.notified = action.notified;
          if (action.consecutiveBlocks) this.store.state.record.consecutiveBlocks = action.consecutiveBlocks;
          break;
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

  // undeliverable Action — undelivered에 추가 + SSE notify.
  private addUndelivered(role: Role, text: string): void {
    const filtered = this.store.state.undelivered.filter((u) => u.role !== role);
    filtered.push({ role, text });
    this.store.state.undelivered = filtered;
    this.emitNotify(`undeliverable-${role}`, "info", `${role.toUpperCase()} 창에 다음을 입력하세요`, text);
  }

  private removeUndelivered(role: Role): void {
    this.store.state.undelivered = this.store.state.undelivered.filter((u) => u.role !== role);
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
    return {
      activeTask: task,
      snapshot: task && task.folder !== null ? this.taskSnapshot(task.project, task.folder) : null,
      sessions,
      projects: Object.keys(this.config.projects),
      pendingAction: this.pendingAction(),
      events: this.store.readEvents().slice(-50),
    };
  }

  // pendingAction — 위에서부터 처음 맞는 하나만.
  pendingAction(): PendingAction | null {
    const state = this.store.state;
    if (state.undelivered.length > 0) {
      const last = state.undelivered[state.undelivered.length - 1];
      return { kind: "deliver", role: last.role, text: last.text };
    }
    const task = state.activeTask;
    if (!task) return null;
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
    if (snapshot.verdict === "PASS" && snapshot.status === "IN_REVIEW") return { kind: "pass", n: N ?? 0 };
    return null;
  }

  // POST /api/tasks/new.
  newTask(project: string): { ok: boolean; status: number; error?: string } {
    if (this.store.state.activeTask) return { ok: false, status: 409, error: "active task exists" };
    if (!this.config.projects[project]) return { ok: false, status: 404, error: "unknown project" };
    this.store.state.activeTask = { project, folder: null, startedAt: Date.now() };
    const result = this.launch({
      config: this.config,
      project,
      role: "plan",
      folder: null,
      aismRoot: this.aismRoot,
      store: this.store,
    });
    this.sessions.register(result.sessionKey, "unbound");
    this.store.appendEvent({ type: "launch", role: "plan", sessionKey: result.sessionKey });
    this.store.save();
    this.broadcastState();
    return { ok: true, status: 200 };
  }

  // POST /api/tasks/relaunch.
  relaunch(role: Role): { ok: boolean; status: number; error?: string } {
    const task = this.store.state.activeTask;
    if (!task) return { ok: false, status: 409, error: "no active task" };
    if (task.folder === null) return { ok: false, status: 409, error: "folder is null" };
    const existing = Object.entries(this.store.state.sessions).find(
      ([, info]) => info.role === role && info.project === task.project && info.folder === task.folder,
    );
    if (existing) {
      const st = this.sessions.stateOf(existing[0]) ?? "detached";
      if (st !== "detached") return { ok: false, status: 409, error: `session is ${st}` };
    }
    const result = this.launch({
      config: this.config,
      project: task.project,
      role,
      folder: task.folder,
      aismRoot: this.aismRoot,
      store: this.store,
    });
    this.sessions.register(result.sessionKey, "launching");
    this.store.appendEvent({ type: "launch", role, sessionKey: result.sessionKey });
    this.store.save();
    this.broadcastState();
    return { ok: true, status: 200 };
  }

  // POST /api/tasks/close.
  closeTask(): void {
    for (const key of Object.keys(this.store.state.sessions)) {
      this.sessions.resolve(key, { action: "allow" });
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

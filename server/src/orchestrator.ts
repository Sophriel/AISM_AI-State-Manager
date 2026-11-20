// T12 — 오케스트레이션. Stop 수신 → 평가 → Action 적용, 상태·알림·세션 관리.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AismConfig, ProjectConfig } from "./config.js";
import { AISM_ROOT, updateConfigFile } from "./config.js";
import type { Task, Store } from "./store.js";
import { EVENT_TEXT_MAX, makeTaskId, newTask } from "./store.js";
import type { Sessions, SessionState } from "./sessions.js";
import type { Snapshot, TodoSnapshot } from "./artifacts.js";
import {
  readSnapshot as defaultReadSnapshot,
  findNewPlanV1 as defaultFindNewPlanV1,
  readTodoSnapshot as defaultReadTodoSnapshot,
  emptyTodoSnapshot,
} from "./artifacts.js";
import type { Action, PeerView, Role, Reply } from "./machine.js";
import { evaluate, instructionApproveAndTodo } from "./machine.js";
import type { LaunchOptions } from "./launcher.js";
import { launchSession as defaultLaunch } from "./launcher.js";
import { NotifyHub } from "./notify.js";
import type { GitInfo } from "./projects.js";
import { gitInfo as defaultGitInfo } from "./projects.js";
import { shouldToast, showToast } from "./toast.js";

export type PendingAction =
  | { kind: "deliver"; role: Role; text: string }
  | { kind: "decision" }
  | { kind: "gate"; n: number }
  | { kind: "pass"; n: number; text: string }
  | { kind: "todo-gate"; n: number }
  | { kind: "coder" }
  | { kind: "done"; t: number; commit: "none" | "planned" }
  | { kind: "commit"; t: number }
  | { kind: "describe" };

export type Display = "working" | "waiting" | "your-turn" | "idle" | "disconnected";

// pendingAction의 대상 역할 — deliver는 해당 역할, coder·done(커밋 허가 대기면 CODER)·commit은 CODER, 나머지는 PLANNER.
function targetOf(pa: PendingAction | null): Role | null {
  if (!pa) return null;
  if (pa.kind === "deliver") return pa.role;
  if (pa.kind === "coder") return "coder";
  if (pa.kind === "done") return pa.commit === "planned" ? "coder" : null;
  if (pa.kind === "commit") return "coder";
  return "planner";
}

export interface OrchestratorDeps {
  config: AismConfig;
  store: Store;
  sessions: Sessions;
  hub?: NotifyHub;
  launch?: (opts: LaunchOptions) => { sessionKey: string; dir: string };
  readSnapshot?: (taskDir: string) => Snapshot;
  readTodoSnapshot?: (taskDir: string) => TodoSnapshot;
  findNewPlanV1?: (plansDir: string, sinceMs: number) => string[];
  toast?: (title: string, message: string) => void;
  aismRoot?: string;
  gitInfo?: (root: string) => GitInfo | null;
  configPath?: string;
  updateConfig?: (p: string, mutate: (d: Record<string, unknown>) => void) => boolean;
}

export class Orchestrator {
  private config: AismConfig;
  private store: Store;
  private sessions: Sessions;
  private hub: NotifyHub;
  private launch: (opts: LaunchOptions) => { sessionKey: string; dir: string };
  private readSnapshot: (taskDir: string) => Snapshot;
  private readTodoSnapshot: (taskDir: string) => TodoSnapshot;
  private findNewPlanV1: (plansDir: string, sinceMs: number) => string[];
  private toast: (title: string, message: string) => void;
  private aismRoot: string;
  private gitInfo: (root: string) => GitInfo | null;
  private configPath: string | null;
  private updateConfig: (p: string, mutate: (d: Record<string, unknown>) => void) => boolean;
  private projectInfo: Record<string, { root: string; git: GitInfo | null }> = {};

  constructor(deps: OrchestratorDeps) {
    this.config = deps.config;
    this.store = deps.store;
    this.sessions = deps.sessions;
    this.hub = deps.hub ?? new NotifyHub();
    this.launch = deps.launch ?? defaultLaunch;
    this.readSnapshot = deps.readSnapshot ?? defaultReadSnapshot;
    this.readTodoSnapshot = deps.readTodoSnapshot ?? defaultReadTodoSnapshot;
    this.findNewPlanV1 = deps.findNewPlanV1 ?? defaultFindNewPlanV1;
    this.toast = deps.toast ?? showToast;
    this.aismRoot = deps.aismRoot ?? AISM_ROOT;
    this.gitInfo = deps.gitInfo ?? defaultGitInfo;
    this.configPath = deps.configPath ?? null;
    this.updateConfig = deps.updateConfig ?? ((p, m) => updateConfigFile(p, m));
    this.sessions.onNotify = (k, key, level, message) => this.emitNotify(this.taskOfSession(k), key, level, message);
    this.sessions.onChange = (k) => {
      const t = this.taskOfSession(k);
      if (t) this.broadcastTask(t);
      this.broadcastLobby();
    };
    this.refreshProjectInfo();
  }

  getHub(): NotifyHub {
    return this.hub;
  }

  // 프로젝트별 루트·git 정보 캐시 (M3 §3 D) — 시작·프로젝트 추가·newTask·closeTask 때 갱신.
  private refreshProjectInfo(): void {
    const next: Record<string, { root: string; git: GitInfo | null }> = {};
    for (const [name, p] of Object.entries(this.config.projects)) next[name] = { root: p.root, git: this.gitInfo(p.root) };
    this.projectInfo = next;
  }

  // POST /hook/stop — body { sessionKey, payload }.
  handleStop(
    sessionKey: string,
    payload: { session_id?: string; last_assistant_message?: string },
    reply: (r: Reply) => void,
    onClose: (cb: () => void) => void,
  ): void {
    // stop 이벤트 기록 (W3) — 어떤 판정보다 먼저. 세션이 배정된 작업 파일로 (T4).
    const msg = payload.last_assistant_message?.slice(0, EVENT_TEXT_MAX);
    const stopRole = this.store.state.sessions[sessionKey]?.role;
    this.store.appendSessionEvent(sessionKey, {
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

    // 배정 게이트 (W4) — 그 세션이 배정된 작업이 아니면 즉시 allow (undelivered·session_id·평가 모두 생략).
    const task = this.taskOfSession(sessionKey);
    const role =
      task ? ((["planner", "verifier", "coder"] as const).find((r) => task.assigned[r] === sessionKey) ?? null) : null;
    if (!task || !role) {
      reply({ action: "allow" });
      return;
    }

    // 그 role의 undelivered 항목 삭제 (사용자가 창에서 진행했으므로).
    this.removeUndelivered(task, role);

    // session_id 처리 + 파킹. 비활성 id면 이미 allow.
    const { handled } = this.sessions.onStop(sessionKey, payload.session_id ?? "", reply, onClose);
    if (handled) return;

    // W1 — 바인딩한 Stop에서 바로 평가: 새 plan-v1이 정확히 1개면 bind 후 그 자리에서 평가.
    let newPlanFolders: string[] = [];
    if (role === "planner" && task.folder === null) {
      // 같은 프로젝트 다른 작업의 folder는 제외 (T3 — 각 작업은 자기 폴더만).
      const otherFolders = new Set(
        Object.values(this.store.state.tasks)
          .filter((t) => t.project === task.project && t.id !== task.id && t.folder !== null)
          .map((t) => t.folder as string),
      );
      const found = this.findNewPlanV1(this.plansDir(task.project), task.startedAt).filter(
        (f) => !otherFolders.has(f),
      );
      if (found.length === 1) {
        this.bindTask(task, found[0], sessionKey);
      } else {
        newPlanFolders = found; // 0개 또는 ≥2개 — 평가는 행 1이 처리.
      }
    }
    const snapshot = task.folder !== null ? this.taskSnapshot(task.project, task.folder) : emptySnapshot();
    const actions = evaluate({
      sender: { sessionKey, role, bound: task.folder !== null },
      taskActive: true, // 배정 게이트 통과 시 task는 항상 존재.
      snapshot,
      todo: task.folder !== null ? this.todoSnapshot(task.project, task.folder) : emptyTodoSnapshot(),
      newPlanFolders,
      peers: this.peersOf(task),
      record: task.record,
      config: { confirmFromVersion: this.config.confirmFromVersion, maxConsecutiveBlocks: this.config.maxConsecutiveBlocks },
      projectIsGit: this.projectInfo[task.project]?.git != null,
    });

    this.applyActions(task, actions);
  }

  // 그 세션이 배정된 작업 — assigned에 그 키를 가진 첫 작업 (둘 이상이면 경고 후 첫 번째).
  private taskOfSession(sessionKey: string): Task | null {
    const matches = Object.values(this.store.state.tasks).filter((t) =>
      (["planner", "verifier", "coder"] as const).some((r) => t.assigned[r] === sessionKey),
    );
    if (matches.length > 1) console.warn(`session ${sessionKey} is assigned to multiple tasks — using the first`);
    return matches[0] ?? null;
  }

  private taskById(id: string): Task | null {
    return this.store.state.tasks[id] ?? null;
  }

  // 그 작업에 배정된 역할별 세션 뷰 (W4).
  private peersOf(task: Task): { planner?: PeerView; verifier?: PeerView; coder?: PeerView } {
    const result: { planner?: PeerView; verifier?: PeerView; coder?: PeerView } = {};
    for (const role of ["planner", "verifier", "coder"] as const) {
      const key = task.assigned[role];
      if (key) result[role] = { sessionKey: key, state: this.sessions.stateOf(key) ?? "detached" };
    }
    return result;
  }

  // 역할 배정 (W4) — 이전 키가 있으면 allow("unassigned")로 방출 후 교체.
  private assign(task: Task, role: Role, sessionKey: string): void {
    const prev = task.assigned[role];
    if (prev && prev !== sessionKey) this.sessions.resolve(prev, { action: "allow" }, "unassigned");
    task.assigned[role] = sessionKey;
  }

  // Action 적용.
  private applyActions(task: Task, actions: Action[]): void {
    for (const action of actions) {
      switch (action.kind) {
        case "reply":
          this.sessions.resolve(action.sessionKey, action.reply);
          break;
        case "hold":
          // pending 유지 — 세션이 계속 파킹. hold 이벤트 기록 (W3). 세션 작업 파일로 (T4).
          this.store.appendSessionEvent(action.sessionKey, { type: "hold", sessionKey: action.sessionKey });
          break;
        case "launch":
          this.launchRole(task, action.role, action.instruction);
          break;
        case "notify":
          this.emitNotify(task, action.key, action.level, action.message, action.copyText);
          break;
        case "record": {
          if (action.notified) task.record.notified = action.notified;
          if (action.consecutiveBlocks) task.record.consecutiveBlocks = action.consecutiveBlocks;
          if (action.instructed) task.record.instructed = action.instructed;
          break;
        }
        case "undeliverable":
          this.addUndelivered(task, action.role, action.text);
          break;
      }
    }
    this.store.save();
    this.broadcastTask(task);
    this.broadcastLobby();
  }

  // 역할 세션 실행 (launch Action). instruction이 있으면 첫 지시로 전달·기록 (M2 polish §3 B).
  private launchRole(task: Task, role: Role, instruction?: string): void {
    const result = this.launch({
      config: this.config,
      project: task.project,
      role,
      folder: task.folder,
      aismRoot: this.aismRoot,
      store: this.store,
      task: task.id,
      ...(instruction ? { firstInstruction: instruction } : {}),
    });
    this.sessions.register(result.sessionKey, role === "planner" && task.folder === null ? "unbound" : "working");
    this.assign(task, role, result.sessionKey);
    this.store.appendSessionEvent(result.sessionKey, {
      type: "launch",
      role,
      sessionKey: result.sessionKey,
      ...(instruction ? { instruction: instruction.slice(0, EVENT_TEXT_MAX) } : {}),
    });
  }

  // bind Action — task·세션에 folder 기록.
  private bindTask(task: Task, folder: string, senderKey: string): void {
    task.folder = folder;
    const info = this.store.state.sessions[senderKey];
    if (info) info.folder = folder;
    this.store.appendTaskEvent(task.id, { type: "bind", folder, sessionKey: senderKey });
  }

  // undeliverable Action — task.undelivered에 추가 + SSE notify.
  private addUndelivered(task: Task, role: Role, text: string): void {
    const filtered = task.undelivered.filter((u) => u.role !== role);
    filtered.push({ role, text });
    task.undelivered = filtered;
    this.emitNotify(task, `undeliverable-${role}`, "info", `${role.toUpperCase()} 창에 다음을 입력하세요`, text);
  }

  private removeUndelivered(task: Task, role: Role): void {
    task.undelivered = task.undelivered.filter((u) => u.role !== role);
  }

  // SSE notify + 이벤트 기록 + Windows 토스트 (G-5). task 있으면 그 작업 채널·작업 파일, 없으면 전역 파일만.
  emitNotify(task: Task | null, key: string, level: "info" | "warn", message: string, copyText?: string): void {
    if (task) {
      this.store.appendTaskEvent(task.id, { type: "notify", key, level, message });
      this.hub.send(task.id, "notify", { key, level, message, copyText });
    } else {
      this.store.appendEvent({ type: "notify", key, level, message });
    }
    const toastMsg = task ? `[${task.project}/${task.folder ?? "새 작업"}] ${message}` : message;
    if (this.config.toast !== false && shouldToast(level, key)) this.toast("AISM", toastMsg);
  }

  // 그 작업 채널에만 state 전달 (T5).
  private broadcastTask(task: Task): void {
    this.hub.send(task.id, "state", this.getState(task.id));
  }

  // 시작 화면(lobby) 채널에 전역 상태 전달 — unattached 포함.
  private broadcastLobby(): void {
    this.hub.sendLobby("state", this.getState(null));
  }

  // SSE 클라이언트 연결·해제 시 lobby(unattached) 갱신 — index.ts /api/events가 호출.
  notifyAttachChange(): void {
    this.broadcastLobby();
  }

  // 표시 상태 계산 (plan-v3 §3 B 규칙 1~6).
  private displayOf(role: Role, task: Task | null, pa: PendingAction | null): Display | null {
    if (!task) return null;
    const key = task.assigned[role];
    if (!key) return null; // 배정 없음
    const st = this.sessions.stateOf(key) ?? "detached"; // 모르면 detached
    if (st === "detached") return "disconnected";
    if (st === "working") return "working";
    if (st === "parked") return "waiting";
    if (st === "unbound") return "your-turn";
    return targetOf(pa) === role ? "your-turn" : "idle"; // idle
  }

  // GET /api/state?task= — taskId 없거나 없는 ID면 task null (전역 키는 그대로).
  getState(taskId: string | null) {
    const task = taskId ? this.store.state.tasks[taskId] ?? null : null;
    // sessions — 그 작업 assigned의 키만.
    const sessions: Record<string, { role: Role; state: SessionState; resumable: boolean }> = {};
    if (task) {
      for (const role of ["planner", "verifier", "coder"] as const) {
        const key = task.assigned[role];
        if (!key) continue;
        const info = this.store.state.sessions[key];
        sessions[key] = {
          role,
          state: this.sessions.stateOf(key) ?? "detached",
          resumable: info ? info.activeSessionId !== null : false,
        };
      }
    }
    // 그 작업의 마지막 clear-timeline 이후 이벤트만 (그 이벤트 자체는 제외). 작업 없으면 [] (T4).
    let events: Array<Record<string, unknown>> = [];
    if (task) {
      const all = this.store.readTaskEvents(task.id);
      let start = 0;
      for (let i = all.length - 1; i >= 0; i--) {
        if (all[i].type === "clear-timeline") {
          start = i + 1;
          break;
        }
      }
      events = all.slice(start).slice(-50);
    }
    const pa = this.pendingAction(task);
    // unattached — 클라이언트가 붙지 않은 작업 (lobby 시작 화면 목록). 전역(null) 응답에만.
    const unattached = task
      ? undefined
      : Object.values(this.store.state.tasks)
          .filter((t) => this.hub.attachedCount(t.id) === 0)
          .sort((a, b) => a.startedAt - b.startedAt)
          .map((t) => ({ id: t.id, project: t.project, folder: t.folder, startedAt: t.startedAt }));
    const assignedState = {
      planner: task?.assigned.planner ? (this.sessions.stateOf(task.assigned.planner) ?? "detached") : null,
      verifier: task?.assigned.verifier ? (this.sessions.stateOf(task.assigned.verifier) ?? "detached") : null,
      coder: task?.assigned.coder ? (this.sessions.stateOf(task.assigned.coder) ?? "detached") : null,
    };
    const assignedDisplay = {
      planner: this.displayOf("planner", task, pa),
      verifier: this.displayOf("verifier", task, pa),
      coder: this.displayOf("coder", task, pa),
    };
    return {
      task,
      assignedState,
      assignedDisplay,
      snapshot: task && task.folder !== null ? this.taskSnapshot(task.project, task.folder) : null,
      todo: task && task.folder !== null ? this.todoSnapshot(task.project, task.folder) : null,
      sessions,
      projects: Object.keys(this.config.projects),
      projectInfo: this.projectInfo,
      pendingAction: pa,
      events,
      ...(task ? {} : { unattached }),
    };
  }

  // pendingAction — 위에서부터 처음 맞는 하나만.
  pendingAction(task: Task | null): PendingAction | null {
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
    if (snapshot.status === "TODO_READY") {
      const todo = this.todoSnapshot(task.project, task.folder);
      const T = todo.latestN;
      if (
        T !== null &&
        todo.verdict === "REVISE" &&
        T >= this.config.confirmFromVersion &&
        !fs.existsSync(path.join(projectCfg.root, projectCfg.plansDir, task.folder, `todo-v${T + 1}.md`))
      ) {
        return { kind: "todo-gate", n: T };
      }
    }
    if (snapshot.status === "IN_PROGRESS") {
      const key = task.assigned.coder;
      if (key && this.sessions.stateOf(key) === "idle") return { kind: "coder" };
    }
    if (snapshot.status === "DONE") {
      const todo = this.todoSnapshot(task.project, task.folder);
      const T = todo.latestN;
      if (T !== null) {
        const isGit = this.projectInfo[task.project]?.git != null;
        const commit = !isGit || !todo.commitPlanExists ? "none" : "planned";
        if (todo.checklistExists) return { kind: "done", t: T, commit };
        if (commit === "planned") return { kind: "commit", t: T };
      }
    }
    return null;
  }

  // POST /api/tasks/new — 같은 프로젝트에 미바인딩(folder null) 작업이 있으면 409.
  newTask(project: string): { ok: boolean; status: number; error?: string; taskId?: string } {
    if (Object.values(this.store.state.tasks).some((t) => t.project === project && t.folder === null))
      return { ok: false, status: 409, error: "project has a new task" };
    if (!this.config.projects[project]) return { ok: false, status: 404, error: "unknown project" };
    this.refreshProjectInfo();
    const id = makeTaskId(new Date(), crypto.randomBytes(2).toString("hex"));
    const task = newTask(id, project, Date.now());
    this.store.state.tasks[id] = task;
    const result = this.launch({
      config: this.config,
      project,
      role: "planner",
      folder: null,
      aismRoot: this.aismRoot,
      store: this.store,
      task: id,
    });
    this.sessions.register(result.sessionKey, "unbound");
    this.assign(task, "planner", result.sessionKey);
    this.store.appendSessionEvent(result.sessionKey, { type: "launch", role: "planner", sessionKey: result.sessionKey });
    this.store.save();
    this.broadcastTask(task);
    this.broadcastLobby();
    return { ok: true, status: 200, taskId: id };
  }

  // POST /api/tasks/relaunch — 배정 기준 (W4). mode "resume" = 이전 세션 이어서 (S-9).
  relaunch(taskId: string, role: Role, mode: "new" | "resume" = "new"): { ok: boolean; status: number; error?: string } {
    const task = this.taskById(taskId);
    if (!task) return { ok: false, status: 404, error: "unknown task" };
    if ((role === "verifier" || role === "coder") && task.folder === null)
      return { ok: false, status: 409, error: "folder is null" };
    const assignedKey = task.assigned[role];
    const st = assignedKey ? (this.sessions.stateOf(assignedKey) ?? "detached") : null;
    const allowed =
      st === null ||
      st === "detached" ||
      st === "idle" ||
      st === "working" ||
      (role === "planner" && task.folder === null && st === "unbound");
    if (!allowed) return { ok: false, status: 409, error: `session is ${st}` };
    const resumeId = assignedKey ? (this.store.state.sessions[assignedKey]?.activeSessionId ?? null) : null;
    if (
      mode === "resume" &&
      (task.folder === null || resumeId === null || !(st === "detached" || st === "idle" || st === "working"))
    ) {
      return { ok: false, status: 409, error: "cannot resume" };
    }
    // 전달 못 한 지시가 있으면 새 세션의 첫 지시로 넘기고 바로 삭제 (M2 polish §3 B).
    const pendingText = task.undelivered.find((u) => u.role === role)?.text;
    const result = this.launch({
      config: this.config,
      project: task.project,
      role,
      folder: task.folder,
      aismRoot: this.aismRoot,
      store: this.store,
      task: task.id,
      ...(mode === "resume" && resumeId ? { resumeSessionId: resumeId } : {}),
      ...(pendingText ? { firstInstruction: pendingText } : {}),
    });
    this.sessions.register(
      result.sessionKey,
      mode === "resume" ? "working" : role === "planner" && task.folder === null ? "unbound" : "working",
    );
    this.assign(task, role, result.sessionKey);
    if (pendingText) this.removeUndelivered(task, role);
    this.store.appendSessionEvent(result.sessionKey, {
      type: "launch",
      role,
      sessionKey: result.sessionKey,
      relaunch: true,
      ...(mode === "resume" ? { resume: true } : {}),
      ...(pendingText ? { instruction: pendingText.slice(0, EVENT_TEXT_MAX) } : {}),
    });
    this.store.save();
    this.broadcastTask(task);
    this.broadcastLobby();
    return { ok: true, status: 200 };
  }

  // POST /api/tasks/close — 배정된 세션의 pending을 allow("task-closed")로 해제 (W4). 그 작업만 삭제.
  closeTask(taskId: string): { ok: boolean; status: number; error?: string } {
    const task = this.taskById(taskId);
    if (!task) return { ok: false, status: 404, error: "unknown task" };
    for (const key of [task.assigned.planner, task.assigned.verifier, task.assigned.coder]) {
      if (key) this.sessions.resolve(key, { action: "allow" }, "task-closed");
    }
    // close-task 이벤트를 작업 삭제 **전**에 그 작업 파일에 기록 (T4).
    this.store.appendTaskEvent(taskId, { type: "close-task" });
    delete this.store.state.tasks[taskId];
    this.store.save();
    this.refreshProjectInfo();
    // 작업이 이미 삭제 — getState(taskId)는 task: null을 반환해 그 창을 시작 화면으로 되돌림.
    this.hub.send(taskId, "state", this.getState(taskId));
    this.broadcastLobby();
    return { ok: true, status: 200 };
  }

  // POST /api/timeline/clear — 그 작업 타임라인만 비운다. 작업 이벤트 파일은 그대로 (M2 polish §3 C, T4).
  clearTimeline(taskId: string): { ok: boolean; status: number; error?: string } {
    const task = this.taskById(taskId);
    if (!task) return { ok: false, status: 404, error: "unknown task" };
    this.store.appendTaskEvent(taskId, { type: "clear-timeline" });
    this.broadcastTask(task);
    this.broadcastLobby();
    return { ok: true, status: 200 };
  }

  // POST /api/projects — 프로젝트 등록 (M3 §3 D). 설정 파일에 저장(loadConfig 검증) 후 메모리 반영.
  addProject(body: unknown): { status: number; payload: Record<string, unknown> } {
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const name = typeof b.name === "string" ? b.name.trim() : "";
    const root = typeof b.root === "string" ? b.root.trim() : "";
    if (!name || !root) return { status: 400, payload: { error: "name and root required" } };
    if (this.config.projects[name]) return { status: 409, payload: { error: "project exists" } };
    let isDir = false;
    try {
      isDir = fs.statSync(root).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) return { status: 400, payload: { error: "root not found" } };
    const plansDir = typeof b.plansDir === "string" && b.plansDir.trim() ? b.plansDir.trim() : ".claude/plans";
    let protectedPaths: string[] = [];
    if (b.protectedPaths !== undefined) {
      if (!Array.isArray(b.protectedPaths) || !b.protectedPaths.every((s) => typeof s === "string"))
        return { status: 400, payload: { error: "protectedPaths must be string array" } };
      protectedPaths = b.protectedPaths as string[];
    }
    if (b.roleOverlay !== undefined && typeof b.roleOverlay !== "string")
      return { status: 400, payload: { error: "roleOverlay must be string" } };
    const overlay = typeof b.roleOverlay === "string" ? b.roleOverlay.trim() : "";
    const proj: ProjectConfig = { root, plansDir, protectedPaths, ...(overlay ? { roleOverlay: overlay } : {}) };
    if (!this.configPath) return { status: 500, payload: { error: "save failed" } };
    const ok = this.updateConfig(this.configPath, (d) => {
      const projects = (typeof d.projects === "object" && d.projects !== null ? d.projects : {}) as Record<string, unknown>;
      projects[name] = proj;
      d.projects = projects;
    });
    if (!ok) return { status: 500, payload: { error: "save failed" } };
    this.config.projects[name] = proj;
    this.refreshProjectInfo();
    for (const t of Object.values(this.store.state.tasks)) this.broadcastTask(t);
    this.broadcastLobby();
    return { status: 200, payload: { ok: true } };
  }

  // POST /api/projects/remove — 프로젝트 제외 (M3 polish §3 C). 설정 파일에서만 뺀다(폴더·파일은 그대로).
  removeProject(body: unknown): { status: number; payload: Record<string, unknown> } {
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name) return { status: 400, payload: { error: "name required" } };
    if (!this.config.projects[name]) return { status: 404, payload: { error: "unknown project" } };
    if (Object.values(this.store.state.tasks).some((t) => t.project === name))
      return { status: 409, payload: { error: "project in use" } };
    if (!this.configPath) return { status: 500, payload: { error: "save failed" } };
    const ok = this.updateConfig(this.configPath, (d) => {
      if (typeof d.projects === "object" && d.projects !== null) delete (d.projects as Record<string, unknown>)[name];
    });
    if (!ok) return { status: 500, payload: { error: "save failed" } };
    delete this.config.projects[name];
    this.refreshProjectInfo();
    for (const t of Object.values(this.store.state.tasks)) this.broadcastTask(t);
    this.broadcastLobby();
    return { status: 200, payload: { ok: true } };
  }

  private plansDir(project: string): string {
    const cfg = this.config.projects[project];
    return cfg ? path.join(cfg.root, cfg.plansDir) : "";
  }

  private taskSnapshot(project: string, folder: string): Snapshot {
    return this.readSnapshot(path.join(this.plansDir(project), folder));
  }

  private todoSnapshot(project: string, folder: string): TodoSnapshot {
    return this.readTodoSnapshot(path.join(this.plansDir(project), folder));
  }
}

function emptySnapshot(): Snapshot {
  return { latestN: null, status: null, verifyExists: false, verdict: null };
}

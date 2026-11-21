// T7 — 상태 저장소. state/state.json + state/events.jsonl (AISM_ROOT 기준).
// 쓰기는 임시 파일에 쓴 뒤 rename (원자적 교체).
import fs from "node:fs";
import path from "node:path";
import { AISM_ROOT } from "./config.js";
import type { TaskRecord, Role } from "./machine.js";

export interface Task {
  id: string;
  project: string;
  folder: string | null;
  startedAt: number;
  assigned: { planner: string | null; verifier: string | null; coder: string | null };
  record: TaskRecord;
  undelivered: Undelivered[];
  commitDone: boolean;
}

export interface SessionInfo {
  role: Role;
  project: string;
  folder: string | null;
  launchedAt: number;
  sessionIds: string[];
  activeSessionId: string | null;
  switchedOnce: boolean;
  task: string | null; // 그 세션을 띄운 작업. 서버 밖 세션·옛 세션은 null.
}

export interface Undelivered {
  role: Role;
  text: string;
}

export interface CodingLock {
  task: string;
  since: number;
}

export interface CodingWait {
  task: string;
  sessionKey: string;
  text: string;
  since: number;
}

export interface State {
  tasks: Record<string, Task>;
  sessions: Record<string, SessionInfo>;
  codingLocks: Record<string, CodingLock>;
  codingQueue: CodingWait[];
}

export type EventType = "stop" | "reply" | "launch" | "bind" | "notify" | "detach" | "close-task" | "hold" | "clear-timeline";

export const EVENT_TEXT_MAX = 2000; // 이벤트에 저장하는 응답·지시 문구 최대 길이 (M2 polish §3 A)

const emptyState = (): State => ({
  tasks: {},
  sessions: {},
  codingLocks: {},
  codingQueue: [],
});

// 작업 ID — t-<YYYYMMDD>-<HHmmss>-<hex> (launcher makeSessionKey와 같은 시각 형식, 로컬 시간).
export function makeTaskId(now: Date, hex: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `t-${ts}-${hex}`;
}

export function newTask(id: string, project: string, startedAt: number): Task {
  return {
    id,
    project,
    folder: null,
    startedAt,
    assigned: { planner: null, verifier: null, coder: null },
    record: { notified: [], consecutiveBlocks: {}, instructed: [] },
    undelivered: [],
    commitDone: false,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

const isNumMap = (v: unknown): v is Record<string, number> =>
  isObj(v) && Object.values(v).every((x) => typeof x === "number");

// "현재 형식" 검사 — 키가 정확히 일치하고 타입이 맞아야 true.
// 최상위 키는 정확히 tasks·sessions·codingLocks·codingQueue, 각 작업 키 8개(id 포함)·tasks[k].id === k, 각 세션에 task(string|null).
// codingLocks 값은 키 정확히 task(string)·since(number), codingQueue 항목은 키 정확히 task·sessionKey·text(string)·since(number).
// 옛 형식(activeTask, 1단계 형식)은 이 검사를 통과하지 못해 기존 규칙대로 버려지고 경고한다.
export function isCurrentState(x: unknown): x is State {
  if (!isObj(x)) return false;
  const topKeys = Object.keys(x);
  if (
    topKeys.length !== 4 ||
    !topKeys.includes("tasks") ||
    !topKeys.includes("sessions") ||
    !topKeys.includes("codingLocks") ||
    !topKeys.includes("codingQueue")
  )
    return false;

  const tasks = x.tasks;
  if (!isObj(tasks)) return false;
  for (const [k, t] of Object.entries(tasks)) {
    if (!isObj(t)) return false;
    const tKeys = Object.keys(t);
    const expectedT = ["id", "project", "folder", "startedAt", "assigned", "record", "undelivered", "commitDone"];
    if (tKeys.length !== expectedT.length || !expectedT.every((key) => tKeys.includes(key))) return false;
    if (t.id !== k) return false;
    if (typeof t.project !== "string") return false;
    if (t.folder !== null && typeof t.folder !== "string") return false;
    if (typeof t.startedAt !== "number") return false;

    const a = t.assigned;
    if (!isObj(a)) return false;
    const aKeys = Object.keys(a);
    if (aKeys.length !== 3 || !aKeys.includes("planner") || !aKeys.includes("verifier") || !aKeys.includes("coder"))
      return false;
    for (const key of ["planner", "verifier", "coder"]) {
      const v = a[key];
      if (v !== null && typeof v !== "string") return false;
    }

    const r = t.record;
    if (!isObj(r)) return false;
    const rKeys = Object.keys(r);
    if (
      rKeys.length !== 3 ||
      !rKeys.includes("notified") ||
      !rKeys.includes("consecutiveBlocks") ||
      !rKeys.includes("instructed")
    )
      return false;
    if (!isStrArr(r.notified)) return false;
    if (!isNumMap(r.consecutiveBlocks)) return false;
    if (!isStrArr(r.instructed)) return false;

    const u = t.undelivered;
    if (!Array.isArray(u)) return false;
    for (const item of u) {
      if (!isObj(item)) return false;
      const uKeys = Object.keys(item);
      if (uKeys.length !== 2 || !uKeys.includes("role") || !uKeys.includes("text")) return false;
      if (!["planner", "verifier", "coder"].includes(item.role as string)) return false;
      if (typeof item.text !== "string") return false;
    }
    if (typeof t.commitDone !== "boolean") return false;
  }

  const s = x.sessions;
  if (!isObj(s)) return false;
  for (const info of Object.values(s)) {
    if (!isObj(info)) return false;
    const sKeys = Object.keys(info);
    const expectedS = [
      "role",
      "project",
      "folder",
      "launchedAt",
      "sessionIds",
      "activeSessionId",
      "switchedOnce",
      "task",
    ];
    if (sKeys.length !== expectedS.length || !expectedS.every((key) => sKeys.includes(key))) return false;
    if (!["planner", "verifier", "coder"].includes(info.role as string)) return false;
    if (typeof info.project !== "string") return false;
    if (info.folder !== null && typeof info.folder !== "string") return false;
    if (typeof info.launchedAt !== "number") return false;
    if (!isStrArr(info.sessionIds)) return false;
    if (info.activeSessionId !== null && typeof info.activeSessionId !== "string") return false;
    if (typeof info.switchedOnce !== "boolean") return false;
    if (info.task !== null && typeof info.task !== "string") return false;
  }

  const cl = x.codingLocks;
  if (!isObj(cl)) return false;
  for (const v of Object.values(cl)) {
    if (!isObj(v)) return false;
    const clKeys = Object.keys(v);
    if (clKeys.length !== 2 || !clKeys.includes("task") || !clKeys.includes("since")) return false;
    if (typeof v.task !== "string" || typeof v.since !== "number") return false;
  }

  const cq = x.codingQueue;
  if (!Array.isArray(cq)) return false;
  for (const item of cq) {
    if (!isObj(item)) return false;
    const cqKeys = Object.keys(item);
    if (
      cqKeys.length !== 4 ||
      !cqKeys.includes("task") ||
      !cqKeys.includes("sessionKey") ||
      !cqKeys.includes("text") ||
      !cqKeys.includes("since")
    )
      return false;
    if (typeof item.task !== "string" || typeof item.sessionKey !== "string" || typeof item.text !== "string" || typeof item.since !== "number")
      return false;
  }

  return true;
}

export class Store {
  private dir: string;
  private statePath: string;
  private eventsPath: string;
  state: State;
  private formatWarned = false;

  constructor(dir?: string) {
    this.dir = dir ?? path.join(AISM_ROOT, "state");
    this.statePath = path.join(this.dir, "state.json");
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.state = this.readState();
  }

  private readState(): State {
    let raw: string;
    try {
      raw = fs.readFileSync(this.statePath, "utf8");
    } catch {
      return emptyState(); // 파일 없음 — 경고 없음.
    }
    let p: unknown;
    try {
      p = JSON.parse(raw);
    } catch {
      return emptyState(); // 파싱 실패 — 경고 없음.
    }
    if (!isCurrentState(p)) {
      if (!this.formatWarned) {
        console.warn("state.json이 현재 형식과 맞지 않아 무시했습니다 — 빈 상태로 시작합니다");
        this.formatWarned = true;
      }
      return emptyState();
    }
    return p;
  }

  // 디스크에서 state.json을 다시 읽어 메모리 상태를 갱신한다.
  load(): State {
    this.state = this.readState();
    return this.state;
  }

  // 메모리 상태를 state.json에 원자적으로 쓴다 (tmp → rename).
  save(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
    fs.renameSync(tmp, this.statePath);
  }

  // events.jsonl에 한 줄 ({ ts, type, ... })을 추가한다. ts 미지정 시 현재 시각.
  appendEvent(e: { type: EventType } & Record<string, unknown>): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const payload: Record<string, unknown> = { ts: (e as { ts?: number }).ts ?? Date.now(), ...e };
    fs.appendFileSync(this.eventsPath, JSON.stringify(payload) + "\n", "utf8");
  }

  // events.jsonl 전체를 배열로 읽는다 (파일 없으면 빈 배열).
  readEvents(): Array<Record<string, unknown>> {
    return this.readJsonl(this.eventsPath);
  }

  private readJsonl(p: string): Array<Record<string, unknown>> {
    try {
      const raw = fs.readFileSync(p, "utf8");
      return raw
        .split(/\r?\n/)
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      return [];
    }
  }

  // tasks/<taskId>/events.jsonl에 한 줄을 추가한다 (appendEvent와 같은 형식, ts 미지정 시 현재 시각).
  appendTaskEvent(taskId: string, e: { type: EventType } & Record<string, unknown>): void {
    const dir = path.join(this.dir, "tasks", taskId);
    fs.mkdirSync(dir, { recursive: true });
    const payload: Record<string, unknown> = { ts: (e as { ts?: number }).ts ?? Date.now(), ...e };
    fs.appendFileSync(path.join(dir, "events.jsonl"), JSON.stringify(payload) + "\n", "utf8");
  }

  // tasks/<taskId>/events.jsonl 전체를 배열로 읽는다 (파일 없으면 빈 배열).
  readTaskEvents(taskId: string): Array<Record<string, unknown>> {
    return this.readJsonl(path.join(this.dir, "tasks", taskId, "events.jsonl"));
  }

  // 세션의 이벤트를 기록 — 그 세션이 배정된 작업(state.tasks에 존재)이 있으면 그 작업 파일, 없으면 전역 events.jsonl.
  appendSessionEvent(sessionKey: string, e: { type: EventType } & Record<string, unknown>): void {
    const taskId = this.state.sessions[sessionKey]?.task;
    if (taskId && this.state.tasks[taskId]) {
      this.appendTaskEvent(taskId, e);
    } else {
      this.appendEvent(e);
    }
  }
}

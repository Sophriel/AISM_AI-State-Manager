// T7 — 상태 저장소. state/state.json + state/events.jsonl (AISM_ROOT 기준).
// 쓰기는 임시 파일에 쓴 뒤 rename (원자적 교체).
import fs from "node:fs";
import path from "node:path";
import { AISM_ROOT } from "./config.js";
import type { TaskRecord, Role } from "./machine.js";

export interface ActiveTask {
  project: string;
  folder: string | null;
  startedAt: number;
  assigned: { planner: string | null; verifier: string | null; coder: string | null };
  record: TaskRecord;
  undelivered: Undelivered[];
}

export interface SessionInfo {
  role: Role;
  project: string;
  folder: string | null;
  launchedAt: number;
  sessionIds: string[];
  activeSessionId: string | null;
  switchedOnce: boolean;
}

export interface Undelivered {
  role: Role;
  text: string;
}

export interface State {
  activeTask: ActiveTask | null;
  sessions: Record<string, SessionInfo>;
}

export type EventType = "stop" | "reply" | "launch" | "bind" | "notify" | "detach" | "close-task" | "hold";

const emptyState = (): State => ({
  activeTask: null,
  sessions: {},
});

export function newActiveTask(project: string, startedAt: number): ActiveTask {
  return {
    project,
    folder: null,
    startedAt,
    assigned: { planner: null, verifier: null, coder: null },
    record: { notified: [], consecutiveBlocks: {}, instructed: [] },
    undelivered: [],
  };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

const isNumMap = (v: unknown): v is Record<string, number> =>
  isObj(v) && Object.values(v).every((x) => typeof x === "number");

// plan-v3 §3 A "현재 형식" 검사 — 키가 정확히 일치하고 타입이 맞아야 true.
export function isCurrentState(x: unknown): x is State {
  if (!isObj(x)) return false;
  const topKeys = Object.keys(x);
  if (topKeys.length !== 2 || !topKeys.includes("activeTask") || !topKeys.includes("sessions")) return false;

  const t = x.activeTask;
  if (t !== null) {
    if (!isObj(t)) return false;
    const tKeys = Object.keys(t);
    const expectedT = ["project", "folder", "startedAt", "assigned", "record", "undelivered"];
    if (tKeys.length !== expectedT.length || !expectedT.every((k) => tKeys.includes(k))) return false;
    if (typeof t.project !== "string") return false;
    if (t.folder !== null && typeof t.folder !== "string") return false;
    if (typeof t.startedAt !== "number") return false;

    const a = t.assigned;
    if (!isObj(a)) return false;
    const aKeys = Object.keys(a);
    if (aKeys.length !== 3 || !aKeys.includes("planner") || !aKeys.includes("verifier") || !aKeys.includes("coder"))
      return false;
    for (const k of ["planner", "verifier", "coder"]) {
      const v = a[k];
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
  }

  const s = x.sessions;
  if (!isObj(s)) return false;
  for (const info of Object.values(s)) {
    if (!isObj(info)) return false;
    const sKeys = Object.keys(info);
    const expectedS = ["role", "project", "folder", "launchedAt", "sessionIds", "activeSessionId", "switchedOnce"];
    if (sKeys.length !== expectedS.length || !expectedS.every((k) => sKeys.includes(k))) return false;
    if (!["planner", "verifier", "coder"].includes(info.role as string)) return false;
    if (typeof info.project !== "string") return false;
    if (info.folder !== null && typeof info.folder !== "string") return false;
    if (typeof info.launchedAt !== "number") return false;
    if (!isStrArr(info.sessionIds)) return false;
    if (info.activeSessionId !== null && typeof info.activeSessionId !== "string") return false;
    if (typeof info.switchedOnce !== "boolean") return false;
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
    try {
      const raw = fs.readFileSync(this.eventsPath, "utf8");
      return raw
        .split(/\r?\n/)
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      return [];
    }
  }
}

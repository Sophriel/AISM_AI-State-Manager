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
  record: TaskRecord;
  undelivered: Undelivered[];
}

export type EventType = "stop" | "reply" | "launch" | "bind" | "notify" | "detach" | "close-task";

const emptyState = (): State => ({
  activeTask: null,
  sessions: {},
  record: { notified: [], consecutiveBlocks: {} },
  undelivered: [],
});

export class Store {
  private dir: string;
  private statePath: string;
  private eventsPath: string;
  state: State;

  constructor(dir?: string) {
    this.dir = dir ?? path.join(AISM_ROOT, "state");
    this.statePath = path.join(this.dir, "state.json");
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.state = this.readState();
  }

  private readState(): State {
    try {
      const raw = fs.readFileSync(this.statePath, "utf8");
      const p = JSON.parse(raw) as Partial<State>;
      return {
        activeTask: p.activeTask ?? null,
        sessions: p.sessions ?? {},
        record: p.record ?? { notified: [], consecutiveBlocks: {} },
        undelivered: p.undelivered ?? [],
      };
    } catch {
      return emptyState();
    }
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

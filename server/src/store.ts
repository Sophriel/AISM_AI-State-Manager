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
  assigned: { plan: string | null; verify: string | null };
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
    assigned: { plan: null, verify: null },
    record: { notified: [], consecutiveBlocks: {}, instructed: [] },
    undelivered: [],
  };
}

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
      // 기존 형식 호환: activeTask에 assigned/record/undelivered가 없으면 빈 값으로 채운다.
      // 최상위 record/undelivered는 읽지 않고 버린다 (plan-v8 W6).
      const t = p.activeTask;
      const r = t?.record;
      return {
        activeTask: t
          ? {
              ...t,
              assigned: t.assigned ?? { plan: null, verify: null },
              record: {
                notified: r?.notified ?? [],
                consecutiveBlocks: r?.consecutiveBlocks ?? {},
                instructed: r?.instructed ?? [],
              },
              undelivered: t.undelivered ?? [],
            }
          : null,
        sessions: p.sessions ?? {},
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

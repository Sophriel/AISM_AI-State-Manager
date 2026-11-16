// T13 — 서버 API 클라이언트. 타입 정의 + fetch 래퍼.
export type Role = "planner" | "verifier" | "coder";

export type SessionState =
  | "unbound"
  | "working"
  | "parked"
  | "idle"
  | "detached";

// 표시 상태 (plan-v3 §3 B) — 내부 세션 상태를 사용자가 보는 눈높이로 압축.
export type Display = "working" | "waiting" | "your-turn" | "idle" | "disconnected";

export type Status =
  | "DRAFT"
  | "NEEDS_DECISION"
  | "IN_REVIEW"
  | "APPROVED"
  | "TODO_READY"
  | "IN_PROGRESS"
  | "BLOCKED"
  | "DONE";

export interface Snapshot {
  latestN: number | null;
  status: Status | "MISSING" | null;
  verifyExists: boolean;
  verdict: "PASS" | "REVISE" | "MALFORMED" | null;
}

export interface TodoSnapshot {
  latestN: number | null;
  verifyExists: boolean;
  verdict: "PASS" | "REVISE" | "MALFORMED" | null;
}

export interface ActiveTask {
  project: string;
  folder: string | null;
  startedAt: number;
  assigned: { planner: string | null; verifier: string | null; coder: string | null };
}

export type PendingAction =
  | { kind: "deliver"; role: Role; text: string }
  | { kind: "decision" }
  | { kind: "gate"; n: number }
  | { kind: "pass"; n: number; text: string }
  | { kind: "todo-gate"; n: number }
  | { kind: "coder" }
  | { kind: "done" }
  | { kind: "describe" };

export interface SessionView {
  role: Role;
  state: SessionState;
  resumable: boolean;
}

// 서버 이벤트 (state/events.jsonl 한 줄). 타입: stop/reply/hold/launch/bind/notify/detach/close-task.
export interface AismEvent {
  ts: number;
  type: string;
  [key: string]: unknown;
}

export interface State {
  activeTask: ActiveTask | null;
  assignedState: { planner: SessionState | null; verifier: SessionState | null; coder: SessionState | null };
  assignedDisplay: { planner: Display | null; verifier: Display | null; coder: Display | null };
  snapshot: Snapshot | null;
  todo: TodoSnapshot | null;
  sessions: Record<string, SessionView>;
  projects: string[];
  pendingAction: PendingAction | null;
  events: AismEvent[];
}

// SSE notify 페이로드.
export interface NotifyPayload {
  key: string;
  level: "info" | "warn";
  message: string;
  copyText?: string;
}

export async function fetchState(): Promise<State> {
  const res = await fetch("/api/state");
  if (!res.ok) throw new Error(`GET /api/state → ${res.status}`);
  return (await res.json()) as State;
}

async function postJson(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) detail = ` (${j.error})`;
    } catch {
      /* ignore */
    }
    throw new Error(`POST ${path} → ${res.status}${detail}`);
  }
}

export function newTask(project: string): Promise<void> {
  return postJson("/api/tasks/new", { project });
}

export function relaunch(role: Role, mode: "new" | "resume" = "new"): Promise<void> {
  return postJson("/api/tasks/relaunch", { role, mode });
}

export function closeTask(): Promise<void> {
  return postJson("/api/tasks/close", {});
}

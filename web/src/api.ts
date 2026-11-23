// T13 — 서버 API 클라이언트. 타입 정의 + fetch 래퍼.
export type Role = "planner" | "verifier" | "coder";

export type SessionState =
  | "unbound"
  | "working"
  | "parked"
  | "idle"
  | "detached";

// 표시 상태 (plan-v3 §3 B) — 내부 세션 상태를 사용자가 보는 눈높이로 압축.
export type Display = "working" | "waiting" | "your-turn" | "idle" | "disconnected" | "queued";

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
  checklistExists: boolean;
  commitPlanExists: boolean;
}

export interface Task {
  id: string;
  project: string;
  folder: string | null;
  startedAt: number;
  assigned: { planner: string | null; verifier: string | null; coder: string | null };
  commitDone: boolean;
}

export type PendingAction =
  | { kind: "deliver"; role: Role; text: string }
  | { kind: "decision" }
  | { kind: "gate"; n: number }
  | { kind: "pass"; n: number; text: string }
  | { kind: "todo-gate"; n: number }
  | { kind: "coder" }
  | { kind: "done"; t: number; commit: "none" | "planned" | "done" }
  | { kind: "commit"; t: number }
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
  task: Task | null;
  unattached?: Array<{ id: string; project: string; folder: string | null; startedAt: number }>;
  assignedState: { planner: SessionState | null; verifier: SessionState | null; coder: SessionState | null };
  assignedDisplay: { planner: Display | null; verifier: Display | null; coder: Display | null };
  endpointNames: string[];
  endpoints: Record<Role, string> | null;
  snapshot: Snapshot | null;
  todo: TodoSnapshot | null;
  sessions: Record<string, SessionView>;
  projects: string[];
  projectInfo: Record<string, ProjectInfo>;
  pendingAction: PendingAction | null;
  queue: { role: "planner" | "verifier" | "coder"; reason: "local" | "coding" } | null;
  events: AismEvent[];
}

// 프로젝트별 루트·git 정보 (M3 §3 D).
export interface ProjectInfo {
  root: string;
  git: { branch: string | null } | null;
}

// 프로젝트 추가 요청 (M3 §3 D).
export interface NewProject {
  name: string;
  root: string;
  plansDir: string;
  protectedPaths: string[];
  roleOverlay?: string;
}

// SSE notify 페이로드.
export interface NotifyPayload {
  key: string;
  level: "info" | "warn";
  message: string;
  copyText?: string;
}

export async function fetchState(taskId: string | null): Promise<State> {
  const url = taskId ? `/api/state?task=${encodeURIComponent(taskId)}` : "/api/state";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
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

// 새 작업 — 응답 taskId 반환 (T8). folder 지정 시 기존 plan 폴더로 시작 (N2).
export async function newTask(project: string, folder?: string): Promise<string> {
  const res = await fetch("/api/tasks/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(folder !== undefined ? { project, folder } : { project }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) detail = ` (${j.error})`;
    } catch {
      /* ignore */
    }
    throw new Error(`POST /api/tasks/new → ${res.status}${detail}`);
  }
  const j = (await res.json()) as { taskId: string };
  return j.taskId;
}

// 기존 plan 폴더 후보 — plan-v1.md가 있고 미바인딩인 폴더 (N2).
export async function listFolders(project: string): Promise<string[]> {
  const url = `/api/projects/${encodeURIComponent(project)}/folders`;
  const res = await fetch(url);
  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) detail = ` (${j.error})`;
    } catch {
      /* ignore */
    }
    throw new Error(`GET ${url} → ${res.status}${detail}`);
  }
  const j = (await res.json()) as { folders: string[] };
  return j.folders;
}

export function relaunch(taskId: string, role: Role, mode: "new" | "resume" = "new"): Promise<void> {
  return postJson("/api/tasks/relaunch", { task: taskId, role, mode });
}

// 역할별 엔드포인트(모델) 선택 — 작업 단위. 세션 창이 열려 있으면 서버 409.
export function setEndpoint(taskId: string, role: Role, endpoint: string): Promise<void> {
  return postJson("/api/tasks/endpoint", { task: taskId, role, endpoint });
}

export function closeTask(taskId: string): Promise<void> {
  return postJson("/api/tasks/close", { task: taskId });
}

export function commitDone(taskId: string): Promise<void> {
  return postJson("/api/tasks/commit-done", { task: taskId });
}

export function clearTimeline(taskId: string): Promise<void> {
  return postJson("/api/timeline/clear", { task: taskId });
}

export function saveWindowSize(width: number, height: number): Promise<void> {
  return postJson("/api/ui/window", { width, height });
}

export function addProject(p: NewProject): Promise<void> {
  return postJson("/api/projects", p);
}

export function removeProject(name: string): Promise<void> {
  return postJson("/api/projects/remove", { name });
}

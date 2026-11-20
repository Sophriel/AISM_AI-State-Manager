// T13 — 작업 카드. 프로젝트·폴더·plan vN·Status·판정·역할 상태 배지·pendingAction 표시.
import type { Display, PendingAction, State } from "../api";

// 표시 상태별 색·라벨 (plan-v3 §3 B).
const DISPLAY_COLORS: Record<Display, string> = {
  working: "#4a90d9",
  waiting: "#8a8f98",
  "your-turn": "#f5a623",
  idle: "#7ed321",
  disconnected: "#d0021b",
};

const DISPLAY_LABELS: Record<Display, string> = {
  working: "작업 중",
  waiting: "대기",
  "your-turn": "사용자 차례",
  idle: "쉬는 중",
  disconnected: "끊김",
};

// pendingAction → T12에 적힌 문구. UI는 해소 여부를 직접 판단하지 않는다.
function pendingActionText(pa: PendingAction): string {
  switch (pa.kind) {
    case "deliver":
      return pa.text;
    case "decision":
      return "PLANNER 창에서 결정 사항을 논의하세요";
    case "gate":
      return `계속 개정하려면 PLANNER 창에서 지시하세요 (v${pa.n})`;
    case "pass":
      return pa.text;
    case "todo-gate":
      return `계속 개정하려면 PLANNER 창에서 지시하세요 (todo-v${pa.n})`;
    case "coder":
      return "CODER가 멈췄습니다 — CODER 창을 확인하세요";
    case "done":
      return `체크리스트로 테스트한 뒤 작업을 종료하세요 (todo-v${pa.t}-checklist.md)`;
    case "commit":
      return `CODER 창에서 커밋 계획(todo-v${pa.t}-commit.md)을 확인하고 허가하세요`;
    case "describe":
      return "PLANNER 창에서 작업을 설명하세요";
  }
}

// done의 둘째 줄 — 커밋 상태 (M3 §3 C).
function pendingActionSub(pa: PendingAction): string | null {
  if (pa.kind !== "done") return null;
  if (pa.commit === "planned") return `CODER 창에서 커밋 계획(todo-v${pa.t}-commit.md)을 확인하고 허가하세요`;
  return null;
}

function Badge({ display }: { display: Display | null }) {
  const color = display ? DISPLAY_COLORS[display] : "#ccc";
  const label = display ? DISPLAY_LABELS[display] : "없음";
  return (
    <span className="badge" style={{ background: color }}>
      {label}
    </span>
  );
}

interface Props {
  state: State | null;
  planDisplay: Display | null;
  verifyDisplay: Display | null;
  coderDisplay: Display | null;
}

function TaskCard({ state, planDisplay, verifyDisplay, coderDisplay }: Props) {
  const task = state?.task ?? null;
  const snap = state?.snapshot ?? null;
  const pa = state?.pendingAction ?? null;

  return (
    <div className="task-card">
      <div className="task-row">
        <span className="label">프로젝트</span>
        <span className="value">{task ? task.project : "—"}</span>
        {task && state?.projectInfo?.[task.project]?.git && (
          <span className="value">{`git: ${state.projectInfo[task.project].git?.branch ?? "?"}`}</span>
        )}
        <span className="label">폴더</span>
        <span className="value">{task ? (task.folder ?? "새 작업") : "—"}</span>
      </div>
      <div className="task-row">
        <span className="label">Plan</span>
        <span className="value">{snap?.latestN != null ? `v${snap.latestN}` : "—"}</span>
        <span className="label">Status</span>
        <span className="value">{snap?.status ?? "—"}</span>
        <span className="label">판정</span>
        <span className={`value verdict-${(snap?.verdict ?? "none").toLowerCase()}`}>
          {snap?.verdict ?? "—"}
        </span>
      </div>
      <div className="task-row">
        <span className="label">Todo</span>
        <span className="value">{state?.todo?.latestN != null ? `v${state.todo.latestN}` : "—"}</span>
        <span className="label">판정</span>
        <span className={`value verdict-${(state?.todo?.verdict ?? "none").toLowerCase()}`}>
          {state?.todo?.verdict ?? "—"}
        </span>
        <span className="label">커밋</span>
        <span className="value">{!state?.todo || !state.todo.commitPlanExists ? "—" : "계획"}</span>
      </div>
      <div className="task-row sessions">
        <span className="label">PLANNER</span>
        <Badge display={planDisplay} />
        <span className="label">VERIFIER</span>
        <Badge display={verifyDisplay} />
        <span className="label">CODER</span>
        <Badge display={coderDisplay} />
      </div>
      {pa && (
        <div className="pending-action">
          <span className="pending-text">{pendingActionText(pa)}</span>
          {(pa.kind === "deliver" || pa.kind === "pass") && (
            <button
              type="button"
              className="copy-btn"
              onClick={() => navigator.clipboard.writeText(pa.text)}
            >
              복사
            </button>
          )}
        </div>
      )}
      {pa && pendingActionSub(pa) && <div className="pending-hint">{pendingActionSub(pa)}</div>}
      {pa && pa.kind === "deliver" &&
        (pa.role === "planner" ? planDisplay : pa.role === "verifier" ? verifyDisplay : coderDisplay) ===
          "disconnected" && (
          <div className="pending-hint">
            창을 닫았다면 '{pa.role.toUpperCase()} 이어서 띄우기'(같은 대화) 또는 '{pa.role.toUpperCase()} 다시
            띄우기'(새 대화)를 누르세요
          </div>
        )}
    </div>
  );
}

export default TaskCard;

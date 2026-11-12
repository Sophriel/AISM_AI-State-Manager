// T13 — 작업 카드. 프로젝트·폴더·plan vN·Status·판정·역할 상태 배지·pendingAction 표시.
import type { PendingAction, State } from "../api";

// 6개 세션 상태 각각 다른 색.
const STATE_COLORS: Record<string, string> = {
  launching: "#8a8f98",
  unbound: "#b57edc",
  working: "#f5a623",
  parked: "#4a90d9",
  idle: "#7ed321",
  detached: "#9aa0a6",
};

const STATE_LABELS: Record<string, string> = {
  launching: "launching",
  unbound: "unbound",
  working: "working",
  parked: "parked",
  idle: "idle",
  detached: "detached",
};

// pendingAction → T12에 적힌 문구. UI는 해소 여부를 직접 판단하지 않는다.
function pendingActionText(pa: PendingAction): string {
  switch (pa.kind) {
    case "deliver":
      return pa.text;
    case "decision":
      return "PLAN 창에서 결정 사항을 논의하세요";
    case "gate":
      return `계속 개정하려면 PLAN 창에서 지시하세요 (v${pa.n})`;
    case "pass":
      return `PASS — 다음 단계는 PLAN 창에서 지시하세요 (v${pa.n})`;
    case "describe":
      return "PLAN 창에서 작업을 설명하세요";
  }
}

function Badge({ state }: { state: string | null }) {
  const color = state ? STATE_COLORS[state] ?? "#ccc" : "#ccc";
  const label = state ? STATE_LABELS[state] ?? state : "없음";
  return (
    <span className="badge" style={{ background: color }}>
      {label}
    </span>
  );
}

interface Props {
  state: State | null;
  planState: string | null;
  verifyState: string | null;
}

function TaskCard({ state, planState, verifyState }: Props) {
  const task = state?.activeTask ?? null;
  const snap = state?.snapshot ?? null;
  const pa = state?.pendingAction ?? null;

  return (
    <div className="task-card">
      <div className="task-row">
        <span className="label">프로젝트</span>
        <span className="value">{task ? task.project : "—"}</span>
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
      <div className="task-row sessions">
        <span className="label">PLAN</span>
        <Badge state={planState} />
        <span className="label">VERIFY</span>
        <Badge state={verifyState} />
      </div>
      {pa && (
        <div className="pending-action">
          <span className="pending-text">{pendingActionText(pa)}</span>
          {pa.kind === "deliver" && (
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
    </div>
  );
}

export default TaskCard;

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
    case "todo":
      return "todo 작성 완료 — CODER 세션에서 진행하세요";
    case "describe":
      return "PLANNER 창에서 작업을 설명하세요";
  }
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
}

function TaskCard({ state, planDisplay, verifyDisplay }: Props) {
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
        <span className="label">PLANNER</span>
        <Badge display={planDisplay} />
        <span className="label">VERIFIER</span>
        <Badge display={verifyDisplay} />
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
    </div>
  );
}

export default TaskCard;

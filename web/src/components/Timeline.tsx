// T13 — 타임라인. 최근 이벤트 50개, 최신이 위.
import type { AismEvent } from "../api";

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

// 역할 표시 — e.role이 있으면 대문자, 없으면 sessionKey 접두사(plan-/verify-)로, 둘 다 아니면 ?.
function roleOf(e: AismEvent): string {
  const role = e.role;
  if (typeof role === "string") return role.toUpperCase();
  const key = str(e.sessionKey);
  if (key.startsWith("plan-")) return "PLAN";
  if (key.startsWith("verify-")) return "VERIFY";
  return "?";
}

function describeEvent(e: AismEvent): string {
  const t = new Date(e.ts).toLocaleTimeString();
  switch (e.type) {
    case "stop": {
      const message = str(e.message);
      return `${t}  ${roleOf(e)} 응답 종료${message ? `: ${message}` : ""}`;
    }
    case "reply": {
      if (e.action === "block") return `${t}  ${roleOf(e)} ← 지시: ${str(e.reason)}`;
      return `${t}  ${roleOf(e)} ← 허용${e.reason ? ` (${str(e.reason)})` : ""}`;
    }
    case "hold":
      return `${t}  ${roleOf(e)} 대기`;
    case "launch":
      return `${t}  Launch  ${str(e.role)}`;
    case "bind":
      return `${t}  Bind  ${str(e.folder)}`;
    case "notify":
      return `${t}  [${str(e.level)}]  ${str(e.message)}`;
    case "detach":
      return `${t}  Detach  ${str(e.sessionKey)}`;
    case "close-task":
      return `${t}  작업 종료`;
    default:
      return `${t}  ${e.type}`;
  }
}

function Timeline({ events }: { events: AismEvent[] }) {
  const sorted = [...events].sort((a, b) => b.ts - a.ts);
  return (
    <div className="timeline">
      <h2>타임라인</h2>
      <ul>
        {sorted.map((e, i) => (
          <li key={`${e.ts}-${i}`} className={e.type === "notify" ? "notify" : ""}>
            {describeEvent(e)}
          </li>
        ))}
        {sorted.length === 0 && <li className="empty">이벤트가 없습니다</li>}
      </ul>
    </div>
  );
}

export default Timeline;

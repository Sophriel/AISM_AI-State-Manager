// T13 — 타임라인. 최근 이벤트 50개, 최신이 위.
import type { AismEvent } from "../api";

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

// 역할 표시 — e.role이 planner/verifier/coder면 해당 표시, 그 밖의 문자열은 대문자, 없으면 sessionKey 접두사(planner-/verifier-/coder-)로, 둘 다 아니면 ?.
function roleOf(e: AismEvent): string {
  const role = e.role;
  if (role === "planner") return "PLANNER";
  if (role === "verifier") return "VERIFIER";
  if (role === "coder") return "CODER";
  if (typeof role === "string") return role.toUpperCase();
  const key = str(e.sessionKey);
  if (key.startsWith("planner-")) return "PLANNER";
  if (key.startsWith("verifier-")) return "VERIFIER";
  if (key.startsWith("coder-")) return "CODER";
  return "?";
}

// [yy.MM.DD] HH:mm:ss — 24시간, yy = getFullYear() % 100, 모두 padStart(2, "0").
function formatTs(ts: number): string {
  const d = new Date(ts);
  const yy = String(d.getFullYear() % 100).padStart(2, "0");
  const MM = String(d.getMonth() + 1).padStart(2, "0");
  const DD = String(d.getDate()).padStart(2, "0");
  const HH = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `[${yy}.${MM}.${DD}] ${HH}:${mm}:${ss}`;
}

function describeEvent(e: AismEvent): string {
  const t = formatTs(e.ts);
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
    case "launch": {
      const suffix = e.resume ? " (이어서 띄움)" : e.relaunch ? " (다시 띄움)" : "";
      return `${t}  Launch  ${roleOf(e)}${suffix}`;
    }
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

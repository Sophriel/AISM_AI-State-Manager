// T13 — 타임라인. 최근 이벤트 50개, 최신이 위. 긴 문구는 접기 (M2 polish §3 A).
import { useState } from "react";
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

function describeEvent(e: AismEvent): { line: string; sep: string; body: string | null } {
  const t = formatTs(e.ts);
  switch (e.type) {
    case "stop":
      return { line: `${t}  ${roleOf(e)} 응답 종료`, sep: ": ", body: str(e.message) || null };
    case "reply": {
      if (e.action === "block")
        return { line: `${t}  ${roleOf(e)} ← 지시`, sep: ": ", body: str(e.reason) || null };
      return {
        line: `${t}  ${roleOf(e)} ← 허용${e.reason ? ` (${str(e.reason)})` : ""}`,
        sep: "",
        body: null,
      };
    }
    case "hold":
      return { line: `${t}  ${roleOf(e)} 대기`, sep: "", body: null };
    case "launch": {
      const suffix = e.resume ? " (이어서 띄움)" : e.relaunch ? " (다시 띄움)" : "";
      return {
        line: `${t}  Launch  ${roleOf(e)}${suffix}`,
        sep: " — 지시: ",
        body: e.instruction ? str(e.instruction) : null,
      };
    }
    case "bind":
      return { line: `${t}  Bind  ${str(e.folder)}`, sep: "", body: null };
    case "notify":
      return { line: `${t}  [${str(e.level)}]`, sep: "  ", body: str(e.message) || null };
    case "detach":
      return { line: `${t}  Detach  ${str(e.sessionKey)}`, sep: "", body: null };
    case "close-task":
      return { line: `${t}  작업 종료`, sep: "", body: null };
    default:
      return { line: `${t}  ${e.type}`, sep: "", body: null };
  }
}

const SHORT = 120;
const isLong = (b: string) => b.includes("\n") || b.length > SHORT;
const firstLine = (b: string) => b.split("\n")[0].slice(0, SHORT);

function Timeline({ events, onClear, disabled }: { events: AismEvent[]; onClear: () => void; disabled: boolean }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (k: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };
  const sorted = [...events].sort((a, b) => b.ts - a.ts);
  return (
    <div className="timeline">
      <div className="timeline-header">
        <h2>타임라인</h2>
        <button type="button" onClick={onClear} disabled={disabled || events.length === 0}>
          타임라인 비우기
        </button>
      </div>
      <ul>
        {sorted.map((e, i) => {
          const d = describeEvent(e);
          const k = `${e.ts}-${e.type}-${str(e.sessionKey)}`;
          const base = e.type === "notify" ? "notify" : "";
          if (!d.body || !isLong(d.body)) {
            return (
              <li key={`${e.ts}-${i}`} className={base}>
                {d.line}
                {d.body ? d.sep + d.body : ""}
              </li>
            );
          }
          const open = expanded.has(k);
          return (
            <li key={`${e.ts}-${i}`} className={`${base} collapsible`.trim()} onClick={() => toggle(k)}>
              {open ? "▾ " : "▸ "}
              {d.line}
              {d.sep}
              {open ? "" : `${firstLine(d.body)}…`}
              {open && <div className="timeline-body">{d.body}</div>}
            </li>
          );
        })}
        {sorted.length === 0 && <li className="empty">이벤트가 없습니다</li>}
      </ul>
    </div>
  );
}

export default Timeline;

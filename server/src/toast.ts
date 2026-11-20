// G-5 — Windows 토스트 (PowerShell WinRT, ADR 0014).
// detached로 띄우면 토스트가 표시되지 않는다 (E-005).
import { spawn } from "node:child_process";
import path from "node:path";
import { AISM_ROOT } from "./config.js";

// 토스트 대상 — warn 전부 + 전달 못 한 지시 + 커밋 계획 완료 + 체크리스트 완료 (D3, D6, M3).
export function shouldToast(level: "info" | "warn", key: string): boolean {
  return (
    level === "warn" ||
    key.startsWith("undeliverable-") ||
    key.startsWith("commit-plan-") ||
    key.startsWith("checklist-")
  );
}

let warned = false;
function warnOnce(e: unknown): void {
  if (warned) return;
  warned = true;
  console.warn(`토스트 표시 실패 — 브라우저 알림만 사용합니다 (${String(e)})`);
}

export function showToast(title: string, message: string): void {
  const b64 = Buffer.from(JSON.stringify({ title, message }), "utf8").toString("base64");
  const script = path.join(AISM_ROOT, "scripts", "toast.ps1");
  try {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script, "-B64", b64],
      { stdio: "ignore" },
    );
    child.on("error", warnOnce);
    child.unref();
  } catch (e) {
    warnOnce(e);
  }
}

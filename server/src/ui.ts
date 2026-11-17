// UI 창 띄우기와 창 크기 자동 저장 (M2 polish §3 E).
import { spawn as childSpawn } from "node:child_process";
import path from "node:path";
import type { AismConfig } from "./config.js";
import { saveWindowSize } from "./config.js";

export const DEFAULT_WINDOW = { width: 1000, height: 900 };

type Child = { on: (ev: "error", cb: (e: Error) => void) => void; unref: () => void };
export type UiSpawn = (cmd: string, args: string[], opts: { stdio: "ignore" }) => Child;

// Edge 앱 창을 AISM 전용 프로필로 띄운다. AISM_NO_UI=1이면 띄우지 않는다.
export function openUi(
  port: number,
  win: { width: number; height: number },
  aismRoot: string,
  opts: { spawn?: UiSpawn; env?: NodeJS.ProcessEnv } = {},
): void {
  const env = opts.env ?? process.env;
  if (env.AISM_NO_UI === "1") return;
  const profile = path.join(aismRoot, "state", "edge-profile");
  const args = [
    "/c",
    "start",
    "",
    "msedge",
    `--app=http://127.0.0.1:${port}`,
    `--window-size=${win.width},${win.height}`,
    `--user-data-dir=${profile}`,
  ];
  const sp = opts.spawn ?? (childSpawn as unknown as UiSpawn);
  try {
    const c = sp("cmd.exe", args, { stdio: "ignore" });
    c.on("error", (e) => console.warn(`UI 창 띄우기 실패 — ${e.message}`));
    c.unref();
  } catch (e) {
    console.warn(`UI 창 띄우기 실패 — ${String(e)}`);
  }
}

// POST /api/ui/window 처리. sendBeacon(text/plain)은 문자열 본문으로 온다.
export function handleWindowSize(
  config: AismConfig,
  configPath: string,
  body: unknown,
  save: (p: string, w: { width: number; height: number }) => boolean = saveWindowSize,
): { status: number; payload: Record<string, unknown> } {
  let b: unknown = body;
  if (typeof b === "string") {
    try {
      b = JSON.parse(b);
    } catch {
      return { status: 400, payload: { error: "invalid json" } };
    }
  }
  const o = (typeof b === "object" && b !== null ? b : {}) as { width?: unknown; height?: unknown };
  const w = o.width;
  const h = o.height;
  if (!Number.isInteger(w) || !Number.isInteger(h) || (w as number) < 400 || (h as number) < 300) {
    return { status: 400, payload: { error: "invalid size" } };
  }
  const cur = config.window ?? DEFAULT_WINDOW;
  if (cur.width === w && cur.height === h) return { status: 200, payload: { ok: true, saved: false } };
  const win = { width: w as number, height: h as number };
  if (!save(configPath, win)) return { status: 200, payload: { ok: true, saved: false } };
  config.window = win;
  return { status: 200, payload: { ok: true, saved: true } };
}

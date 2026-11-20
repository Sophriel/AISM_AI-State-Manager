// T6 — open-ui CLI. 서버가 켜져 있으면 Edge 앱 창을 하나 띄운다 (서버는 창을 띄우지 않음).
import type { AismConfig } from "./config.js";
import { AISM_ROOT } from "./config.js";
import { openUi, DEFAULT_WINDOW } from "./ui.js";

export interface OpenUiDeps {
  loadConfig: () => AismConfig;
  fetchHealth: (port: number) => Promise<boolean>;
  openUi: typeof openUi;
  waitForExit: (child: NonNullable<ReturnType<typeof openUi>>) => Promise<void>;
  log: (s: string) => void;
}

// 기본 fetchHealth — /api/health 응답 JSON ok === true면 true, 예외(연결 실패·타임아웃)는 false.
export async function defaultFetchHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

// 설정 읽기 → health 확인 → 창 띄우기. 반환값은 프로세스 종료 코드.
export async function runOpenUi(deps: OpenUiDeps): Promise<number> {
  let config: AismConfig;
  try {
    config = deps.loadConfig();
  } catch (e) {
    deps.log(`설정 파일을 읽을 수 없습니다 — ${String(e)}`);
    return 1;
  }
  const healthy = await deps.fetchHealth(config.port);
  if (!healthy) {
    deps.log(`AISM 서버가 켜져 있지 않습니다 — scripts\\start_server.bat으로 먼저 서버를 띄우세요 (127.0.0.1:${config.port})`);
    return 1;
  }
  const child = deps.openUi(config.port, config.window ?? DEFAULT_WINDOW, AISM_ROOT);
  if (child === null) {
    deps.log("UI 창을 띄우지 못했습니다 — Edge(msedge)가 설치되어 있는지 확인하세요");
    return 1;
  }
  await deps.waitForExit(child);
  return 0;
}

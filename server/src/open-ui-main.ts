// open_ui.bat 진입점 — 조건 없이 runOpenUi 실행 (경로 비교 판정 없음, 2026-11-19 open-ui-fix).
import { loadConfig, configFilePath } from "./config.js";
import { openUi, waitForExit } from "./ui.js";
import { runOpenUi, defaultFetchHealth } from "./open-ui.js";

runOpenUi({
  loadConfig: () => loadConfig(configFilePath()),
  fetchHealth: defaultFetchHealth,
  openUi,
  waitForExit,
  log: (s) => console.log(s),
}).then((c) => {
  process.exitCode = c;
});

// T8 완료 조건 — openUi spawn 인자·AISM_NO_UI, handleWindowSize 본문·검증·저장 분기.
import path from "node:path";
import { describe, it, expect } from "vitest";
import { openUi, handleWindowSize, DEFAULT_WINDOW, type UiSpawn } from "./ui.js";
import type { AismConfig } from "./config.js";

function makeConfig(window?: { width: number; height: number }): AismConfig {
  return {
    port: 4400,
    endpoints: {},
    roles: {
      planner: { endpoint: "cloud", prompt: [] },
      verifier: { endpoint: "local", prompt: [] },
      coder: { endpoint: "local", prompt: [] },
    },
    projects: {},
    confirmFromVersion: 5,
    maxConsecutiveBlocks: 3,
    parkLimitSec: 3300,
    hookTimeoutSec: 3600,
    ...(window ? { window } : {}),
  };
}

describe("openUi", () => {
  it("주입 spawn이 cmd.exe + msedge 인자 받음", () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const spawn: UiSpawn = (cmd, args) => {
      calls.push({ cmd, args });
      return { on: () => {}, unref: () => {} };
    };
    openUi(4400, { width: 800, height: 600 }, "C:/aism", { spawn, env: {} });

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("cmd.exe");
    expect(calls[0].args).toEqual([
      "/c",
      "start",
      "",
      "msedge",
      "--app=http://127.0.0.1:4400",
      "--window-size=800,600",
      `--user-data-dir=${path.join("C:/aism", "state", "edge-profile")}`,
    ]);
  });

  it("AISM_NO_UI=1이면 호출 안 됨", () => {
    let called = false;
    const spawn: UiSpawn = () => {
      called = true;
      return { on: () => {}, unref: () => {} };
    };
    openUi(4400, DEFAULT_WINDOW, "C:/aism", { spawn, env: { AISM_NO_UI: "1" } });
    expect(called).toBe(false);
  });
});

describe("handleWindowSize", () => {
  it("문자열 본문 → 저장 (200 saved true, config.window 갱신)", () => {
    const config = makeConfig();
    let saved: { width: number; height: number } | null = null;
    const r = handleWindowSize(config, "cfg.json", '{"width":800,"height":600}', (_p, w) => {
      saved = w;
      return true;
    });
    expect(r).toEqual({ status: 200, payload: { ok: true, saved: true } });
    expect(saved).toEqual({ width: 800, height: 600 });
    expect(config.window).toEqual({ width: 800, height: 600 });
  });

  it("객체 본문 → 저장", () => {
    const config = makeConfig();
    const r = handleWindowSize(config, "cfg.json", { width: 700, height: 500 }, () => true);
    expect(r).toEqual({ status: 200, payload: { ok: true, saved: true } });
    expect(config.window).toEqual({ width: 700, height: 500 });
  });

  it("잘못된 JSON → 400", () => {
    const config = makeConfig();
    const r = handleWindowSize(config, "cfg.json", "{broken", () => true);
    expect(r).toEqual({ status: 400, payload: { error: "invalid json" } });
  });

  it("399×300·400×299 → 400", () => {
    const config = makeConfig();
    expect(handleWindowSize(config, "cfg.json", { width: 399, height: 300 }, () => true)).toEqual({
      status: 400,
      payload: { error: "invalid size" },
    });
    expect(handleWindowSize(config, "cfg.json", { width: 400, height: 299 }, () => true)).toEqual({
      status: 400,
      payload: { error: "invalid size" },
    });
  });

  it("소수 → 400", () => {
    const config = makeConfig();
    const r = handleWindowSize(config, "cfg.json", { width: 800.5, height: 600 }, () => true);
    expect(r).toEqual({ status: 400, payload: { error: "invalid size" } });
  });

  it("현재와 같은 값 → 200 saved false (save 미호출)", () => {
    const config = makeConfig({ width: 800, height: 600 });
    let saveCalled = false;
    const r = handleWindowSize(config, "cfg.json", { width: 800, height: 600 }, () => {
      saveCalled = true;
      return true;
    });
    expect(r).toEqual({ status: 200, payload: { ok: true, saved: false } });
    expect(saveCalled).toBe(false);
  });

  it("save가 false → 200 saved false·config.window 그대로", () => {
    const config = makeConfig();
    const r = handleWindowSize(config, "cfg.json", { width: 800, height: 600 }, () => false);
    expect(r).toEqual({ status: 200, payload: { ok: true, saved: false } });
    expect(config.window).toBeUndefined();
  });
});

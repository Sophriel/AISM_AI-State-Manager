// T6 완료 조건 — health true → openUi (port, DEFAULT_WINDOW, …) 호출·0 (설정 window 없을 때),
// 설정 window 있을 때 그 값, health false → 안내 문구·1·openUi 미호출, loadConfig 예외 → 1.
import { describe, it, expect, vi } from "vitest";
import { runOpenUi } from "./open-ui.js";
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

describe("runOpenUi", () => {
  it("health true → openUi가 (port, DEFAULT_WINDOW, …)로 호출·0 (설정 window 없을 때)", async () => {
    const fakeChild = { on: () => {}, once: () => {}, unref: () => {} };
    const openUi = vi.fn(() => fakeChild);
    const waitForExit = vi.fn().mockResolvedValue(undefined);
    const r = await runOpenUi({
      loadConfig: () => makeConfig(),
      fetchHealth: async () => true,
      openUi,
      waitForExit,
      log: () => {},
    });
    expect(r).toBe(0);
    expect(openUi).toHaveBeenCalledTimes(1);
    expect(openUi.mock.calls[0][0]).toBe(4400);
    expect(openUi.mock.calls[0][1]).toEqual({ width: 1000, height: 900 }); // DEFAULT_WINDOW
    expect(waitForExit).toHaveBeenCalledTimes(1);
    expect(waitForExit).toHaveBeenCalledWith(fakeChild);
  });

  it("설정 window 있을 때 그 값", async () => {
    const fakeChild = { on: () => {}, once: () => {}, unref: () => {} };
    const openUi = vi.fn(() => fakeChild);
    const waitForExit = vi.fn().mockResolvedValue(undefined);
    const r = await runOpenUi({
      loadConfig: () => makeConfig({ width: 800, height: 600 }),
      fetchHealth: async () => true,
      openUi,
      waitForExit,
      log: () => {},
    });
    expect(r).toBe(0);
    expect(openUi.mock.calls[0][1]).toEqual({ width: 800, height: 600 });
    expect(waitForExit).toHaveBeenCalledTimes(1);
    expect(waitForExit).toHaveBeenCalledWith(fakeChild);
  });

  it("health false → 안내 문구·1·openUi 미호출", async () => {
    const openUi = vi.fn();
    const waitForExit = vi.fn().mockResolvedValue(undefined);
    const logs: string[] = [];
    const r = await runOpenUi({
      loadConfig: () => makeConfig(),
      fetchHealth: async () => false,
      openUi,
      waitForExit,
      log: (s) => logs.push(s),
    });
    expect(r).toBe(1);
    expect(openUi).not.toHaveBeenCalled();
    expect(waitForExit).not.toHaveBeenCalled();
    expect(logs.some((s) => s.includes("start_server.bat"))).toBe(true);
  });

  it("loadConfig 예외 → 1·openUi 미호출", async () => {
    const openUi = vi.fn();
    const waitForExit = vi.fn().mockResolvedValue(undefined);
    const r = await runOpenUi({
      loadConfig: () => {
        throw new Error("no config");
      },
      fetchHealth: async () => true,
      openUi,
      waitForExit,
      log: () => {},
    });
    expect(r).toBe(1);
    expect(openUi).not.toHaveBeenCalled();
    expect(waitForExit).not.toHaveBeenCalled();
  });

  it("openUi가 null 반환 → 1·안내·waitForExit 미호출", async () => {
    const openUi = vi.fn(() => null);
    const waitForExit = vi.fn().mockResolvedValue(undefined);
    const logs: string[] = [];
    const r = await runOpenUi({
      loadConfig: () => makeConfig(),
      fetchHealth: async () => true,
      openUi,
      waitForExit,
      log: (s) => logs.push(s),
    });
    expect(r).toBe(1);
    expect(logs.some((s) => s.includes("UI 창을 띄우지 못했습니다"))).toBe(true);
    expect(waitForExit).not.toHaveBeenCalled();
  });

  it("openUi가 child 반환 → waitForExit이 그 child로 1회 호출·0", async () => {
    const fakeChild = { on: () => {}, once: () => {}, unref: () => {} };
    const openUi = vi.fn(() => fakeChild);
    const waitForExit = vi.fn().mockResolvedValue(undefined);
    const r = await runOpenUi({
      loadConfig: () => makeConfig(),
      fetchHealth: async () => true,
      openUi,
      waitForExit,
      log: () => {},
    });
    expect(r).toBe(0);
    expect(waitForExit).toHaveBeenCalledTimes(1);
    expect(waitForExit).toHaveBeenCalledWith(fakeChild);
  });
});

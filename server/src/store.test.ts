// T7 완료 조건 — 저장 후 새 인스턴스로 로드하면 동일, 이벤트 3개 append 후 줄 수 3.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Store, newActiveTask } from "./store.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aism-store-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Store", () => {
  it("저장 후 새 인스턴스로 로드하면 동일", () => {
    const a = new Store(dir);
    a.state.activeTask = { ...newActiveTask("EWE", 1000), folder: "261111-alpha" };
    a.state.sessions["planner-1"] = {
      role: "planner",
      project: "EWE",
      folder: "261111-alpha",
      launchedAt: 1000,
      sessionIds: ["s1"],
      activeSessionId: "s1",
      switchedOnce: false,
    };
    a.state.activeTask.record = { notified: ["decision-v3"], consecutiveBlocks: { "verifier-1": 2 }, instructed: [] };
    a.state.activeTask.undelivered = [{ role: "verifier", text: "지시 문장" }];
    a.save();

    const b = new Store(dir);
    expect(b.load()).toEqual(a.state);
  });

  it("state.json이 없으면 빈 상태", () => {
    const s = new Store(dir);
    expect(s.state).toEqual({ activeTask: null, sessions: {} });
  });

  it("형식이 다른 state.json(최상위 record 키) → 빈 상태", () => {
    const s = new Store(dir);
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({ activeTask: null, sessions: {}, record: { notified: ["pass-v1"] } }),
      "utf8",
    );
    expect(s.load()).toEqual({ activeTask: null, sessions: {} });
  });

  it("형식이 다른 state.json(activeTask.assigned에 plan 키) → 빈 상태", () => {
    const s = new Store(dir);
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({
        activeTask: {
          project: "EWE",
          folder: null,
          startedAt: 1000,
          assigned: { plan: "planner-1", verifier: null },
          record: { notified: [], consecutiveBlocks: {}, instructed: [] },
          undelivered: [],
        },
        sessions: {},
      }),
      "utf8",
    );
    expect(s.load()).toEqual({ activeTask: null, sessions: {} });
  });

  it("형식이 다른 state.json(세션 role: plan) → 빈 상태", () => {
    const s = new Store(dir);
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({
        activeTask: null,
        sessions: {
          "planner-1": {
            role: "plan",
            project: "EWE",
            folder: null,
            launchedAt: 1000,
            sessionIds: [],
            activeSessionId: null,
            switchedOnce: false,
          },
        },
      }),
      "utf8",
    );
    expect(s.load()).toEqual({ activeTask: null, sessions: {} });
  });

  it("형식이 다른 state.json(activeTask 필드 누락) → 빈 상태", () => {
    const s = new Store(dir);
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ sessions: {} }), "utf8");
    expect(s.load()).toEqual({ activeTask: null, sessions: {} });
  });

  it("형식 불일치 경고는 1회만 (생성자 + load 연속)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ sessions: {} }), "utf8");
    const s = new Store(dir); // 생성자 readState → 1회 경고
    s.load(); // 같은 인스턴스 — formatWarned이므로 경고 없음
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("이벤트 3개 append 후 줄 수 3", () => {
    const s = new Store(dir);
    s.appendEvent({ type: "stop", sessionKey: "planner-1" });
    s.appendEvent({ type: "reply", sessionKey: "planner-1", action: "allow" });
    s.appendEvent({ type: "launch", role: "verifier" });

    const raw = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(3);

    const events = s.readEvents();
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("stop");
    expect(events[0].sessionKey).toBe("planner-1");
    expect(typeof events[0].ts).toBe("number");
    expect(events[2].type).toBe("launch");
  });

  it("appendEvent가 ts를 자동 채운다", () => {
    const s = new Store(dir);
    const before = Date.now();
    s.appendEvent({ type: "bind", folder: "261111-alpha" });
    const [e] = s.readEvents();
    expect(e.ts).toBeGreaterThanOrEqual(before);
  });

  it("state/ 폴더가 없으면 생성한다", () => {
    const nested = path.join(dir, "nested", "state");
    const s = new Store(nested);
    s.save();
    expect(fs.existsSync(path.join(nested, "state.json"))).toBe(true);
  });
});

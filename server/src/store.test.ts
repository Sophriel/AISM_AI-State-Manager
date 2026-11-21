// T7 완료 조건 — 저장 후 새 인스턴스로 로드하면 동일, 이벤트 3개 append 후 줄 수 3.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Store, newTask, makeTaskId } from "./store.js";

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
    a.state.tasks["t-1"] = { ...newTask("t-1", "EWE", 1000), folder: "261111-alpha" };
    a.state.sessions["planner-1"] = {
      role: "planner",
      project: "EWE",
      folder: "261111-alpha",
      launchedAt: 1000,
      sessionIds: ["s1"],
      activeSessionId: "s1",
      switchedOnce: false,
      task: "t-1",
    };
    a.state.tasks["t-1"].record = { notified: ["decision-v3"], consecutiveBlocks: { "verifier-1": 2 }, instructed: [] };
    a.state.tasks["t-1"].undelivered = [{ role: "verifier", text: "지시 문장" }];
    a.state.codingLocks["EWE"] = { task: "t-1", since: 1000 };
    a.state.codingQueue = [{ task: "t-2", sessionKey: "coder-2", text: "구현 지시", since: 2000 }];
    a.save();

    const b = new Store(dir);
    expect(b.load()).toEqual(a.state);
  });

  it("state.json이 없으면 빈 상태", () => {
    const s = new Store(dir);
    expect(s.state).toEqual({ tasks: {}, sessions: {}, codingLocks: {}, codingQueue: [] });
  });

  it("형식이 다른 state.json(최상위 record 키) → 빈 상태", () => {
    const s = new Store(dir);
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({ tasks: {}, sessions: {}, record: { notified: ["pass-v1"] } }),
      "utf8",
    );
    expect(s.load()).toEqual({ tasks: {}, sessions: {}, codingLocks: {}, codingQueue: [] });
  });

  it("형식이 다른 state.json(옛 activeTask 형식) → 빈 상태", () => {
    const s = new Store(dir);
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({
        activeTask: {
          project: "EWE",
          folder: null,
          startedAt: 1000,
          assigned: { planner: "planner-1", verifier: null, coder: null },
          record: { notified: [], consecutiveBlocks: {}, instructed: [] },
          undelivered: [],
        },
        sessions: {},
      }),
      "utf8",
    );
    expect(s.load()).toEqual({ tasks: {}, sessions: {}, codingLocks: {}, codingQueue: [] });
  });

  it("형식이 다른 state.json(task.assigned에 plan 키) → 빈 상태", () => {
    const s = new Store(dir);
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({
        tasks: {
          "t-1": {
            id: "t-1",
            project: "EWE",
            folder: null,
            startedAt: 1000,
            assigned: { plan: "planner-1", verifier: null },
            record: { notified: [], consecutiveBlocks: {}, instructed: [] },
            undelivered: [],
          },
        },
        sessions: {},
      }),
      "utf8",
    );
    expect(s.load()).toEqual({ tasks: {}, sessions: {}, codingLocks: {}, codingQueue: [] });
  });

  it("형식이 다른 state.json(assigned에 coder 없음) → 빈 상태", () => {
    const s = new Store(dir);
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({
        tasks: {
          "t-1": {
            id: "t-1",
            project: "EWE",
            folder: null,
            startedAt: 1000,
            assigned: { planner: "planner-1", verifier: null },
            record: { notified: [], consecutiveBlocks: {}, instructed: [] },
            undelivered: [],
          },
        },
        sessions: {},
      }),
      "utf8",
    );
    expect(s.load()).toEqual({ tasks: {}, sessions: {}, codingLocks: {}, codingQueue: [] });
  });

  it("형식이 다른 state.json(세션 role: plan) → 빈 상태", () => {
    const s = new Store(dir);
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({
        tasks: {},
        sessions: {
          "planner-1": {
            role: "plan",
            project: "EWE",
            folder: null,
            launchedAt: 1000,
            sessionIds: [],
            activeSessionId: null,
            switchedOnce: false,
            task: null,
          },
        },
      }),
      "utf8",
    );
    expect(s.load()).toEqual({ tasks: {}, sessions: {}, codingLocks: {}, codingQueue: [] });
  });

  it("형식이 다른 state.json(tasks 키 누락) → 빈 상태", () => {
    const s = new Store(dir);
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ sessions: {} }), "utf8");
    expect(s.load()).toEqual({ tasks: {}, sessions: {}, codingLocks: {}, codingQueue: [] });
  });

  it("형식이 다른 state.json(tasks[k].id !== k) → 빈 상태", () => {
    const s = new Store(dir);
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({
        tasks: {
          "t-1": {
            id: "t-2",
            project: "EWE",
            folder: null,
            startedAt: 1000,
            assigned: { planner: null, verifier: null, coder: null },
            record: { notified: [], consecutiveBlocks: {}, instructed: [] },
            undelivered: [],
          },
        },
        sessions: {},
      }),
      "utf8",
    );
    expect(s.load()).toEqual({ tasks: {}, sessions: {}, codingLocks: {}, codingQueue: [] });
  });

  it("형식이 다른 state.json(1단계 형식 — 최상위 키 2개·작업 키 7개) → 빈 상태·경고", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({
        tasks: {
          "t-1": {
            id: "t-1",
            project: "EWE",
            folder: null,
            startedAt: 1000,
            assigned: { planner: null, verifier: null, coder: null },
            record: { notified: [], consecutiveBlocks: {}, instructed: [] },
            undelivered: [],
          },
        },
        sessions: {},
      }),
      "utf8",
    );
    const s = new Store(dir);
    expect(s.state).toEqual({ tasks: {}, sessions: {}, codingLocks: {}, codingQueue: [] });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
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

describe("Store 작업별 기록 (T2)", () => {
  it("두 작업 ID에 append 후 각자 read 결과가 섞이지 않음", () => {
    const s = new Store(dir);
    s.appendTaskEvent("t-1", { type: "stop", sessionKey: "planner-1" });
    s.appendTaskEvent("t-2", { type: "launch", role: "verifier" });
    s.appendTaskEvent("t-1", { type: "reply", sessionKey: "planner-1", action: "allow" });

    const a = s.readTaskEvents("t-1");
    expect(a).toHaveLength(2);
    expect(a[0].type).toBe("stop");
    expect(a[0].sessionKey).toBe("planner-1");
    expect(typeof a[0].ts).toBe("number");
    expect(a[1].type).toBe("reply");

    const b = s.readTaskEvents("t-2");
    expect(b).toHaveLength(1);
    expect(b[0].type).toBe("launch");
    expect(b[0].role).toBe("verifier");

    // 전역 파일에는 기록되지 않음.
    expect(s.readEvents()).toHaveLength(0);
  });

  it("없는 ID read → []", () => {
    const s = new Store(dir);
    expect(s.readTaskEvents("t-none")).toEqual([]);
  });

  it("appendTaskEvent가 ts를 자동 채운다", () => {
    const s = new Store(dir);
    const before = Date.now();
    s.appendTaskEvent("t-1", { type: "bind", folder: "261118-x" });
    const [e] = s.readTaskEvents("t-1");
    expect(e.ts).toBeGreaterThanOrEqual(before);
  });

  it("tasks/ 폴더가 없으면 생성한다", () => {
    const nested = path.join(dir, "nested", "state");
    const s = new Store(nested);
    s.appendTaskEvent("t-1", { type: "stop" });
    expect(fs.existsSync(path.join(nested, "tasks", "t-1", "events.jsonl"))).toBe(true);
  });
});

describe("appendSessionEvent (T4)", () => {
  it("배정된 세션 → 작업 파일, 배정 안 된(task null) 세션 → 전역", () => {
    const s = new Store(dir);
    s.state.tasks["t-1"] = { ...newTask("t-1", "EWE", 1000) };
    s.state.sessions["planner-1"] = { role: "planner", project: "EWE", folder: null, launchedAt: 0, sessionIds: [], activeSessionId: null, switchedOnce: false, task: "t-1" };
    s.state.sessions["orphan-1"] = { role: "planner", project: "EWE", folder: null, launchedAt: 0, sessionIds: [], activeSessionId: null, switchedOnce: false, task: null };

    s.appendSessionEvent("planner-1", { type: "stop", sessionKey: "planner-1" });
    s.appendSessionEvent("orphan-1", { type: "stop", sessionKey: "orphan-1" });

    const taskEvents = s.readTaskEvents("t-1");
    expect(taskEvents).toHaveLength(1);
    expect(taskEvents[0].sessionKey).toBe("planner-1");
    const global = s.readEvents();
    expect(global).toHaveLength(1);
    expect(global[0].sessionKey).toBe("orphan-1");
  });

  it("세션 task가 tasks에 없으면(종료된 작업) → 전역", () => {
    const s = new Store(dir);
    // 세션은 task "t-gone"을 가리키지만 tasks에는 없음.
    s.state.sessions["planner-1"] = { role: "planner", project: "EWE", folder: null, launchedAt: 0, sessionIds: [], activeSessionId: null, switchedOnce: false, task: "t-gone" };
    s.appendSessionEvent("planner-1", { type: "stop" });
    expect(s.readEvents()).toHaveLength(1);
    expect(s.readTaskEvents("t-gone")).toEqual([]);
  });
});

describe("makeTaskId (T2)", () => {
  it("t-<YYYYMMDD>-<HHmmss>-<hex> 형식 (로컬 시간)", () => {
    expect(makeTaskId(new Date(2026, 10, 18, 9, 5, 7), "ab12")).toBe("t-20261118-090507-ab12");
  });
});

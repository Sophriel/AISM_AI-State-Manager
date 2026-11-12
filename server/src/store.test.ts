// T7 완료 조건 — 저장 후 새 인스턴스로 로드하면 동일, 이벤트 3개 append 후 줄 수 3.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "./store.js";

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
    a.state.activeTask = { project: "EWE", folder: "261111-alpha", startedAt: 1000 };
    a.state.sessions["plan-1"] = {
      role: "plan",
      project: "EWE",
      folder: "261111-alpha",
      launchedAt: 1000,
      sessionIds: ["s1"],
      activeSessionId: "s1",
      switchedOnce: false,
    };
    a.state.record = { notified: ["decision-v3"], consecutiveBlocks: { "verify-1": 2 } };
    a.state.undelivered = [{ role: "verify", text: "지시 문장" }];
    a.save();

    const b = new Store(dir);
    expect(b.load()).toEqual(a.state);
  });

  it("state.json이 없으면 빈 상태", () => {
    const s = new Store(dir);
    expect(s.state).toEqual({
      activeTask: null,
      sessions: {},
      record: { notified: [], consecutiveBlocks: {} },
      undelivered: [],
    });
  });

  it("이벤트 3개 append 후 줄 수 3", () => {
    const s = new Store(dir);
    s.appendEvent({ type: "stop", sessionKey: "plan-1" });
    s.appendEvent({ type: "reply", sessionKey: "plan-1", action: "allow" });
    s.appendEvent({ type: "launch", role: "verify" });

    const raw = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(3);

    const events = s.readEvents();
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("stop");
    expect(events[0].sessionKey).toBe("plan-1");
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

// T8 완료 조건 — 파킹→resolve, 파킹→close→detached, 파킹 타이머 만료(가짜 타이머),
// session_id 전환 1회 후 비활성 Stop 즉시 allow.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "./store.js";
import { Sessions } from "./sessions.js";
import type { Reply } from "./machine.js";

type Timer = ReturnType<typeof setTimeout>;

let dir: string;
let timerFn: (() => void) | null;
const setTimer = (fn: () => void, _ms: number): Timer => {
  timerFn = fn;
  return {} as Timer;
};
const clearTimer = (_t: Timer): void => {
  timerFn = null;
};

function makeStore(): Store {
  const store = new Store(dir);
  store.state.sessions["plan-1"] = {
    role: "plan",
    project: "EWE",
    folder: "261111-alpha",
    launchedAt: 0,
    sessionIds: ["s1"],
    activeSessionId: "s1",
    switchedOnce: false,
  };
  store.save();
  return store;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aism-sessions-"));
  timerFn = null;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Sessions", () => {
  it("파킹 → resolve(block) → working", () => {
    const store = makeStore();
    const sessions = new Sessions(store, 3300, { setTimer, clearTimer });
    sessions.register("plan-1", "launching");

    let replied: Reply | null = null;
    const res = sessions.onStop("plan-1", "s1", (r) => (replied = r), () => {});
    expect(res.handled).toBe(false);
    expect(sessions.stateOf("plan-1")).toBe("parked");

    sessions.resolve("plan-1", { action: "block", reason: "지시" });
    expect(replied).toEqual({ action: "block", reason: "지시" });
    expect(sessions.stateOf("plan-1")).toBe("working");
  });

  it("파킹 → close → detached (pending 제거)", () => {
    const store = makeStore();
    const sessions = new Sessions(store, 3300, { setTimer, clearTimer });

    let closeCb: (() => void) | null = null;
    sessions.onStop("plan-1", "s1", () => {}, (cb) => (closeCb = cb));
    expect(sessions.stateOf("plan-1")).toBe("parked");

    closeCb!();
    expect(sessions.stateOf("plan-1")).toBe("detached");
  });

  it("파킹 타이머 만료 → allow + idle", () => {
    const store = makeStore();
    const sessions = new Sessions(store, 3300, { setTimer, clearTimer });

    let replied: Reply | null = null;
    sessions.onStop("plan-1", "s1", (r) => (replied = r), () => {});
    expect(sessions.stateOf("plan-1")).toBe("parked");

    timerFn!(); // parkLimitSec 만료 시뮬레이션
    expect(replied).toEqual({ action: "allow" });
    expect(sessions.stateOf("plan-1")).toBe("idle");
  });

  it("session_id 전환 1회 후 비활성 Stop 즉시 allow", () => {
    const store = makeStore();
    const notifies: string[] = [];
    const sessions = new Sessions(store, 3300, {
      setTimer,
      clearTimer,
      onNotify: (key) => notifies.push(key),
    });

    // s1(활성) Stop → 파킹.
    let r1: Reply | null = null;
    sessions.onStop("plan-1", "s1", (r) => (r1 = r), () => {});
    expect(sessions.stateOf("plan-1")).toBe("parked");

    // s2(다른 id, switchedOnce=false) Stop → 전환: s1 pending allow 해제, s2 활성, switchedOnce.
    let r2: Reply | null = null;
    const res2 = sessions.onStop("plan-1", "s2", (r) => (r2 = r), () => {});
    expect(res2.handled).toBe(false);
    expect(r1).toEqual({ action: "allow" }); // 이전 활성(s1) pending allow 해제
    expect(store.state.sessions["plan-1"].activeSessionId).toBe("s2");
    expect(store.state.sessions["plan-1"].switchedOnce).toBe(true);
    expect(notifies).toContain("switch-plan-1");
    expect(sessions.stateOf("plan-1")).toBe("parked"); // s2가 이제 파킹

    // s1(이제 비활성, switchedOnce=true) Stop → 평가 없이 즉시 allow.
    let r3: Reply | null = null;
    const res3 = sessions.onStop("plan-1", "s1", (r) => (r3 = r), () => {});
    expect(res3.handled).toBe(true);
    expect(r3).toEqual({ action: "allow" });
  });

  it("peersFor — 같은 project·folder의 역할별 세션 반환", () => {
    const store = makeStore();
    store.state.sessions["verify-1"] = {
      role: "verify",
      project: "EWE",
      folder: "261111-alpha",
      launchedAt: 0,
      sessionIds: ["v1"],
      activeSessionId: "v1",
      switchedOnce: false,
    };
    const sessions = new Sessions(store, 3300, { setTimer, clearTimer });
    sessions.register("plan-1", "working");
    sessions.register("verify-1", "parked");

    const peers = sessions.peersFor("EWE", "261111-alpha");
    expect(peers.plan).toEqual({ sessionKey: "plan-1", state: "working" });
    expect(peers.verify).toEqual({ sessionKey: "verify-1", state: "parked" });
  });
});

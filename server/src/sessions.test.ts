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
  store.state.sessions["planner-1"] = {
    role: "planner",
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
    sessions.register("planner-1", "working");

    let replied: Reply | null = null;
    const res = sessions.onStop("planner-1", "s1", (r) => (replied = r), () => {});
    expect(res.handled).toBe(false);
    expect(sessions.stateOf("planner-1")).toBe("parked");

    sessions.resolve("planner-1", { action: "block", reason: "지시" });
    expect(replied).toEqual({ action: "block", reason: "지시" });
    expect(sessions.stateOf("planner-1")).toBe("working");
  });

  it("파킹 → close → detached (pending 제거)", () => {
    const store = makeStore();
    const sessions = new Sessions(store, 3300, { setTimer, clearTimer });

    let closeCb: (() => void) | null = null;
    sessions.onStop("planner-1", "s1", () => {}, (cb) => (closeCb = cb));
    expect(sessions.stateOf("planner-1")).toBe("parked");

    closeCb!();
    expect(sessions.stateOf("planner-1")).toBe("detached");
  });

  it("파킹 타이머 만료 → allow + idle", () => {
    const store = makeStore();
    const sessions = new Sessions(store, 3300, { setTimer, clearTimer });

    let replied: Reply | null = null;
    sessions.onStop("planner-1", "s1", (r) => (replied = r), () => {});
    expect(sessions.stateOf("planner-1")).toBe("parked");

    timerFn!(); // parkLimitSec 만료 시뮬레이션
    expect(replied).toEqual({ action: "allow" });
    expect(sessions.stateOf("planner-1")).toBe("idle");
  });

  it("session_id 전환 1회 후 비활성 Stop 즉시 allow", () => {
    const store = makeStore();
    const notifies: string[] = [];
    const sessions = new Sessions(store, 3300, {
      setTimer,
      clearTimer,
      onNotify: (_sessionKey, key) => notifies.push(key),
    });

    // s1(활성) Stop → 파킹.
    let r1: Reply | null = null;
    sessions.onStop("planner-1", "s1", (r) => (r1 = r), () => {});
    expect(sessions.stateOf("planner-1")).toBe("parked");

    // s2(다른 id, switchedOnce=false) Stop → 전환: s1 pending allow 해제, s2 활성, switchedOnce.
    let r2: Reply | null = null;
    const res2 = sessions.onStop("planner-1", "s2", (r) => (r2 = r), () => {});
    expect(res2.handled).toBe(false);
    expect(r1).toEqual({ action: "allow" }); // 이전 활성(s1) pending allow 해제
    expect(store.state.sessions["planner-1"].activeSessionId).toBe("s2");
    expect(store.state.sessions["planner-1"].switchedOnce).toBe(true);
    expect(notifies).toContain("switch-planner-1");
    expect(sessions.stateOf("planner-1")).toBe("parked"); // s2가 이제 파킹

    // s1(이제 비활성, switchedOnce=true) Stop → 평가 없이 즉시 allow.
    let r3: Reply | null = null;
    const res3 = sessions.onStop("planner-1", "s1", (r) => (r3 = r), () => {});
    expect(res3.handled).toBe(true);
    expect(r3).toEqual({ action: "allow" });
  });

  it("빈 session_id로 두 번 Stop — sessionIds·activeSessionId 불변, 둘 다 정상 파킹", () => {
    const store = makeStore();
    const sessions = new Sessions(store, 3300, { setTimer, clearTimer });
    sessions.register("planner-1", "working");

    let r1: Reply | null = null;
    const res1 = sessions.onStop("planner-1", "", (r) => (r1 = r), () => {});
    expect(res1.handled).toBe(false);
    expect(sessions.stateOf("planner-1")).toBe("parked");

    sessions.resolve("planner-1", { action: "allow" });
    let r2: Reply | null = null;
    const res2 = sessions.onStop("planner-1", "", (r) => (r2 = r), () => {});
    expect(res2.handled).toBe(false);
    expect(sessions.stateOf("planner-1")).toBe("parked");

    // 빈 id는 기록되지 않고 전환도 감지되지 않는다.
    expect(store.state.sessions["planner-1"].sessionIds).toEqual(["s1"]);
    expect(store.state.sessions["planner-1"].activeSessionId).toBe("s1");
    expect(store.state.sessions["planner-1"].switchedOnce).toBe(false);
  });

  it("resolve — 방출 시 reply 이벤트 기록 (block은 reason, allow는 note)", () => {
    const store = makeStore();
    const sessions = new Sessions(store, 3300, { setTimer, clearTimer });
    sessions.register("planner-1", "working");

    sessions.onStop("planner-1", "s1", () => {}, () => {});
    sessions.resolve("planner-1", { action: "block", reason: "지시 문장" });
    let [e1] = store.readEvents();
    expect(e1).toMatchObject({ type: "reply", sessionKey: "planner-1", action: "block", reason: "지시 문장" });

    sessions.onStop("planner-1", "s1", () => {}, () => {});
    sessions.resolve("planner-1", { action: "allow" }, "task-closed");
    const events = store.readEvents();
    expect(events[events.length - 1]).toMatchObject({ type: "reply", sessionKey: "planner-1", action: "allow", reason: "task-closed" });

    // note 없으면 reason 키 생략.
    sessions.onStop("planner-1", "s1", () => {}, () => {});
    sessions.resolve("planner-1", { action: "allow" });
    const last = store.readEvents().at(-1)!;
    expect(last).toMatchObject({ type: "reply", sessionKey: "planner-1", action: "allow" });
    expect("reason" in last).toBe(false);
  });

  it("resolve — block reason 2500자 → reply 이벤트 reason 2000자 (M2 polish §3 A)", () => {
    const store = makeStore();
    const sessions = new Sessions(store, 3300, { setTimer, clearTimer });
    sessions.register("planner-1", "working");

    sessions.onStop("planner-1", "s1", () => {}, () => {});
    sessions.resolve("planner-1", { action: "block", reason: "x".repeat(2500) });
    const reply = store.readEvents().find((e) => e.type === "reply" && e.sessionKey === "planner-1");
    expect(reply).toBeDefined();
    expect(String(reply!.reason).length).toBe(2000);
  });
});

describe("A-1 — 현재 pending의 연결만 끊김 판정", () => {
  const detaches = (store: Store) => store.readEvents().filter((e) => e.type === "detach");

  it("전환(s1 → s2): 이전 요청 close는 무시, 현재 요청 close → detached + onChange 1회", () => {
    const store = makeStore();
    let changes = 0;
    const sessions = new Sessions(store, 3300, { setTimer, clearTimer, onChange: () => changes++ });

    const closes: (() => void)[] = [];
    const onClose = (cb: () => void) => closes.push(cb);

    sessions.onStop("planner-1", "s1", () => {}, onClose);
    sessions.onStop("planner-1", "s2", () => {}, onClose);
    closes[0](); // 이미 교체된(s1) 요청의 close — 무시.
    expect(sessions.stateOf("planner-1")).toBe("parked");
    expect(detaches(store)).toHaveLength(0);
    expect(changes).toBe(0);

    closes[1](); // 현재 pending(s2) 연결의 close.
    expect(sessions.stateOf("planner-1")).toBe("detached");
    expect(detaches(store)).toHaveLength(1);
    expect(changes).toBe(1);
  });

  it("같은 session_id 두 번: 첫 요청 close는 무시, 두 번째 close → detached", () => {
    const store = makeStore();
    let changes = 0;
    const sessions = new Sessions(store, 3300, { setTimer, clearTimer, onChange: () => changes++ });

    const closes: (() => void)[] = [];
    const onClose = (cb: () => void) => closes.push(cb);

    sessions.onStop("planner-1", "s1", () => {}, onClose);
    sessions.onStop("planner-1", "s1", () => {}, onClose);
    closes[0]();
    expect(sessions.stateOf("planner-1")).toBe("parked");
    expect(detaches(store)).toHaveLength(0);

    closes[1]();
    expect(sessions.stateOf("planner-1")).toBe("detached");
  });

  it("resolve 뒤 늦은 close: 무시 (상태 working 유지, onChange 없음)", () => {
    const store = makeStore();
    let changes = 0;
    const sessions = new Sessions(store, 3300, { setTimer, clearTimer, onChange: () => changes++ });

    const closes: (() => void)[] = [];
    const onClose = (cb: () => void) => closes.push(cb);

    sessions.onStop("planner-1", "s1", () => {}, onClose);
    sessions.resolve("planner-1", { action: "block", reason: "x" });
    closes[0]();
    expect(sessions.stateOf("planner-1")).toBe("working");
    expect(detaches(store)).toHaveLength(0);
    expect(changes).toBe(0);
  });

  it("park-timeout: idle + onChange 1회, 이후 close는 무시", () => {
    const store = makeStore();
    let changes = 0;
    const sessions = new Sessions(store, 3300, { setTimer, clearTimer, onChange: () => changes++ });

    const closes: (() => void)[] = [];
    const onClose = (cb: () => void) => closes.push(cb);

    sessions.onStop("planner-1", "s1", () => {}, onClose);
    timerFn!();
    expect(sessions.stateOf("planner-1")).toBe("idle");
    expect(changes).toBe(1);

    closes[0]();
    expect(sessions.stateOf("planner-1")).toBe("idle");
    expect(detaches(store)).toHaveLength(0);
    expect(changes).toBe(1);
  });
});

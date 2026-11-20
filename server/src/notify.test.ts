// T1 완료 조건 — 클라이언트 3개(task A, task B, null)로 send/sendLobby/sendAll/attachedCount, 쓰기 예외 클라이언트 제거.
import { describe, it, expect } from "vitest";
import { NotifyHub, type SseClient } from "./notify.js";

function makeClient(onWrite?: (raw: string) => void): SseClient {
  return {
    write: (raw) => onWrite?.(raw),
    close: () => {},
  };
}

describe("NotifyHub", () => {
  it("send — 그 작업 클라이언트만 받음", () => {
    const hub = new NotifyHub();
    const a: string[] = [];
    const b: string[] = [];
    const lobby: string[] = [];
    const ca = makeClient((s) => a.push(s));
    const cb = makeClient((s) => b.push(s));
    const cl = makeClient((s) => lobby.push(s));
    hub.add(ca, "A");
    hub.add(cb, "B");
    hub.add(cl, null);

    hub.send("A", "state", { task: "A" });
    expect(a).toHaveLength(1);
    expect(a[0]).toBe("event: state\ndata: {\"task\":\"A\"}\n\n");
    expect(b).toHaveLength(0);
    expect(lobby).toHaveLength(0);

    hub.send("B", "notify", { key: "k" });
    expect(b).toHaveLength(1);
    expect(a).toHaveLength(1);
  });

  it("sendLobby — task null 클라이언트만 받음", () => {
    const hub = new NotifyHub();
    const a: string[] = [];
    const lobby: string[] = [];
    hub.add(makeClient((s) => a.push(s)), "A");
    hub.add(makeClient((s) => lobby.push(s)), null);

    hub.sendLobby("state", { unattached: [] });
    expect(lobby).toHaveLength(1);
    expect(lobby[0]).toBe('event: state\ndata: {"unattached":[]}\n\n');
    expect(a).toHaveLength(0);
  });

  it("sendAll — 전원 받음", () => {
    const hub = new NotifyHub();
    const a: string[] = [];
    const b: string[] = [];
    const lobby: string[] = [];
    hub.add(makeClient((s) => a.push(s)), "A");
    hub.add(makeClient((s) => b.push(s)), "B");
    hub.add(makeClient((s) => lobby.push(s)), null);

    hub.sendAll("state", { n: 1 });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(lobby).toHaveLength(1);
    expect(a[0]).toBe('event: state\ndata: {"n":1}\n\n');
  });

  it("attachedCount — 작업별 부착 수", () => {
    const hub = new NotifyHub();
    hub.add(makeClient(), "A");
    hub.add(makeClient(), "A");
    hub.add(makeClient(), "B");
    hub.add(makeClient(), null);

    expect(hub.attachedCount("A")).toBe(2);
    expect(hub.attachedCount("B")).toBe(1);
    expect(hub.attachedCount("C")).toBe(0);
    expect(hub.size).toBe(4);
  });

  it("remove — 제거 후 전달 안 됨", () => {
    const hub = new NotifyHub();
    const a: string[] = [];
    const ca = makeClient((s) => a.push(s));
    hub.add(ca, "A");
    hub.remove(ca);
    hub.send("A", "state", {});
    expect(a).toHaveLength(0);
    expect(hub.size).toBe(0);
  });

  it("쓰기 예외 클라이언트는 제거되고 나머지는 전달됨", () => {
    const hub = new NotifyHub();
    const ok: string[] = [];
    const bad = makeClient(() => {
      throw new Error("broken pipe");
    });
    hub.add(bad, "A");
    hub.add(makeClient((s) => ok.push(s)), "A");

    expect(() => hub.send("A", "state", {})).not.toThrow();
    expect(ok).toHaveLength(1);
    expect(hub.size).toBe(1); // bad 제거
  });
});

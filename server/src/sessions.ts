// T8 — 세션 레지스트리와 파킹. 메모리 상태 + Store 영속 정보.
// 상태 전이: launch 직후 launching(새 작업 PLAN은 unbound) → Stop 수신 시 평가 결과에 따라
// hold→parked / block→working / allow→idle → 파킹 중 close→detached(pending 제거) → 다음 Stop 재평가.
import type { Store } from "./store.js";
import type { PeerView, Reply, Role } from "./machine.js";

export type SessionState = "launching" | "unbound" | "working" | "parked" | "idle" | "detached";

type Timer = ReturnType<typeof setTimeout>;

interface Pending {
  reply: (r: Reply) => void;
  timer: Timer;
  sessionId: string;
}

interface Runtime {
  state: SessionState;
  pending?: Pending;
}

export interface SessionsOptions {
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
  onNotify?: (key: string, level: "info" | "warn", message: string) => void;
}

export class Sessions {
  private runtimes = new Map<string, Runtime>();
  private store: Store;
  private parkLimitSec: number;
  private setTimer: (fn: () => void, ms: number) => Timer;
  private clearTimer: (t: Timer) => void;
  // Orchestrator가 설정 (session_id 전환 notify 전달).
  onNotify?: (key: string, level: "info" | "warn", message: string) => void;

  constructor(store: Store, parkLimitSec: number, opts: SessionsOptions = {}) {
    this.store = store;
    this.parkLimitSec = parkLimitSec;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t));
    this.onNotify = opts.onNotify;
  }

  // 세션의 초기 상태 등록 (T9 launcher가 호출).
  register(sessionKey: string, state: SessionState): void {
    this.runtimes.set(sessionKey, { state });
  }

  stateOf(sessionKey: string): SessionState | undefined {
    return this.runtimes.get(sessionKey)?.state;
  }

  // 같은 project·folder의 다른 역할 세션 뷰를 반환.
  peersFor(project: string, folder: string | null): { plan?: PeerView; verify?: PeerView } {
    const result: { plan?: PeerView; verify?: PeerView } = {};
    for (const [sessionKey, info] of Object.entries(this.store.state.sessions)) {
      if (info.project !== project || info.folder !== folder) continue;
      const view: PeerView = { sessionKey, state: this.stateOf(sessionKey) ?? "detached" };
      if (info.role === "plan" && !result.plan) result.plan = view;
      else if (info.role === "verify" && !result.verify) result.verify = view;
    }
    return result;
  }

  // Stop 수신. session_id 처리(R3-1) 후 pending 등록·파킹.
  // 비활성 session_id의 Stop은 평가 없이 즉시 allow — { handled: true } 반환.
  onStop(
    sessionKey: string,
    claudeSessionId: string,
    reply: (r: Reply) => void,
    onClose: (cb: () => void) => void,
  ): { handled: boolean } {
    let info = this.store.state.sessions[sessionKey];
    if (!info) {
      info = {
        role: "plan",
        project: "",
        folder: null,
        launchedAt: 0,
        sessionIds: [],
        activeSessionId: null,
        switchedOnce: false,
      };
      this.store.state.sessions[sessionKey] = info;
    }

    // session_id 처리 (plan-v3 §6-1 R3-1).
    if (!info.sessionIds.includes(claudeSessionId)) {
      info.sessionIds.push(claudeSessionId);
      if (info.activeSessionId === null) info.activeSessionId = claudeSessionId;
    }
    if (claudeSessionId !== info.activeSessionId) {
      if (!info.switchedOnce) {
        // 활성 전환 1회: 이전 활성의 pending을 allow로 해제 + notify + switchedOnce.
        const prev = info.activeSessionId;
        info.activeSessionId = claudeSessionId;
        info.switchedOnce = true;
        this.releasePending(sessionKey, { action: "allow" });
        this.onNotify?.(`switch-${sessionKey}`, "warn", `세션 전환 감지 — 이전 세션(${prev})을 allow로 해제했습니다`);
        this.store.save();
      } else {
        // 그 외 비활성 session_id의 Stop — 평가 없이 즉시 allow.
        reply({ action: "allow" });
        return { handled: true };
      }
    }

    // pending 등록 + 파킹 + parkLimitSec 타이머.
    const runtime = this.getOrCreate(sessionKey);
    this.releasePending(sessionKey, { action: "allow" }); // 기존 pending이 있으면 방출.
    const timer = this.setTimer(() => this.onParkTimeout(sessionKey), this.parkLimitSec * 1000);
    runtime.pending = { reply, timer, sessionId: claudeSessionId };
    runtime.state = "parked";
    onClose(() => this.handleClose(sessionKey));
    return { handled: false };
  }

  // 평가 결과 적용: pending을 reply로 방출하고 상태 전이.
  resolve(sessionKey: string, r: Reply): void {
    const runtime = this.runtimes.get(sessionKey);
    if (!runtime?.pending) return;
    this.clearTimer(runtime.pending.timer);
    runtime.pending.reply(r);
    runtime.pending = undefined;
    runtime.state = r.action === "block" ? "working" : "idle";
  }

  private getOrCreate(sessionKey: string): Runtime {
    let runtime = this.runtimes.get(sessionKey);
    if (!runtime) {
      runtime = { state: "launching" };
      this.runtimes.set(sessionKey, runtime);
    }
    return runtime;
  }

  private releasePending(sessionKey: string, r: Reply): void {
    const runtime = this.runtimes.get(sessionKey);
    if (runtime?.pending) {
      this.clearTimer(runtime.pending.timer);
      runtime.pending.reply(r);
      runtime.pending = undefined;
    }
  }

  // parkLimitSec 만료 — reply allow, 상태 idle, 이벤트 기록.
  private onParkTimeout(sessionKey: string): void {
    const runtime = this.runtimes.get(sessionKey);
    if (!runtime?.pending) return;
    this.clearTimer(runtime.pending.timer);
    runtime.pending.reply({ action: "allow" });
    runtime.pending = undefined;
    runtime.state = "idle";
    this.store.appendEvent({ type: "reply", sessionKey, action: "allow", reason: "park-timeout" });
  }

  // 파킹 중 close 이벤트 — detached, pending 제거.
  private handleClose(sessionKey: string): void {
    const runtime = this.runtimes.get(sessionKey);
    if (!runtime || runtime.state !== "parked") return;
    runtime.state = "detached";
    if (runtime.pending) {
      this.clearTimer(runtime.pending.timer);
      runtime.pending = undefined;
    }
    this.store.appendEvent({ type: "detach", sessionKey });
  }
}

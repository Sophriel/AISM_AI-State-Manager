// T5 — 상태 머신 (plan-v3 §3.6). 순수 함수: 파일·시간·네트워크 접근 금지.
// 판정표 행 0~11을 그 순서대로 적용한다.
import type { Snapshot } from "./artifacts.js";

export type Role = "plan" | "verify";

export interface PeerView {
  sessionKey: string;
  state: "launching" | "unbound" | "working" | "parked" | "idle" | "detached";
}

export interface TaskRecord {
  notified: string[];
  consecutiveBlocks: Record<string, number>;
}

export interface MachineInput {
  sender: { sessionKey: string; role: Role; bound: boolean };
  taskActive: boolean;
  snapshot: Snapshot;
  newPlanFolders: string[];
  peers: { plan?: PeerView; verify?: PeerView };
  record: TaskRecord;
  config: { confirmFromVersion: number; maxConsecutiveBlocks: number };
}

export type Reply = { action: "allow" } | { action: "block"; reason: string };

export type Action =
  | { kind: "reply"; sessionKey: string; reply: Reply }
  | { kind: "hold"; sessionKey: string }
  | { kind: "launch"; role: Role }
  | { kind: "bind"; folder: string }
  | { kind: "notify"; key: string; level: "info" | "warn"; message: string; copyText?: string }
  | { kind: "record"; notified?: string[]; consecutiveBlocks?: Record<string, number> }
  | { kind: "undeliverable"; role: Role; text: string };

// 지시 문장 (한국어, 고정) — plan-v3 §3.6.
export function instructionVerifyPlan(N: number): string {
  return `plan-v${N}.md에 문제점이나 모호한 부분이 있는지 검증해서 plan-v${N}-verify.md를 작성해.`;
}
export function instructionPlanRevise(N: number): string {
  return `plan-v${N}-verify.md의 지적을 반영해서 plan-v${N + 1}.md를 작성해.`;
}
export function instructionVerdictLine(N: number): string {
  return `plan-v${N}-verify.md의 마지막 줄에 정확히 "판정: PASS" 또는 "판정: REVISE"를 써.`;
}

const part = (v: string | number | null): string => (v === null ? "null" : String(v));

export function evaluate(input: MachineInput): Action[] {
  const { sender, taskActive, snapshot, newPlanFolders, peers, record, config } = input;
  const actions: Action[] = [];
  const notified = new Set(record.notified);
  const counts: Record<string, number> = { ...record.consecutiveBlocks };
  let dirty = false;

  const notify = (key: string, level: "info" | "warn", message: string, copyText?: string) => {
    if (notified.has(key)) return; // 중복 방지 — record.notified에 있으면 내지 않는다.
    notified.add(key);
    dirty = true;
    actions.push(
      copyText !== undefined
        ? { kind: "notify", key, level, message, copyText }
        : { kind: "notify", key, level, message },
    );
  };

  const allow = (sessionKey: string) => {
    actions.push({ kind: "reply", sessionKey, reply: { action: "allow" } });
    if ((counts[sessionKey] ?? 0) !== 0) {
      counts[sessionKey] = 0; // allow를 내면 해당 카운트를 0으로.
      dirty = true;
    }
  };

  const block = (sessionKey: string, reason: string) => {
    const next = (counts[sessionKey] ?? 0) + 1;
    if (next > config.maxConsecutiveBlocks) {
      // 연속 상한 초과 → 대신 allow + warn.
      actions.push({ kind: "reply", sessionKey, reply: { action: "allow" } });
      notify(`blocks-${sessionKey}`, "warn", `연속 block ${config.maxConsecutiveBlocks}회 — allow로 해제했습니다`);
      if ((counts[sessionKey] ?? 0) !== 0) {
        counts[sessionKey] = 0;
        dirty = true;
      }
    } else {
      actions.push({ kind: "reply", sessionKey, reply: { action: "block", reason } });
      counts[sessionKey] = next;
      dirty = true;
    }
  };

  // 지시 전달 규칙 (R1-4, R1-5).
  const deliver = (role: Role, text: string) => {
    const peer = peers[role];
    if (!peer || peer.state === "detached") {
      actions.push({ kind: "launch", role });
    } else if (peer.state === "parked") {
      block(peer.sessionKey, text);
    } else if (peer.state === "idle") {
      actions.push({ kind: "undeliverable", role, text }); // notify는 내지 않는다 — T12가 처리.
    }
    // launching / working / unbound → 아무 Action 없음.
  };

  const finish = (): Action[] => {
    if (dirty) {
      actions.push({ kind: "record", notified: [...notified], consecutiveBlocks: counts });
    }
    return actions;
  };

  const N = snapshot.latestN;

  // 행 0 — 비활성(종료된) 작업의 세션: 평가 없이 allow, 알림 없음.
  if (!taskActive) {
    allow(sender.sessionKey);
    return finish();
  }

  // 행 1 — PLAN (unbound).
  if (sender.role === "plan" && !sender.bound) {
    if (newPlanFolders.length === 1) {
      // bind + allow만 반환 — 바인딩 후 재평가는 다음 Stop부터.
      actions.push({ kind: "bind", folder: newPlanFolders[0] });
      allow(sender.sessionKey);
    } else if (newPlanFolders.length === 0) {
      allow(sender.sessionKey);
    } else {
      allow(sender.sessionKey);
      notify("bind-ambiguous", "warn", `새 plan 폴더가 ${newPlanFolders.length}개 생겼습니다 — 하나만 남기세요`);
    }
    return finish();
  }

  if (sender.role === "plan") {
    // 행 2 — NEEDS_DECISION.
    if (snapshot.status === "NEEDS_DECISION") {
      allow(sender.sessionKey);
      notify(`decision-v${part(N)}`, "warn", `plan-v${part(N)}에 결정이 필요합니다`);
      return finish();
    }
    // 행 3 — IN_REVIEW, verify-vN 없음.
    if (snapshot.status === "IN_REVIEW" && !snapshot.verifyExists) {
      actions.push({ kind: "hold", sessionKey: sender.sessionKey });
      deliver("verify", instructionVerifyPlan(N ?? 0));
      return finish();
    }
    // 행 4 — IN_REVIEW, verify-vN 있음 (사용자가 대화 중으로 간주).
    if (snapshot.status === "IN_REVIEW") {
      allow(sender.sessionKey);
      return finish();
    }
    // 행 4a — DRAFT 또는 Status 줄 없음.
    if (snapshot.status === "DRAFT" || snapshot.status === "MISSING") {
      allow(sender.sessionKey);
      return finish();
    }
    // 행 5 — APPROVED / TODO_READY / 그 이후 (M2 범위, 사용자 주도).
    if (
      snapshot.status === "APPROVED" ||
      snapshot.status === "TODO_READY" ||
      snapshot.status === "IN_PROGRESS" ||
      snapshot.status === "BLOCKED" ||
      snapshot.status === "DONE"
    ) {
      allow(sender.sessionKey);
      return finish();
    }
    // status null (plan 파일 없음) → 행 11로 낙하.
  }

  if (sender.role === "verify") {
    if (!snapshot.verifyExists) {
      // 행 10 — verify-vN 없음.
      allow(sender.sessionKey);
      notify(`noverify-v${part(N)}`, "warn", `plan-v${part(N)}-verify.md가 없습니다 — 검증 결과가 없습니다`);
      return finish();
    }

    if (snapshot.verdict === "REVISE") {
      if ((N ?? 0) < config.confirmFromVersion) {
        // 행 6 — REVISE, N < confirmFromVersion.
        actions.push({ kind: "hold", sessionKey: sender.sessionKey });
        deliver("plan", instructionPlanRevise(N ?? 0));
      } else {
        // 행 7 — REVISE, N ≥ confirmFromVersion (v5 게이트, D2).
        actions.push({ kind: "hold", sessionKey: sender.sessionKey });
        notify(`gate-v${part(N)}`, "warn", `plan-v${part(N)} REVISE — 계속 개정하려면 PLAN 창에서 지시하세요`);
      }
      return finish();
    }

    if (snapshot.verdict === "PASS") {
      // 행 8 — PASS.
      allow(sender.sessionKey);
      const planPeer = peers.plan;
      if (planPeer && planPeer.state === "parked") allow(planPeer.sessionKey);
      notify(`pass-v${part(N)}`, "info", `plan-v${part(N)} PASS`);
      return finish();
    }

    if (snapshot.verdict === "MALFORMED") {
      // 행 9 — 판정 줄 없음/형식 오류 (연속 상한 적용).
      block(sender.sessionKey, instructionVerdictLine(N ?? 0));
      return finish();
    }
  }

  // 행 11 — 그 외 모든 조합.
  allow(sender.sessionKey);
  notify(
    `unexpected-${sender.role}-${part(N)}-${part(snapshot.status)}-${part(snapshot.verdict)}`,
    "warn",
    `예상하지 못한 상태: Status=${part(snapshot.status)}, 판정=${part(snapshot.verdict)}`,
  );
  return finish();
}

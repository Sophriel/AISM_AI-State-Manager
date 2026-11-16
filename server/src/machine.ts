// T5 — 상태 머신 (plan-v3 §3.6). 순수 함수: 파일·시간·네트워크 접근 금지.
// 판정표 행 0~11 + 5t·c1~c9(M2)를 그 순서대로 적용한다.
import type { Snapshot, TodoSnapshot } from "./artifacts.js";

export type Role = "planner" | "verifier" | "coder";

export interface PeerView {
  sessionKey: string;
  state: "unbound" | "working" | "parked" | "idle" | "detached";
}

export interface TaskRecord {
  notified: string[];
  consecutiveBlocks: Record<string, number>;
  instructed: string[];
}

export interface MachineInput {
  sender: { sessionKey: string; role: Role; bound: boolean };
  taskActive: boolean;
  snapshot: Snapshot;
  todo: TodoSnapshot;
  newPlanFolders: string[];
  peers: { planner?: PeerView; verifier?: PeerView; coder?: PeerView };
  record: TaskRecord;
  config: { confirmFromVersion: number; maxConsecutiveBlocks: number };
}

export type Reply = { action: "allow" } | { action: "block"; reason: string };

export type Action =
  | { kind: "reply"; sessionKey: string; reply: Reply }
  | { kind: "hold"; sessionKey: string }
  | { kind: "launch"; role: Role }
  | { kind: "notify"; key: string; level: "info" | "warn"; message: string; copyText?: string }
  | { kind: "record"; notified?: string[]; consecutiveBlocks?: Record<string, number>; instructed?: string[] }
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
// W5 — PASS 이후 todo 지시 (plan-v8 §W5).
export function instructionApproveAndTodo(N: number): string {
  return `plan-v${N}-verify.md가 PASS다. plan-v${N}.md의 Status를 APPROVED로 바꾸고 todo를 작성한 뒤 Status를 TODO_READY로 바꿔. todo 파일은 todo-v1.md이고, 이미 있으면 다음 버전 번호로 써.`;
}
export function instructionFinishTodo(N: number): string {
  return `plan-v${N}.md가 APPROVED 상태다. todo를 작성하고 Status를 TODO_READY로 바꿔. todo 파일은 todo-v1.md이고, 이미 있으면 다음 버전 번호로 써.`;
}
// M2 — todo 루프 지시 (plan-v2 §3 C).
export function instructionReviewTodo(T: number): string {
  return `todo-v${T}.md를 검토해서 todo-v${T}-verify.md를 작성해.`;
}
export function instructionTodoRevise(T: number): string {
  return `todo-v${T}-verify.md의 지적을 반영해서 todo-v${T + 1}.md를 작성해.`;
}
export function instructionTodoVerdictLine(T: number): string {
  return `todo-v${T}-verify.md의 마지막 줄에 정확히 "판정: PASS" 또는 "판정: REVISE"를 써.`;
}
export function instructionImplement(T: number): string {
  return `todo-v${T}-verify.md가 PASS다. todo-v${T}.md를 순서대로 구현해.`;
}
export function instructionBlocked(N: number): string {
  return `plan-v${N}.md가 BLOCKED다. code-log.md의 Blocked 내용을 읽고 plan-v${N + 1}.md를 작성해.`;
}

const part = (v: string | number | null): string => (v === null ? "null" : String(v));

export function evaluate(input: MachineInput): Action[] {
  const { sender, taskActive, snapshot, todo, newPlanFolders, peers, record, config } = input;
  const actions: Action[] = [];
  const notified = new Set(record.notified);
  const instructed = new Set(record.instructed);
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

  // true = 실제로 block을 냈다, false = 상한 초과로 allow를 냈다.
  const block = (sessionKey: string, reason: string): boolean => {
    const next = (counts[sessionKey] ?? 0) + 1;
    if (next > config.maxConsecutiveBlocks) {
      // 연속 상한 초과 → 대신 allow + warn.
      actions.push({ kind: "reply", sessionKey, reply: { action: "allow" } });
      notify(`blocks-${sessionKey}`, "warn", `연속 block ${config.maxConsecutiveBlocks}회 — allow로 해제했습니다`);
      if ((counts[sessionKey] ?? 0) !== 0) {
        counts[sessionKey] = 0;
        dirty = true;
      }
      return false;
    }
    actions.push({ kind: "reply", sessionKey, reply: { action: "block", reason } });
    counts[sessionKey] = next;
    dirty = true;
    return true;
  };

  // 지시 전달 규칙 (R1-4, R1-5, ADR 0011). "blocked" = peer가 parked여서 block을 냈다.
  // 배정 없음 → launch, parked → block, idle·detached → undeliverable, working·unbound → 없음.
  const deliver = (role: Role, text: string): "blocked" | "none" => {
    const peer = peers[role];
    if (!peer) {
      actions.push({ kind: "launch", role });
    } else if (peer.state === "parked") {
      return block(peer.sessionKey, text) ? "blocked" : "none";
    } else if (peer.state === "idle" || peer.state === "detached") {
      actions.push({ kind: "undeliverable", role, text }); // notify는 내지 않는다 — T12가 처리.
    }
    // working / unbound → 아무 Action 없음.
    return "none";
  };

  const finish = (): Action[] => {
    if (dirty) {
      actions.push({
        kind: "record",
        notified: [...notified],
        consecutiveBlocks: counts,
        instructed: [...instructed],
      });
    }
    return actions;
  };

  const N = snapshot.latestN;

  // 행 0 — 비활성(종료된) 작업의 세션: 평가 없이 allow, 알림 없음.
  if (!taskActive) {
    allow(sender.sessionKey);
    return finish();
  }

  // 행 1 — PLANNER (unbound). 바인딩은 handleStop에서 바로 수행하므로(W1) 여기서는 0개/≥2개만 남음.
  if (sender.role === "planner" && !sender.bound) {
    if (newPlanFolders.length === 0) {
      allow(sender.sessionKey);
    } else {
      allow(sender.sessionKey);
      notify("bind-ambiguous", "warn", `새 plan 폴더가 ${newPlanFolders.length}개 생겼습니다 — 하나만 남기세요`);
    }
    return finish();
  }

  if (sender.role === "planner") {
    // 행 2 — NEEDS_DECISION.
    if (snapshot.status === "NEEDS_DECISION") {
      allow(sender.sessionKey);
      notify(`decision-v${part(N)}`, "warn", `plan-v${part(N)}에 결정이 필요합니다`);
      return finish();
    }
    // 행 3 — IN_REVIEW, verify-vN 없음.
    if (snapshot.status === "IN_REVIEW" && !snapshot.verifyExists) {
      actions.push({ kind: "hold", sessionKey: sender.sessionKey });
      deliver("verifier", instructionVerifyPlan(N ?? 0));
      return finish();
    }
    // 행 4p — IN_REVIEW + PASS (W5): PLANNER에 APPROVED·todo 작성을 지시.
    if (snapshot.status === "IN_REVIEW" && snapshot.verdict === "PASS") {
      const key = `todo-v${N ?? 0}`;
      if (instructed.has(key)) {
        allow(sender.sessionKey);
      } else if (block(sender.sessionKey, instructionApproveAndTodo(N ?? 0))) {
        instructed.add(key);
        dirty = true;
      }
      // block이 false(상한 초과)면 기록 없이 끝 — allow는 block()이 이미 냈다.
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
    // 행 5 — APPROVED / TODO_READY / 그 이후 (W5).
    if (snapshot.status === "APPROVED") {
      block(sender.sessionKey, instructionFinishTodo(N ?? 0));
      return finish();
    }
    if (snapshot.status === "TODO_READY") {
      // 행 5t — todo 루프 (M2).
      const T = todo.latestN;
      if (T === null) {
        allow(sender.sessionKey);
        notify(`notodo-v${part(N)}`, "warn", `plan-v${part(N)}이 TODO_READY인데 todo 파일이 없습니다`);
      } else if (!todo.verifyExists) {
        actions.push({ kind: "hold", sessionKey: sender.sessionKey });
        deliver("coder", instructionReviewTodo(T));
      } else {
        allow(sender.sessionKey);
      }
      return finish();
    }
    if (snapshot.status === "IN_PROGRESS" || snapshot.status === "BLOCKED" || snapshot.status === "DONE") {
      allow(sender.sessionKey);
      return finish();
    }
    // status null (plan 파일 없음) → 행 11로 낙하.
  }

  if (sender.role === "verifier") {
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
        deliver("planner", instructionPlanRevise(N ?? 0));
      } else {
        // 행 7 — REVISE, N ≥ confirmFromVersion (v5 게이트, D2).
        actions.push({ kind: "hold", sessionKey: sender.sessionKey });
        notify(`gate-v${part(N)}`, "warn", `plan-v${part(N)} REVISE — 계속 개정하려면 PLANNER 창에서 지시하세요`);
      }
      return finish();
    }

    if (snapshot.verdict === "PASS") {
      // 행 8 — PASS (W5): PLANNER에 todo 작성을 지시.
      allow(sender.sessionKey);
      notify(`pass-v${part(N)}`, "info", `plan-v${part(N)} PASS — PLANNER에 todo 작성을 지시합니다`);
      const key = `todo-v${N ?? 0}`;
      if (!instructed.has(key)) {
        if (deliver("planner", instructionApproveAndTodo(N ?? 0)) === "blocked") {
          instructed.add(key);
          dirty = true;
        }
      }
      return finish();
    }

    if (snapshot.verdict === "MALFORMED") {
      // 행 9 — 판정 줄 없음/형식 오류 (연속 상한 적용).
      block(sender.sessionKey, instructionVerdictLine(N ?? 0));
      return finish();
    }
  }

  if (sender.role === "coder") {
    const T = todo.latestN;
    if (snapshot.status === "TODO_READY") {
      if (T === null) {
        // c1
        allow(sender.sessionKey);
        notify(`notodo-v${part(N)}`, "warn", `plan-v${part(N)}이 TODO_READY인데 todo 파일이 없습니다`);
        return finish();
      }
      if (!todo.verifyExists) {
        // c2
        allow(sender.sessionKey);
        notify(`notodoverify-v${T}`, "warn", `todo-v${T}-verify.md가 없습니다 — 검토 결과가 없습니다`);
        return finish();
      }
      if (todo.verdict === "REVISE") {
        actions.push({ kind: "hold", sessionKey: sender.sessionKey });
        if (T < config.confirmFromVersion) {
          // c3
          deliver("planner", instructionTodoRevise(T));
        } else {
          // c4 — todo 게이트 (D2).
          notify(`todo-gate-v${T}`, "warn", `todo-v${T} REVISE — 계속 개정하려면 PLANNER 창에서 지시하세요`);
        }
        return finish();
      }
      if (todo.verdict === "MALFORMED") {
        // c5
        block(sender.sessionKey, instructionTodoVerdictLine(T));
        return finish();
      }
      if (todo.verdict === "PASS") {
        // c6
        const key = `impl-v${T}`;
        if (instructed.has(key)) {
          allow(sender.sessionKey);
        } else if (block(sender.sessionKey, instructionImplement(T))) {
          instructed.add(key);
          dirty = true;
        }
        return finish();
      }
    }
    if (snapshot.status === "IN_PROGRESS") {
      // c7
      allow(sender.sessionKey);
      notify(`coder-stopped-v${part(T)}`, "info", "CODER가 구현 중 멈췄습니다 — CODER 창을 확인하세요");
      return finish();
    }
    if (snapshot.status === "BLOCKED") {
      // c8 (W-6)
      allow(sender.sessionKey);
      notify(`blocked-v${part(N)}`, "warn", `plan-v${part(N)} BLOCKED — PLANNER에 다음 plan 작성을 지시합니다`);
      const key = `blocked-v${N ?? 0}`;
      if (!instructed.has(key) && deliver("planner", instructionBlocked(N ?? 0)) === "blocked") {
        instructed.add(key);
        dirty = true;
      }
      return finish();
    }
    if (snapshot.status === "DONE") {
      // c9
      allow(sender.sessionKey);
      notify(`done-v${part(N)}`, "info", `구현 완료 (plan-v${part(N)}) — 테스트 후 작업을 종료하세요`);
      const p = peers.planner;
      if (p && p.state === "parked") allow(p.sessionKey);
      return finish();
    }
    // 그 외 → 행 11로 낙하.
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

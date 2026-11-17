// T4 — 산출물 스냅샷 파서 (plan-v3 §3.5). 파일과 훅으로만 판정 (ADR 0002).
import fs from "node:fs";
import path from "node:path";

// _workflow.md Status line 8개 값.
export const STATUS_VALUES = [
  "DRAFT",
  "NEEDS_DECISION",
  "IN_REVIEW",
  "APPROVED",
  "TODO_READY",
  "IN_PROGRESS",
  "BLOCKED",
  "DONE",
] as const;

export type Status = (typeof STATUS_VALUES)[number];

export interface Snapshot {
  latestN: number | null;
  status: Status | "MISSING" | null;
  verifyExists: boolean;
  verdict: "PASS" | "REVISE" | "MALFORMED" | null;
}

const PLAN_RE = /^plan-v(\d+)\.md$/;

function splitLines(raw: string): string[] {
  // BOM 제거 (공통 규약: UTF-8 BOM 없음 — 안전장치), \r\n·\r·\n 모두 처리.
  return raw.replace(/^﻿/, "").split(/\r\n|\r|\n/).map((l) => l.replace(/\r$/, ""));
}

// verify 파일 판정 — 없으면 { exists: false, verdict: null }. 있으면 끝의 빈 줄을 제외한
// 마지막 줄을 \r 제거 후 "판정: PASS" / "판정: REVISE"와 정확히 비교, 그 외 "MALFORMED".
export function readVerdict(verifyPath: string): { exists: boolean; verdict: "PASS" | "REVISE" | "MALFORMED" | null } {
  let exists = false;
  let verdict: "PASS" | "REVISE" | "MALFORMED" | null = null;
  try {
    exists = fs.statSync(verifyPath).isFile();
  } catch {
    exists = false;
  }
  if (exists) {
    const lines = splitLines(fs.readFileSync(verifyPath, "utf8"));
    let last = lines.length;
    while (last > 0 && lines[last - 1].trim() === "") last--;
    const lastLine = last > 0 ? lines[last - 1] : "";
    if (lastLine === "판정: PASS") verdict = "PASS";
    else if (lastLine === "판정: REVISE") verdict = "REVISE";
    else verdict = "MALFORMED";
  }
  return { exists, verdict };
}

export function readSnapshot(taskDir: string): Snapshot {
  let entries: string[];
  try {
    entries = fs.readdirSync(taskDir);
  } catch {
    return { latestN: null, status: null, verifyExists: false, verdict: null };
  }

  // 최신 N = ^plan-v(\d+)\.md$ 중 최대.
  let latestN: number | null = null;
  for (const name of entries) {
    const m = name.match(PLAN_RE);
    if (m) {
      const n = Number(m[1]);
      if (latestN === null || n > latestN) latestN = n;
    }
  }

  if (latestN === null) {
    return { latestN: null, status: null, verifyExists: false, verdict: null };
  }

  // status: 최신 plan 첫 줄을 \r 제거 후 /^Status:\s*(\S+)\s*$/ 매칭, 8개 값이 아니면 "MISSING".
  let status: Status | "MISSING" = "MISSING";
  try {
    const lines = splitLines(fs.readFileSync(path.join(taskDir, `plan-v${latestN}.md`), "utf8"));
    const m = (lines[0] ?? "").match(/^Status:\s*(\S+)\s*$/);
    if (m && (STATUS_VALUES as readonly string[]).includes(m[1])) {
      status = m[1] as Status;
    }
  } catch {
    status = "MISSING";
  }

  // verdict — plan-vN-verify.md (readVerdict 공통 규칙).
  const { exists: verifyExists, verdict } = readVerdict(path.join(taskDir, `plan-v${latestN}-verify.md`));

  return { latestN, status, verifyExists, verdict };
}

// todo 스냅샷 — 최신 todo-vN.md와 그 verify 파일 (M2).
export interface TodoSnapshot {
  latestN: number | null;
  verifyExists: boolean;
  verdict: "PASS" | "REVISE" | "MALFORMED" | null;
  checklistExists: boolean; // todo-v<latestN>-checklist.md 존재 여부 (M2 polish §3 H)
}

const TODO_RE = /^todo-v(\d+)\.md$/;

export function readTodoSnapshot(taskDir: string): TodoSnapshot {
  let entries: string[];
  try {
    entries = fs.readdirSync(taskDir);
  } catch {
    return { latestN: null, verifyExists: false, verdict: null, checklistExists: false };
  }

  // 최신 T = ^todo-v(\d+)\.md$ 중 최대 (checklist·notes·verify는 매칭 안 됨).
  let latestN: number | null = null;
  for (const name of entries) {
    const m = name.match(TODO_RE);
    if (m) {
      const n = Number(m[1]);
      if (latestN === null || n > latestN) latestN = n;
    }
  }

  if (latestN === null) {
    return { latestN: null, verifyExists: false, verdict: null, checklistExists: false };
  }

  const { exists, verdict } = readVerdict(path.join(taskDir, `todo-v${latestN}-verify.md`));
  return {
    latestN,
    verifyExists: exists,
    verdict,
    checklistExists: fs.existsSync(path.join(taskDir, `todo-v${latestN}-checklist.md`)),
  };
}

export function emptyTodoSnapshot(): TodoSnapshot {
  return { latestN: null, verifyExists: false, verdict: null, checklistExists: false };
}

// plansDir의 직속 폴더 중 plan-v1.md 생성 시각(birthtimeMs)이 sinceMs 이후인 폴더명 목록.
export function findNewPlanV1(plansDir: string, sinceMs: number): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(plansDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const st = fs.statSync(path.join(plansDir, e.name, "plan-v1.md"));
      if (st.birthtimeMs > sinceMs) result.push(e.name);
    } catch {
      // plan-v1.md 없는 폴더 — 건너뜀.
    }
  }
  return result.sort();
}

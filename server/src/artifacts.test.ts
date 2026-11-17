// T4 완료 조건 — 픽스처 8케이스 + findNewPlanV1.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { readSnapshot, readTodoSnapshot, findNewPlanV1 } from "./artifacts.js";

const here = path.dirname(fileURLToPath(import.meta.url)); // server/src
const fixtures = path.join(here, "..", "test", "fixtures"); // server/test/fixtures

describe("readSnapshot", () => {
  it("plan 없음", () => {
    expect(readSnapshot(path.join(fixtures, "no-plan"))).toEqual({
      latestN: null,
      status: null,
      verifyExists: false,
      verdict: null,
    });
  });

  it("v1만", () => {
    expect(readSnapshot(path.join(fixtures, "v1-only"))).toEqual({
      latestN: 1,
      status: "DRAFT",
      verifyExists: false,
      verdict: null,
    });
  });

  it("v2 + v1-verify REVISE (verify는 이전 버전용 — 최신 v2에는 없음)", () => {
    expect(readSnapshot(path.join(fixtures, "v2-v1-verify-revise"))).toEqual({
      latestN: 2,
      status: "IN_REVIEW",
      verifyExists: false,
      verdict: null,
    });
  });

  it("v3 + v3-verify PASS", () => {
    expect(readSnapshot(path.join(fixtures, "v3-v3-verify-pass"))).toEqual({
      latestN: 3,
      status: "APPROVED",
      verifyExists: true,
      verdict: "PASS",
    });
  });

  it("CRLF 파일 (첫 줄·마지막 줄 \r 제거)", () => {
    expect(readSnapshot(path.join(fixtures, "crlf"))).toEqual({
      latestN: 1,
      status: "IN_PROGRESS",
      verifyExists: true,
      verdict: "REVISE",
    });
  });

  it("Status 없음 (첫 줄이 Status 아님) — MISSING", () => {
    expect(readSnapshot(path.join(fixtures, "no-status"))).toEqual({
      latestN: 1,
      status: "MISSING",
      verifyExists: false,
      verdict: null,
    });
  });

  it("판정 줄 오타 — MALFORMED", () => {
    expect(readSnapshot(path.join(fixtures, "verdict-typo"))).toEqual({
      latestN: 1,
      status: "IN_PROGRESS",
      verifyExists: true,
      verdict: "MALFORMED",
    });
  });

  it("버전 건너뜀 (v2, v4) — 최신 v4", () => {
    expect(readSnapshot(path.join(fixtures, "version-skip"))).toEqual({
      latestN: 4,
      status: "TODO_READY",
      verifyExists: false,
      verdict: null,
    });
  });
});

describe("readTodoSnapshot", () => {
  it("todo 없음 — latestN null", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aism-todo-"));
    fs.writeFileSync(path.join(dir, "plan-v1.md"), "Status: DRAFT\n");
    expect(readTodoSnapshot(dir)).toEqual({ latestN: null, verifyExists: false, verdict: null, checklistExists: false });
  });

  it("todo-v1·v2 + checklist·notes — 최신 T=2, verify 없음 (todo-v1-checklist만 → checklistExists false)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aism-todo-"));
    for (const name of ["todo-v1.md", "todo-v2.md", "todo-v1-checklist.md", "todo-v1-notes.md"]) {
      fs.writeFileSync(path.join(dir, name), "x\n");
    }
    expect(readTodoSnapshot(dir)).toEqual({ latestN: 2, verifyExists: false, verdict: null, checklistExists: false });
  });

  it("checklistExists — todo-v2만 → false, todo-v2-checklist.md 추가 → true", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aism-todo-"));
    fs.writeFileSync(path.join(dir, "todo-v2.md"), "x\n");
    expect(readTodoSnapshot(dir).checklistExists).toBe(false);
    fs.writeFileSync(path.join(dir, "todo-v2-checklist.md"), "x\n");
    expect(readTodoSnapshot(dir).checklistExists).toBe(true);
  });

  it("verify 마지막 줄 — PASS / REVISE / 오타(MALFORMED)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aism-todo-"));
    fs.writeFileSync(path.join(dir, "todo-v1.md"), "x\n");
    fs.writeFileSync(path.join(dir, "todo-v1-verify.md"), "내용\n판정: PASS\n");
    expect(readTodoSnapshot(dir)).toEqual({ latestN: 1, verifyExists: true, verdict: "PASS", checklistExists: false });

    fs.writeFileSync(path.join(dir, "todo-v1-verify.md"), "내용\n판정: REVISE\n");
    expect(readTodoSnapshot(dir)).toEqual({ latestN: 1, verifyExists: true, verdict: "REVISE", checklistExists: false });

    fs.writeFileSync(path.join(dir, "todo-v1-verify.md"), "내용\n판정: 통과\n");
    expect(readTodoSnapshot(dir)).toEqual({ latestN: 1, verifyExists: true, verdict: "MALFORMED", checklistExists: false });
  });

  it("폴더가 없으면 null", () => {
    expect(readTodoSnapshot(path.join(os.tmpdir(), "aism-no-such-dir-xyz"))).toEqual({
      latestN: null,
      verifyExists: false,
      verdict: null,
      checklistExists: false,
    });
  });
});

describe("findNewPlanV1", () => {
  it("plan-v1.md 생성 시각이 sinceMs 이후인 폴더만", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aism-plans-"));
    for (const name of ["261111-alpha", "261111-beta"]) {
      fs.mkdirSync(path.join(dir, name));
      fs.writeFileSync(path.join(dir, name, "plan-v1.md"), "Status: DRAFT\n");
    }
    fs.mkdirSync(path.join(dir, "261111-gamma")); // plan-v1.md 없음
    const now = Date.now();
    expect(findNewPlanV1(dir, now - 60_000)).toEqual(["261111-alpha", "261111-beta"]);
    expect(findNewPlanV1(dir, now + 60_000)).toEqual([]);
  });

  it("plansDir가 없으면 빈 목록", () => {
    expect(findNewPlanV1(path.join(os.tmpdir(), "aism-no-such-dir-xyz"), 0)).toEqual([]);
  });
});

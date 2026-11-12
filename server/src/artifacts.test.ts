// T4 완료 조건 — 픽스처 8케이스 + findNewPlanV1.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { readSnapshot, findNewPlanV1 } from "./artifacts.js";

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

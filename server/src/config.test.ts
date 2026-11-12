// T3 완료 조건 — 예시 파일 로드 성공, 검증 실패 케이스 3개 throw, AISM_ROOT 위치.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { AISM_ROOT, MANAGED_ENV, loadConfig } from "./config.js";

const examplePath = path.join(AISM_ROOT, "aism.config.example.json");
const example = loadConfig(examplePath);

function writeTemp(obj: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aism-cfg-"));
  const p = path.join(dir, "config.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

describe("config", () => {
  it("예시 파일 로드 성공 (plan-v3 §3.2 구조)", () => {
    expect(example.port).toBe(4400);
    expect(example.endpoints.cloud).toEqual({});
    expect(example.endpoints.local.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8080");
    expect(example.roles.plan.endpoint).toBe("cloud");
    expect(example.roles.verify.endpoint).toBe("local");
    expect(example.roles.plan.prompt).toEqual(["roles/_workflow.md", "roles/plan.md"]);
    expect(example.projects.EWE.plansDir).toBe(".claude/plans");
    expect(example.projects.EWE.protectedPaths).toEqual([
      "Source/**",
      "Plugins/**",
      "Config/**",
      "Content/**",
    ]);
    expect(example.confirmFromVersion).toBe(5);
    expect(example.maxConsecutiveBlocks).toBe(3);
    expect(example.parkLimitSec).toBe(3300);
    expect(example.hookTimeoutSec).toBe(3600);
  });

  it("MANAGED_ENV는 관리 대상 4변수", () => {
    expect(MANAGED_ENV).toEqual([
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_MODEL",
      "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    ]);
  });

  it("필수 키 누락이면 throw (경로 포함)", () => {
    const bad = { ...example } as Record<string, unknown>;
    delete bad.parkLimitSec;
    const p = writeTemp(bad);
    expect(() => loadConfig(p)).toThrow(/parkLimitSec/);
    expect(() => loadConfig(p)).toThrow(p);
  });

  it("roles.*.endpoint가 endpoints에 없으면 throw", () => {
    const bad = {
      ...example,
      roles: { ...example.roles, plan: { ...example.roles.plan, endpoint: "nope" } },
    };
    expect(() => loadConfig(writeTemp(bad))).toThrow(/roles\.plan\.endpoint/);
  });

  it("parkLimitSec >= hookTimeoutSec이면 throw", () => {
    const bad = { ...example, parkLimitSec: example.hookTimeoutSec };
    expect(() => loadConfig(writeTemp(bad))).toThrow(/parkLimitSec/);
  });

  it("AISM_ROOT는 aism.config.example.json이 있는 폴더", () => {
    expect(fs.existsSync(path.join(AISM_ROOT, "aism.config.example.json"))).toBe(true);
  });
});

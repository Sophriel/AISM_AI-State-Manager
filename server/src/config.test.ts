// T3 완료 조건 — 예시 파일 로드 성공, 엄격 검증(닫힌 객체·타입·교차 검사) 통과/거부 케이스, AISM_ROOT 위치.
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
    expect(example.roles.planner.endpoint).toBe("cloud");
    expect(example.roles.verifier.endpoint).toBe("local");
    expect(example.roles.planner.prompt).toEqual(["roles/_workflow.md", "roles/planner.md"]);
    expect(example.roles.planner.permissionMode).toBe("auto");
    expect(example.roles.verifier.permissionMode).toBe("acceptEdits");
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
    expect(() => loadConfig(p)).toThrow(/parkLimitSec: 없음/);
    expect(() => loadConfig(p)).toThrow(p);
  });

  it("roles.*.endpoint가 endpoints에 없으면 throw", () => {
    const bad = {
      ...example,
      roles: { ...example.roles, planner: { ...example.roles.planner, endpoint: "nope" } },
    };
    expect(() => loadConfig(writeTemp(bad))).toThrow(/roles\.planner\.endpoint: endpoints에 없음 \(nope\)/);
  });

  it("parkLimitSec >= hookTimeoutSec이면 throw", () => {
    const bad = { ...example, parkLimitSec: example.hookTimeoutSec };
    expect(() => loadConfig(writeTemp(bad))).toThrow("parkLimitSec: hookTimeoutSec보다 작아야 함");
  });

  it("최상위 정의되지 않은 키면 throw", () => {
    const bad = { ...example, foo: 1 };
    expect(() => loadConfig(writeTemp(bad))).toThrow(/foo: 정의되지 않은 키/);
  });

  it("roles에 planner·verifier 외 키면 throw", () => {
    const bad = {
      ...example,
      roles: { ...example.roles, coder: { ...example.roles.planner } },
    };
    expect(() => loadConfig(writeTemp(bad))).toThrow(/roles\.coder: 정의되지 않은 키/);
  });

  it("role 객체에 정의되지 않은 키면 throw", () => {
    const bad = {
      ...example,
      roles: { ...example.roles, planner: { ...example.roles.planner, extra: 1 } },
    };
    expect(() => loadConfig(writeTemp(bad))).toThrow(/roles\.planner\.extra: 정의되지 않은 키/);
  });

  it("project 객체에 정의되지 않은 키면 throw", () => {
    const bad = {
      ...example,
      projects: { ...example.projects, EWE: { ...example.projects.EWE, extra: 1 } },
    };
    expect(() => loadConfig(writeTemp(bad))).toThrow(/projects\.EWE\.extra: 정의되지 않은 키/);
  });

  it("roles.planner 누락이면 throw", () => {
    const bad = { ...example, roles: { verifier: example.roles.verifier } };
    expect(() => loadConfig(writeTemp(bad))).toThrow(/roles\.planner: 없음/);
  });

  it("타입 불일치(port)면 throw", () => {
    const bad = { ...example, port: "4400" };
    expect(() => loadConfig(writeTemp(bad))).toThrow(/port: number여야 함/);
  });

  it("permissionMode가 허용 값이 아니면 throw", () => {
    const bad = {
      ...example,
      roles: { ...example.roles, planner: { ...example.roles.planner, permissionMode: "yolo" } },
    };
    expect(() => loadConfig(writeTemp(bad))).toThrow(/roles\.planner\.permissionMode: 허용 값 아님/);
  });

  it("prompt 파일이 없으면 throw", () => {
    const bad = {
      ...example,
      roles: { ...example.roles, planner: { ...example.roles.planner, prompt: ["roles/없음.md"] } },
    };
    expect(() => loadConfig(writeTemp(bad))).toThrow(/roles\.planner\.prompt\[0\]: 파일 없음 roles\/없음\.md/);
  });

  it("문제가 2개 이상이면 메시지에 모두 포함", () => {
    const bad = { ...example, port: "4400", foo: 1 };
    expect(() => loadConfig(writeTemp(bad))).toThrow(/port: number여야 함/);
    expect(() => loadConfig(writeTemp(bad))).toThrow(/foo: 정의되지 않은 키/);
  });

  it("커스텀 엔드포인트 이름·환경변수 이름 통과", () => {
    const ok = {
      ...example,
      endpoints: { myGateway: { MY_CUSTOM_VAR: "x" } },
      roles: {
        ...example.roles,
        planner: { ...example.roles.planner, endpoint: "myGateway" },
        verifier: { ...example.roles.verifier, endpoint: "myGateway" },
      },
    };
    const p = writeTemp(ok);
    expect(loadConfig(p).endpoints.myGateway.MY_CUSTOM_VAR).toBe("x");
  });

  it("커스텀 프로젝트 이름 통과", () => {
    const ok = {
      ...example,
      projects: {
        MyProj: {
          root: "C:/tmp/proj",
          plansDir: ".claude/plans",
          protectedPaths: ["Source/**"],
        },
      },
    };
    expect(loadConfig(writeTemp(ok)).projects.MyProj.root).toBe("C:/tmp/proj");
  });

  it("AISM_ROOT는 aism.config.example.json이 있는 폴더", () => {
    expect(fs.existsSync(path.join(AISM_ROOT, "aism.config.example.json"))).toBe(true);
  });
});

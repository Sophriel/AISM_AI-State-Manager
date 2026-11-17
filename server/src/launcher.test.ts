// T9 완료 조건 — spawn 주입, 생성된 4개 파일 내용(공백 경로 따옴표, cloud 관리 변수 비움, verifier local 변수 설정)과 spawn 인자 검증.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { launchSession, type SpawnFn } from "./launcher.js";
import type { AismConfig } from "./config.js";
import { Store } from "./store.js";

const toSlash = (p: string) => p.replace(/\\/g, "/");
const toWin = (p: string) => p.replace(/\//g, "\\");

let aismRoot: string;
let projectRoot: string; // 공백 포함
let storeDir: string;

beforeEach(() => {
  aismRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aism-launch-root-"));
  projectRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aism-launch-proj-")), "My Project");
  fs.mkdirSync(projectRoot, { recursive: true });
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "aism-launch-store-"));

  fs.mkdirSync(path.join(aismRoot, "roles"), { recursive: true });
  fs.writeFileSync(path.join(aismRoot, "roles", "planner.md"), "PLANNER PROMPT CONTENT");
  fs.writeFileSync(path.join(aismRoot, "roles", "verifier.md"), "VERIFIER PROMPT CONTENT");
  fs.writeFileSync(path.join(projectRoot, "overlay.md"), "OVERLAY CONTENT");
});

afterEach(() => {
  fs.rmSync(aismRoot, { recursive: true, force: true });
  fs.rmSync(path.dirname(projectRoot), { recursive: true, force: true });
  fs.rmSync(storeDir, { recursive: true, force: true });
});

function makeConfig(): AismConfig {
  return {
    port: 4400,
    endpoints: {
      cloud: {},
      local: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8080",
        ANTHROPIC_AUTH_TOKEN: "local",
        ANTHROPIC_MODEL: "Qwen3.8-27B-NVFP4-MTP-LOW",
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
      },
    },
    roles: {
      planner: { endpoint: "cloud", prompt: ["roles/planner.md"], permissionMode: "auto" },
      verifier: { endpoint: "local", prompt: ["roles/verifier.md"] },
      coder: { endpoint: "local", prompt: [] },
    },
    projects: {
      EWE: {
        root: projectRoot,
        plansDir: ".claude/plans",
        protectedPaths: [`${toSlash(projectRoot)}\\Source`],
        roleOverlay: "overlay.md",
      },
    },
    confirmFromVersion: 5,
    maxConsecutiveBlocks: 3,
    parkLimitSec: 3300,
    hookTimeoutSec: 3600,
  };
}

const NOW = new Date(2026, 10, 11, 23, 30, 45); // 2026-11-11 23:30:45

describe("launchSession", () => {
  it("PLANNER(cloud) — 4개 파일 내용 + spawn 인자", () => {
    const config = makeConfig();
    let spawnCall: { cmd: string; args: string[]; opts: { detached: boolean; stdio: "ignore" } } | null = null;
    const spawn: SpawnFn = (cmd, args, opts) => (spawnCall = { cmd, args, opts });

    const { sessionKey, dir } = launchSession({
      config,
      project: "EWE",
      role: "planner",
      folder: "261111-alpha",
      aismRoot,
      spawn,
      now: NOW,
      hex: "a1b2",
    });

    expect(sessionKey).toBe("planner-20261111-233045-a1b2");
    expect(dir).toBe(path.join(aismRoot, "state", "sessions", sessionKey));

    // prompt.md — 역할 프롬프트 + overlay + 헤더.
    const prompt = fs.readFileSync(path.join(dir, "prompt.md"), "utf8");
    expect(prompt).toContain("PLANNER PROMPT CONTENT");
    expect(prompt).toContain("OVERLAY CONTENT");
    expect(prompt).toContain("## AISM context");
    expect(prompt).toContain(`Project root: ${toSlash(projectRoot)}`);
    expect(prompt).toContain(`Plans root: ${toSlash(path.join(projectRoot, ".claude/plans"))}`);
    expect(prompt).toContain("Task folder: 261111-alpha");

    // settings.json — Stop 훅만(경로 /), permissions 없음 (T5: 권한 모드는 args --permission-mode).
    const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    expect("permissions" in settings).toBe(false);
    expect(settings.hooks.Stop[0].hooks[0]).toEqual({
      type: "command",
      command: "node",
      args: [`${toSlash(aismRoot)}/hooks/stop.js`],
      timeout: 3600,
    });

    // env.bat — CRLF, cloud는 관리 변수만 비움 (엔드포인트 변수 없음).
    const envBat = fs.readFileSync(path.join(dir, "env.bat"), "utf8");
    expect(envBat).toContain("\r\n");
    expect(envBat).toContain('set "ANTHROPIC_BASE_URL="');
    expect(envBat).toContain('set "CLAUDE_CODE_AUTO_COMPACT_WINDOW="');
    expect(envBat).not.toContain("http://127.0.0.1:8080"); // cloud — local 변수 없음
    expect(envBat).toContain("set \"AISM_PORT=4400\"");
    expect(envBat).toContain(`set "AISM_SESSION_KEY=${sessionKey}"`);
    expect(envBat).toContain(`cd /d "${projectRoot}"`); // 공백 경로 따옴표

    // args.txt — 한 줄, 백슬래시 경로, permission-mode, disallowedTools(Edit만), name, 초기 프롬프트.
    const argsTxt = fs.readFileSync(path.join(dir, "args.txt"), "utf8");
    expect(argsTxt.trimEnd()).toBe(
      `--append-system-prompt-file "${toWin(path.join(dir, "prompt.md"))}" ` +
        `--settings "${toWin(path.join(dir, "settings.json"))}" ` +
        `--permission-mode auto ` +
        `--disallowedTools "Edit(${config.projects.EWE.protectedPaths[0]})" ` +
        `--name "AISM PLANNER 261111-alpha" "AISM task: 261111-alpha"`,
    );
    expect(argsTxt).not.toContain("Write(");

    // spawn 인자.
    expect(spawnCall?.cmd).toBe("wt.exe");
    expect(spawnCall?.args).toEqual([
      "-w",
      "new",
      "--title",
      "AISM · 261111-alpha · PLANNER",
      "cmd",
      "/k",
      path.join(aismRoot, "scripts", "launch_session.bat"),
      dir,
    ]);
    expect(spawnCall?.opts).toEqual({ detached: true, stdio: "ignore" });
  });

  it("VERIFIER(local) — env.bat에 local 변수 설정", () => {
    const config = makeConfig();
    const { dir } = launchSession({
      config,
      project: "EWE",
      role: "verifier",
      folder: "261111-alpha",
      aismRoot,
      spawn: () => {},
      now: NOW,
      hex: "c3d4",
    });

    const envBat = fs.readFileSync(path.join(dir, "env.bat"), "utf8");
    // 관리 변수 비움 후 local 엔드포인트 변수 설정.
    expect(envBat).toContain('set "ANTHROPIC_BASE_URL="');
    expect(envBat).toContain('set "ANTHROPIC_BASE_URL=http://127.0.0.1:8080"');
    expect(envBat).toContain('set "ANTHROPIC_AUTH_TOKEN=local"');
    expect(envBat).toContain('set "ANTHROPIC_MODEL=Qwen3.8-27B-NVFP4-MTP-LOW"');
    expect(envBat).toContain('set "CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000"');
    // prompt.md는 verifier 역할 프롬프트.
    const prompt = fs.readFileSync(path.join(dir, "prompt.md"), "utf8");
    expect(prompt).toContain("VERIFIER PROMPT CONTENT");
    // args.txt — permissionMode 생략 → acceptEdits (T5).
    const argsTxt = fs.readFileSync(path.join(dir, "args.txt"), "utf8");
    expect(argsTxt).toContain("--permission-mode acceptEdits");
  });

  it("새 작업(folder null) — 초기 프롬프트 없음, 헤더 '(new task — wait for the user)'", () => {
    const config = makeConfig();
    const { dir } = launchSession({
      config,
      project: "EWE",
      role: "planner",
      folder: null,
      aismRoot,
      spawn: () => {},
      now: NOW,
      hex: "e5f6",
    });

    const prompt = fs.readFileSync(path.join(dir, "prompt.md"), "utf8");
    expect(prompt).toContain("Task folder: (new task — wait for the user)");

    const argsTxt = fs.readFileSync(path.join(dir, "args.txt"), "utf8");
    expect(argsTxt).toContain('--name "AISM PLANNER new"');
    expect(argsTxt).not.toContain("AISM task:");
  });

  it("Store에 세션 등록", () => {
    const config = makeConfig();
    const store = new Store(storeDir);
    const { sessionKey } = launchSession({
      config,
      project: "EWE",
      role: "verifier",
      folder: "261111-alpha",
      aismRoot,
      spawn: () => {},
      now: NOW,
      hex: "a9b8",
      store,
    });

    const info = store.state.sessions[sessionKey];
    expect(info).toEqual({
      role: "verifier",
      project: "EWE",
      folder: "261111-alpha",
      launchedAt: NOW.getTime(),
      sessionIds: [],
      activeSessionId: null,
      switchedOnce: false,
    });
  });

  it("CODER — args에 --disallowedTools 없음, --name AISM CODER <folder>, 첫 프롬프트 AISM task", () => {
    const config = makeConfig();
    const { dir } = launchSession({
      config,
      project: "EWE",
      role: "coder",
      folder: "261111-alpha",
      aismRoot,
      spawn: () => {},
      now: NOW,
      hex: "1122",
    });

    const argsTxt = fs.readFileSync(path.join(dir, "args.txt"), "utf8");
    expect(argsTxt).not.toContain("--disallowedTools");
    expect(argsTxt).toContain('--name "AISM CODER 261111-alpha"');
    expect(argsTxt).toContain('"AISM task: 261111-alpha"');
  });

  it("resume — args 끝이 --resume abc-123 \"AISM resume: 261111-alpha\"", () => {
    const config = makeConfig();
    const { dir } = launchSession({
      config,
      project: "EWE",
      role: "planner",
      folder: "261111-alpha",
      aismRoot,
      spawn: () => {},
      now: NOW,
      hex: "3344",
      resumeSessionId: "abc-123",
    });

    const argsTxt = fs.readFileSync(path.join(dir, "args.txt"), "utf8");
    expect(argsTxt.trimEnd().endsWith(`--resume abc-123 "AISM resume: 261111-alpha"`)).toBe(true);
  });

  it("firstInstruction — prompt.md 헤더 마지막 줄 'First instruction: …', 없으면 그 줄 없음 (M2 polish §3 B)", () => {
    const config = makeConfig();
    const { dir } = launchSession({
      config,
      project: "EWE",
      role: "planner",
      folder: "261111-alpha",
      aismRoot,
      spawn: () => {},
      now: NOW,
      hex: "5566",
      firstInstruction: "plan-v1.md를 검토해.",
    });

    const prompt = fs.readFileSync(path.join(dir, "prompt.md"), "utf8");
    const lines = prompt.split("\n").filter((l) => l.trim() !== "");
    expect(lines[lines.length - 1]).toBe("First instruction: plan-v1.md를 검토해.");

    const { dir: dir2 } = launchSession({
      config,
      project: "EWE",
      role: "planner",
      folder: "261111-alpha",
      aismRoot,
      spawn: () => {},
      now: NOW,
      hex: "7788",
    });
    const prompt2 = fs.readFileSync(path.join(dir2, "prompt.md"), "utf8");
    expect(prompt2).not.toContain("First instruction:");
  });
});

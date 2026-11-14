// T9 — 세션 실행기. state/sessions/<sessionKey>/ 에 prompt.md·settings.json·env.bat·args.txt 생성,
// wt.exe로 새 Windows Terminal 창 띄움. F-4/F-5 교훈 적용: 명시적 헤더, acceptEdits로 전역 plan mode 덮어쓰기.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn as childSpawn } from "node:child_process";
import type { AismConfig } from "./config.js";
import { MANAGED_ENV } from "./config.js";
import type { Store } from "./store.js";
import type { Role } from "./machine.js";

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { detached: boolean; stdio: "ignore" },
) => void;

export interface LaunchOptions {
  config: AismConfig;
  project: string;
  role: Role;
  folder: string | null;
  aismRoot: string;
  store?: Store;
  spawn?: SpawnFn;
  now?: Date;
  hex?: string; // 4자리 hex, 기본 랜덤
}

const toSlash = (p: string): string => p.replace(/\\/g, "/");
const toWin = (p: string): string => p.replace(/\//g, "\\");

function makeSessionKey(role: Role, now: Date, hex: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${role}-${ts}-${hex}`;
}

export function launchSession(opts: LaunchOptions): { sessionKey: string; dir: string } {
  const { config, project, role, folder, aismRoot } = opts;
  const now = opts.now ?? new Date();
  const hex = opts.hex ?? crypto.randomBytes(2).toString("hex");

  const projectCfg = config.projects[project];
  if (!projectCfg) throw new Error(`unknown project: ${project}`);
  const roleCfg = config.roles[role];
  const endpoint = config.endpoints[roleCfg.endpoint] ?? {};

  const sessionKey = makeSessionKey(role, now, hex);
  const dir = path.join(aismRoot, "state", "sessions", sessionKey);
  fs.mkdirSync(dir, { recursive: true });

  // prompt.md = 역할 프롬프트 파일들(설정 순서, aismRoot 기준 경로) + (있으면) roleOverlay + 생성 헤더.
  const promptParts: string[] = [];
  for (const name of roleCfg.prompt) {
    const p = path.join(aismRoot, name);
    promptParts.push(fs.readFileSync(p, "utf8").trim());
  }
  if (projectCfg.roleOverlay) {
    const overlayPath = path.join(projectCfg.root, projectCfg.roleOverlay);
    if (fs.existsSync(overlayPath)) {
      promptParts.push(fs.readFileSync(overlayPath, "utf8").trim());
    }
  }
  const header = [
    "## AISM context",
    `Project root: ${toSlash(projectCfg.root)}`,
    `Plans root: ${toSlash(path.join(projectCfg.root, projectCfg.plansDir))}`,
    `Task folder: ${folder ?? "(new task — wait for the user)"}`,
  ].join("\n");
  promptParts.push(header);
  fs.writeFileSync(path.join(dir, "prompt.md"), promptParts.join("\n\n") + "\n");

  // settings.json — Stop 훅만 (권한 모드는 args의 --permission-mode로 전달, T5). 경로는 /로.
  const settings = {
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: "node",
              args: [`${toSlash(aismRoot)}/hooks/stop.js`],
              timeout: config.hookTimeoutSec,
            },
          ],
        },
      ],
    },
  };
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings, null, 2) + "\n");

  // env.bat (CRLF) — 관리 변수 비움 → 역할 엔드포인트 묶음 → AISM_PORT·AISM_SESSION_KEY → cd /d.
  const envLines = ["@echo off"];
  for (const v of MANAGED_ENV) envLines.push(`set "${v}="`);
  for (const [k, val] of Object.entries(endpoint)) envLines.push(`set "${k}=${val}"`);
  envLines.push(`set "AISM_PORT=${config.port}"`);
  envLines.push(`set "AISM_SESSION_KEY=${sessionKey}"`);
  envLines.push(`cd /d "${projectCfg.root}"`);
  fs.writeFileSync(path.join(dir, "env.bat"), envLines.join("\r\n") + "\r\n");

  // args.txt (한 줄, ASCII) — prompt·settings·permission-mode·protectedPaths·name·(folder 있으면) 초기 프롬프트.
  const argsParts: string[] = [];
  argsParts.push(`--append-system-prompt-file "${toWin(path.join(dir, "prompt.md"))}"`);
  argsParts.push(`--settings "${toWin(path.join(dir, "settings.json"))}"`);
  argsParts.push(`--permission-mode ${roleCfg.permissionMode ?? "acceptEdits"}`);
  for (const p of projectCfg.protectedPaths) {
    argsParts.push(`--disallowedTools "Edit(${p})"`);
  }
  argsParts.push(`--name "AISM ${role.toUpperCase()} ${folder ?? "new"}"`);
  if (folder) argsParts.push(`"AISM task: ${folder}"`);
  fs.writeFileSync(path.join(dir, "args.txt"), argsParts.join(" ") + "\n");

  // 실행 — wt.exe -w new --title "AISM · <folder|new> · <ROLE>" cmd /k <bat> <dir>.
  const title = `AISM · ${folder ?? "new"} · ${role.toUpperCase()}`;
  const batPath = path.join(aismRoot, "scripts", "launch_session.bat");
  const wtArgs = ["-w", "new", "--title", title, "cmd", "/k", batPath, dir];
  const spawnOpts = { detached: true, stdio: "ignore" as const };
  if (opts.spawn) opts.spawn("wt.exe", wtArgs, spawnOpts);
  else childSpawn("wt.exe", wtArgs, spawnOpts).unref();

  // Store에 세션 등록.
  if (opts.store) {
    opts.store.state.sessions[sessionKey] = {
      role,
      project,
      folder,
      launchedAt: now.getTime(),
      sessionIds: [],
      activeSessionId: null,
      switchedOnce: false,
    };
    opts.store.save();
  }

  return { sessionKey, dir };
}

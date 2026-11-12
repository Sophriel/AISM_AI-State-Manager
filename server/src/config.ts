// T3 — 설정 타입과 로더 (plan-v3 §3.2).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface RoleConfig {
  endpoint: string;
  prompt: string[];
}

export interface ProjectConfig {
  root: string;
  plansDir: string;
  protectedPaths: string[];
  roleOverlay?: string;
}

export interface AismConfig {
  port: number;
  endpoints: Record<string, Record<string, string>>;
  roles: { plan: RoleConfig; verify: RoleConfig };
  projects: Record<string, ProjectConfig>;
  confirmFromVersion: number;
  maxConsecutiveBlocks: number;
  parkLimitSec: number;
  hookTimeoutSec: number;
}

// 런처가 세션 시작 전에 항상 먼저 비운 뒤 역할 엔드포인트 묶음으로 덮어쓰는 변수 (R1-9).
export const MANAGED_ENV = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
];

// 레포 루트 — server/src/config.ts(tsx)와 server/dist/config.js(빌드) 모두 두 단계 위가 루트.
// cwd는 사용하지 않음 (npm workspaces는 cwd를 server/로 바꿈).
export const AISM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// 설정 파일 경로 — AISM_CONFIG 환경변수 우선, 없으면 레포 루트 aism.config.json.
export function configFilePath(): string {
  return process.env.AISM_CONFIG ?? path.join(AISM_ROOT, "aism.config.json");
}

const REQUIRED_KEYS: (keyof AismConfig)[] = [
  "port",
  "endpoints",
  "roles",
  "projects",
  "confirmFromVersion",
  "maxConsecutiveBlocks",
  "parkLimitSec",
  "hookTimeoutSec",
];

export function loadConfig(configPath: string): AismConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (e) {
    throw new Error(`설정 파일 읽기 실패: ${configPath} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`설정 JSON 파싱 실패: ${configPath} (${(e as Error).message})`);
  }

  const cfg = data as AismConfig;

  for (const key of REQUIRED_KEYS) {
    if (!(key in cfg)) {
      throw new Error(`설정 필수 키 누락: ${String(key)} (${configPath})`);
    }
  }

  if (!cfg.roles || !cfg.roles.plan || !cfg.roles.verify) {
    throw new Error(`설정 roles에 plan·verify가 모두 필요함 (${configPath})`);
  }

  for (const role of ["plan", "verify"] as const) {
    const ep = cfg.roles[role].endpoint;
    if (!ep || !(ep in cfg.endpoints)) {
      throw new Error(`roles.${role}.endpoint "${ep ?? ""}"이 endpoints에 없음 (${configPath})`);
    }
  }

  if (cfg.parkLimitSec >= cfg.hookTimeoutSec) {
    throw new Error(
      `parkLimitSec(${cfg.parkLimitSec}) < hookTimeoutSec(${cfg.hookTimeoutSec})이어야 함 (${configPath})`
    );
  }

  return cfg;
}

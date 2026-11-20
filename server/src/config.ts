// T3 — 설정 타입과 로더 (plan-v3 §3.2).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PERMISSION_MODES = ["default", "acceptEdits", "auto", "plan", "bypassPermissions"] as const;

export interface RoleConfig {
  endpoint: string;
  prompt: string[];
  permissionMode?: (typeof PERMISSION_MODES)[number];
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
  roles: { planner: RoleConfig; verifier: RoleConfig; coder: RoleConfig };
  projects: Record<string, ProjectConfig>;
  confirmFromVersion: number;
  maxConsecutiveBlocks: number;
  parkLimitSec: number;
  hookTimeoutSec: number;
  toast?: boolean;
  window?: { width: number; height: number };
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

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

const TOP_KEYS = [
  "port",
  "endpoints",
  "roles",
  "projects",
  "confirmFromVersion",
  "maxConsecutiveBlocks",
  "parkLimitSec",
  "hookTimeoutSec",
] as const;

const OPTIONAL_TOP_KEYS = ["toast", "window"] as const;

const NUM_KEYS = ["port", "confirmFromVersion", "maxConsecutiveBlocks", "parkLimitSec", "hookTimeoutSec"] as const;
const ROLE_NAMES = ["planner", "verifier", "coder"] as const;
const PROJECT_KEYS = ["root", "plansDir", "protectedPaths", "roleOverlay"] as const;
const ROLE_CFG_KEYS = ["endpoint", "prompt", "permissionMode"] as const;

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

  const problems: string[] = [];
  if (!isObj(data)) {
    problems.push("최상위: 객체여야 함");
  } else {
    // 닫힌 객체 — 최상위 (선택 키 포함).
    for (const k of Object.keys(data)) {
      if (!([...TOP_KEYS, ...OPTIONAL_TOP_KEYS] as readonly string[]).includes(k))
        problems.push(`${k}: 정의되지 않은 키`);
    }
    for (const k of TOP_KEYS) {
      if (!(k in data)) problems.push(`${k}: 없음`);
    }
    // 타입 — 최상위 숫자 필드.
    for (const k of NUM_KEYS) {
      if (k in data && typeof data[k] !== "number") problems.push(`${k}: number여야 함`);
    }
    if ("toast" in data && typeof data.toast !== "boolean") problems.push("toast: boolean이어야 함");

    // window — 닫힌 객체, width·height는 양의 정수 (M2 polish §3 E).
    if ("window" in data) {
      const w = data.window;
      if (!isObj(w)) {
        problems.push("window: 객체여야 함");
      } else {
        for (const k of Object.keys(w)) {
          if (k !== "width" && k !== "height") problems.push(`window.${k}: 정의되지 않은 키`);
        }
        for (const k of ["width", "height"] as const) {
          if (!(k in w)) problems.push(`window.${k}: 없음`);
          else if (!Number.isInteger(w[k]) || (w[k] as number) <= 0) problems.push(`window.${k}: 양의 정수여야 함`);
        }
      }
    }

    // endpoints — 객체, 각 값은 객체, 그 안의 각 값은 string.
    const endpoints = data.endpoints;
    if ("endpoints" in data) {
      if (!isObj(endpoints)) {
        problems.push("endpoints: 객체여야 함");
      } else {
        for (const [epName, vars] of Object.entries(endpoints)) {
          if (!isObj(vars)) {
            problems.push(`endpoints.${epName}: 객체여야 함`);
          } else {
            for (const [varName, val] of Object.entries(vars)) {
              if (typeof val !== "string") problems.push(`endpoints.${epName}.${varName}: string이어야 함`);
            }
          }
        }
      }
    }

    // projects — 객체, 각 값은 프로젝트 객체.
    const projects = data.projects;
    if ("projects" in data) {
      if (!isObj(projects)) {
        problems.push("projects: 객체여야 함");
      } else {
        for (const [projName, proj] of Object.entries(projects)) {
          const p = `projects.${projName}`;
          if (!isObj(proj)) {
            problems.push(`${p}: 객체여야 함`);
            continue;
          }
          for (const k of Object.keys(proj)) {
            if (!(PROJECT_KEYS as readonly string[]).includes(k)) problems.push(`${p}.${k}: 정의되지 않은 키`);
          }
          for (const k of ["root", "plansDir", "protectedPaths"]) {
            if (!(k in proj)) problems.push(`${p}.${k}: 없음`);
          }
          if ("root" in proj && typeof proj.root !== "string") problems.push(`${p}.root: string이어야 함`);
          if ("plansDir" in proj && typeof proj.plansDir !== "string") problems.push(`${p}.plansDir: string이어야 함`);
          if ("roleOverlay" in proj && typeof proj.roleOverlay !== "string")
            problems.push(`${p}.roleOverlay: string이어야 함`);
          if ("protectedPaths" in proj && !isStrArr(proj.protectedPaths))
            problems.push(`${p}.protectedPaths: string 배열이어야 함`);
        }
      }
    }

    // roles — 객체, planner·verifier·coder.
    const roles = data.roles;
    if ("roles" in data) {
      if (!isObj(roles)) {
        problems.push("roles: 객체여야 함");
      } else {
        for (const k of Object.keys(roles)) {
          if (!(ROLE_NAMES as readonly string[]).includes(k)) problems.push(`roles.${k}: 정의되지 않은 키`);
        }
        for (const role of ROLE_NAMES) {
          const rc = roles[role];
          const p = `roles.${role}`;
          if (!(role in roles)) {
            problems.push(`${p}: 없음`);
            continue;
          }
          if (!isObj(rc)) {
            problems.push(`${p}: 객체여야 함`);
            continue;
          }
          for (const k of Object.keys(rc)) {
            if (!(ROLE_CFG_KEYS as readonly string[]).includes(k)) problems.push(`${p}.${k}: 정의되지 않은 키`);
          }
          if (!("endpoint" in rc)) problems.push(`${p}.endpoint: 없음`);
          if (!("prompt" in rc)) problems.push(`${p}.prompt: 없음`);
          if ("endpoint" in rc && typeof rc.endpoint !== "string") problems.push(`${p}.endpoint: string이어야 함`);
          if ("prompt" in rc && !isStrArr(rc.prompt)) problems.push(`${p}.prompt: string 배열이어야 함`);
          if (
            "permissionMode" in rc &&
            !(PERMISSION_MODES as readonly string[]).includes(rc.permissionMode as string)
          ) {
            problems.push(`${p}.permissionMode: 허용 값 아님 (${PERMISSION_MODES.join(", ")})`);
          }
          // 교차 검사 — 타입이 맞을 때만 (같은 원인의 중복 메시지를 피한다).
          if (typeof rc.endpoint === "string" && isObj(endpoints) && !(rc.endpoint in endpoints)) {
            problems.push(`${p}.endpoint: endpoints에 없음 (${rc.endpoint})`);
          }
          if (isStrArr(rc.prompt)) {
            rc.prompt.forEach((f, i) => {
              if (!fs.existsSync(path.join(AISM_ROOT, f))) problems.push(`${p}.prompt[${i}]: 파일 없음 ${f}`);
            });
          }
        }
      }
    }

    // parkLimitSec < hookTimeoutSec.
    const park = data.parkLimitSec;
    const hook = data.hookTimeoutSec;
    if (typeof park === "number" && typeof hook === "number") {
      if (park >= hook) problems.push("parkLimitSec: hookTimeoutSec보다 작아야 함");
    }
  }

  if (problems.length > 0) {
    throw new Error(
      [
        `설정 파일이 현재 형식과 다릅니다: ${configPath}`,
        ...problems.map((p) => "  - " + p),
        "aism.config.example.json을 참고하세요.",
      ].join("\n"),
    );
  }

  return data as AismConfig;
}

// 설정 파일 갱신 (M3 §3 D) — 읽기 → mutate → 2칸 들여쓰기·원본 줄바꿈으로 임시 파일 → (validate면) loadConfig로 검증 → rename.
// 실패하면 임시 파일을 지우고 false. 원본은 그대로.
export function updateConfigFile(
  configPath: string,
  mutate: (data: Record<string, unknown>) => void,
  opts: { validate?: boolean } = {},
): boolean {
  const tmp = `${configPath}.tmp`;
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    mutate(data);
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const out = JSON.stringify(data, null, 2).replace(/\n/g, eol) + eol;
    fs.writeFileSync(tmp, out);
    if (opts.validate !== false) loadConfig(tmp);
    fs.renameSync(tmp, configPath);
    return true;
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    console.warn(`설정 파일 저장 실패 — ${String(e)}`);
    return false;
  }
}

// 창 크기 자동 저장 (M2 polish §3 E) — 동작은 이전과 같다(검증 없이 window만 교체).
export function saveWindowSize(configPath: string, win: { width: number; height: number }): boolean {
  return updateConfigFile(configPath, (d) => {
    d.window = { width: win.width, height: win.height };
  }, { validate: false });
}

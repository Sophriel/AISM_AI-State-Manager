// 프로젝트 git 정보 (M3 §3 D) — 로컬 레포의 현재 브랜치만. clone·원격은 다루지 않는다.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface GitInfo {
  branch: string | null;
}

// root/.git(폴더 또는 파일)이 없으면 null. 있으면 현재 브랜치(실패하면 branch null).
export function gitInfo(root: string): GitInfo | null {
  if (!fs.existsSync(path.join(root, ".git"))) return null;
  try {
    const out = execFileSync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const b = out.trim();
    return { branch: b === "" ? null : b };
  } catch {
    return { branch: null };
  }
}

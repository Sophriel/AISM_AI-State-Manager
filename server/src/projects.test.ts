// M3 §3 D — gitInfo: .git 없음 null, 임시 git 레포 브랜치 이름 (git 없으면 skip).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { gitInfo } from "./projects.js";

const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
})();

describe("gitInfo", () => {
  it(".git 없음 → null", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aism-git-"));
    expect(gitInfo(dir)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!gitAvailable)("임시 git 레포 → { branch: 'main' }", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aism-git-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"],
      { cwd: dir, stdio: "ignore" },
    );
    expect(gitInfo(dir)).toEqual({ branch: "main" });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

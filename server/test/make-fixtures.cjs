// T4 픽스처 생성 스크립트 — node make-fixtures.cjs (server/test/에서 실행).
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "fixtures");
function w(rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// 1. plan 없음
w("no-plan/.gitkeep", "");
// 2. v1만
w("v1-only/plan-v1.md", "Status: DRAFT\n\n# Plan v1\n");
// 3. v2 + v1-verify REVISE (verify는 이전 버전용 — 최신 v2에는 없음)
w("v2-v1-verify-revise/plan-v1.md", "Status: APPROVED\n");
w("v2-v1-verify-revise/plan-v2.md", "Status: IN_REVIEW\n");
w("v2-v1-verify-revise/plan-v1-verify.md", "# verify v1\n\n판정: REVISE\n");
// 4. v3 + v3-verify PASS
w("v3-v3-verify-pass/plan-v1.md", "Status: DRAFT\n");
w("v3-v3-verify-pass/plan-v2.md", "Status: IN_REVIEW\n");
w("v3-v3-verify-pass/plan-v3.md", "Status: APPROVED\n");
w("v3-v3-verify-pass/plan-v3-verify.md", "# verify v3\n\n판정: PASS\n");
// 5. CRLF 파일 (판정 줄 뒤 빈 줄 포함)
w("crlf/plan-v1.md", "Status: IN_PROGRESS\r\nbody\r\n");
w("crlf/plan-v1-verify.md", "content\r\n판정: REVISE\r\n");
// 6. Status 없음 (첫 줄이 Status 아님)
w("no-status/plan-v1.md", "# Plan v1\nStatus: DRAFT\n");
// 7. 판정 줄 오타
w("verdict-typo/plan-v1.md", "Status: IN_PROGRESS\n");
w("verdict-typo/plan-v1-verify.md", "판정: PAss\n");
// 8. 버전 건너뜀 (v2, v4)
w("version-skip/plan-v2.md", "Status: DRAFT\n");
w("version-skip/plan-v4.md", "Status: TODO_READY\n");

console.log("fixtures created under", root);

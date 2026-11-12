// scripts/launch_session.bat 생성 (T1 검증 내용, CRLF). 일회성 스크립트.
const fs = require("node:fs");
const path = require("node:path");
const p = path.join(__dirname, "launch_session.bat");
const lines = [
  "chcp 65001",
  'call "%~1\\env.bat"',
  'set /p ARGS=<"%~1\\args.txt"',
  "claude %ARGS%",
];
fs.writeFileSync(p, lines.join("\r\n") + "\r\n");
console.log("wrote", p, fs.statSync(p).size, "bytes");
console.log(JSON.stringify(fs.readFileSync(p, "utf8")));

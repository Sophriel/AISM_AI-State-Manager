// scripts/start_server.bat·open_ui.bat 생성 (CRLF). 일회성 스크립트 — 재생성에 사용.
const fs = require("node:fs");
const path = require("node:path");

function writeBat(name, lines) {
  const p = path.join(__dirname, name);
  fs.writeFileSync(p, lines.join("\r\n") + "\r\n");
  console.log("wrote", p, fs.statSync(p).size, "bytes");
}

writeBat("start_server.bat", [
  "@echo off",
  "chcp 65001 >nul",
  'cd /d "%~dp0.."',
  'start "AISM Server" cmd /k npm start',
]);

writeBat("open_ui.bat", [
  "@echo off",
  "chcp 65001 >nul",
  'cd /d "%~dp0.."',
  "node server\\dist\\open-ui-main.js",
  "if errorlevel 1 pause",
]);

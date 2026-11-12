// scripts/start_aism.bat 생성 (CRLF). 일회성 스크립트 — 재생성에 사용.
const fs = require("node:fs");
const path = require("node:path");
const p = path.join(__dirname, "start_aism.bat");
const lines = [
  "@echo off",
  "chcp 65001",
  'cd /d "%~dp0.."',
  'start "AISM Server" cmd /k npm start',
  "timeout /t 2",
  "start msedge --app=http://127.0.0.1:4400",
];
fs.writeFileSync(p, lines.join("\r\n") + "\r\n");
console.log("wrote", p, fs.statSync(p).size, "bytes");
console.log(JSON.stringify(fs.readFileSync(p, "utf8")));

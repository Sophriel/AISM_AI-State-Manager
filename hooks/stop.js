// T10 — Stop 훅 본체. stdin JSON + AISM_SESSION_KEY를 127.0.0.1:<AISM_PORT>/hook/stop에 POST하고
// 응답(long-poll)을 기다린다. {action:"block",reason}이면 {"decision":"block",reason} 출력, 그 외 exit 0.
// 연결 실패 시 1초 간격 3회 재시도 후 exit 0. AISM_SESSION_KEY 없으면 즉시 exit 0.
// 의존성 없음 — Node 내장 http만 사용.
import http from "node:http";

const sessionKey = process.env.AISM_SESSION_KEY;
if (!sessionKey) process.exit(0);

const port = Number(process.env.AISM_PORT ?? 4400);

let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(stdin || "{}");
  } catch {
    payload = { raw: stdin };
  }
  post(payload, 0);
});

function post(payload, attempt) {
  const body = JSON.stringify({ sessionKey, payload });
  const req = http.request(
    {
      host: "127.0.0.1",
      port,
      path: "/hook/stop",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        try {
          const r = JSON.parse(data || "{}");
          if (r.action === "block") {
            console.log(JSON.stringify({ decision: "block", reason: r.reason }));
          }
        } catch {
          // 응답 파싱 실패 — 멈춤 허용.
        }
        process.exit(0);
      });
    },
  );
  req.on("error", () => {
    if (attempt < 3) {
      setTimeout(() => post(payload, attempt + 1), 1000);
    } else {
      process.exit(0);
    }
  });
  req.write(body);
  req.end();
}

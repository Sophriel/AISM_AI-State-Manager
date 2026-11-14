// T12 — HTTP 서버. loadConfig → Store.load() → 저장된 세션 detached 초기화 → listen.
// 라우트: /hook/stop(long-poll), /api/state, /api/events(SSE), /api/tasks/{new,relaunch,close}, 정적 서빙.
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { loadConfig, configFilePath } from "./config.js";
import { Store } from "./store.js";
import { Sessions } from "./sessions.js";
import { Orchestrator } from "./orchestrator.js";
import type { SseClient } from "./notify.js";
import type { Reply } from "./machine.js";

const here = path.dirname(fileURLToPath(import.meta.url)); // server/src (dev) 또는 server/dist (prod)
const publicDir = path.join(here, "..", "public");

async function main(): Promise<void> {
  const config = loadConfig(configFilePath());
  const store = new Store();
  store.load();
  const sessions = new Sessions(store, config.parkLimitSec);
  // 저장된 세션은 모두 detached로 초기화 (서버 재시작 — plan-v3 §4).
  for (const key of Object.keys(store.state.sessions)) {
    sessions.register(key, "detached");
  }
  const orchestrator = new Orchestrator({ config, store, sessions });
  const hub = orchestrator.getHub();

  const app = Fastify();

  app.get("/api/health", async () => ({ ok: true }));

  // POST /hook/stop — long-poll. hold면 응답 보류(연결 유지), allow/block이면 즉시 응답.
  app.post("/hook/stop", (request, reply) => {
    const body = (request.body ?? {}) as {
      sessionKey?: string;
      payload?: { session_id?: string; last_assistant_message?: string };
    };
    if (!body.sessionKey) {
      reply.code(400).send({ error: "missing sessionKey" });
      return;
    }
    const sendReply = (r: Reply) => {
      if (!reply.raw.headersSent) reply.send(r);
    };
    // F-1: 클라이언트 이탈 감지는 request가 아닌 socket의 close.
    const onClose = (cb: () => void) => {
      request.raw.socket.on("close", cb);
    };
    orchestrator.handleStop(body.sessionKey, body.payload ?? {}, sendReply, onClose);
  });

  app.get("/api/state", async () => orchestrator.getState());

  // GET /api/events — SSE. 이벤트: state(전체 상태), notify.
  app.get("/api/events", (request, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    raw.write("retry: 3000\n\n");
    const client: SseClient = {
      write: (s) => {
        if (!raw.destroyed) raw.write(s);
      },
      close: () => raw.end(),
    };
    hub.add(client);
    request.raw.on("close", () => hub.remove(client));
  });

  app.post("/api/tasks/new", async (request, reply) => {
    const { project } = (request.body ?? {}) as { project?: string };
    if (!project) return reply.code(400).send({ error: "missing project" });
    const result = orchestrator.newTask(project);
    return reply.code(result.status).send(result.ok ? { ok: true } : { error: result.error });
  });

  app.post("/api/tasks/relaunch", async (request, reply) => {
    const { role } = (request.body ?? {}) as { role?: "planner" | "verifier" };
    if (role !== "planner" && role !== "verifier") return reply.code(400).send({ error: "invalid role" });
    const result = orchestrator.relaunch(role);
    return reply.code(result.status).send(result.ok ? { ok: true } : { error: result.error });
  });

  app.post("/api/tasks/close", async () => {
    orchestrator.closeTask();
    return { ok: true };
  });

  // 정적 서빙 (server/public — 웹 UI 빌드 산출물). API·훅 라우트 이후 등록.
  await app.register(fastifyStatic, { root: publicDir });

  await app.listen({ port: config.port, host: "127.0.0.1" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// T12 — HTTP 서버. loadConfig → Store.load() → 저장된 세션 detached 초기화 → listen.
// 라우트: /hook/stop(long-poll), /api/state, /api/events(SSE), /api/tasks/{new,relaunch,close}, /api/timeline/clear, /api/projects{,/remove}, /api/ui/window, 정적 서빙.
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { loadConfig, configFilePath } from "./config.js";
import { handleWindowSize } from "./ui.js";
import { Store } from "./store.js";
import { Sessions } from "./sessions.js";
import { Orchestrator } from "./orchestrator.js";
import type { SseClient } from "./notify.js";
import type { Reply } from "./machine.js";

const here = path.dirname(fileURLToPath(import.meta.url)); // server/src (dev) 또는 server/dist (prod)
const publicDir = path.join(here, "..", "public");

async function main(): Promise<void> {
  const cfgPath = configFilePath();
  const config = loadConfig(cfgPath);
  const store = new Store();
  store.load();
  const sessions = new Sessions(store, config.parkLimitSec);
  // 저장된 세션은 모두 detached로 초기화 (서버 재시작 — plan-v3 §4).
  for (const key of Object.keys(store.state.sessions)) {
    sessions.register(key, "detached");
  }
  const orchestrator = new Orchestrator({ config, store, sessions, configPath: cfgPath });
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

  app.get("/api/state", async (request) =>
    orchestrator.getState(((request.query as { task?: string }) ?? {}).task ?? null),
  );

  // GET /api/events — SSE. query.task 있으면 그 작업 채널, 없으면 lobby(시작 화면). 이벤트: state, notify.
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
    const task = ((request.query as { task?: string }) ?? {}).task ?? null;
    hub.add(client, task);
    orchestrator.notifyAttachChange();
    request.raw.on("close", () => {
      hub.remove(client);
      orchestrator.notifyAttachChange();
    });
  });

  app.post("/api/tasks/new", async (request, reply) => {
    const { project } = (request.body ?? {}) as { project?: string };
    if (!project) return reply.code(400).send({ error: "missing project" });
    const result = orchestrator.newTask(project);
    return reply.code(result.status).send(result.ok ? { ok: true, taskId: result.taskId } : { error: result.error });
  });

  app.post("/api/tasks/relaunch", async (request, reply) => {
    const { task, role, mode } = (request.body ?? {}) as {
      task?: string;
      role?: "planner" | "verifier" | "coder";
      mode?: string;
    };
    if (typeof task !== "string") return reply.code(400).send({ error: "missing task" });
    if (role !== "planner" && role !== "verifier" && role !== "coder")
      return reply.code(400).send({ error: "invalid role" });
    if (mode !== undefined && mode !== "new" && mode !== "resume")
      return reply.code(400).send({ error: "invalid mode" });
    const result = orchestrator.relaunch(task, role, (mode as "new" | "resume" | undefined) ?? "new");
    return reply.code(result.status).send(result.ok ? { ok: true, ...(result.queued ? { queued: true } : {}) } : { error: result.error });
  });

  app.post("/api/tasks/close", async (request, reply) => {
    const { task } = (request.body ?? {}) as { task?: string };
    if (typeof task !== "string") return reply.code(400).send({ error: "missing task" });
    const result = orchestrator.closeTask(task);
    return reply.code(result.status).send(result.ok ? { ok: true } : { error: result.error });
  });

  app.post("/api/tasks/commit-done", async (request, reply) => {
    const { task } = (request.body ?? {}) as { task?: string };
    if (typeof task !== "string") return reply.code(400).send({ error: "missing task" });
    const result = orchestrator.commitDone(task);
    return reply.code(result.status).send(result.ok ? { ok: true } : { error: result.error });
  });

  app.post("/api/timeline/clear", async (request, reply) => {
    const { task } = (request.body ?? {}) as { task?: string };
    if (typeof task !== "string") return reply.code(400).send({ error: "missing task" });
    const result = orchestrator.clearTimeline(task);
    return reply.code(result.status).send(result.ok ? { ok: true } : { error: result.error });
  });

  app.post("/api/projects", async (request, reply) => {
    const r = orchestrator.addProject(request.body);
    return reply.code(r.status).send(r.payload);
  });

  app.post("/api/projects/remove", async (request, reply) => {
    const r = orchestrator.removeProject(request.body);
    return reply.code(r.status).send(r.payload);
  });

  app.post("/api/ui/window", async (request, reply) => {
    const r = handleWindowSize(config, cfgPath, request.body);
    return reply.code(r.status).send(r.payload);
  });

  // 정적 서빙 (server/public — 웹 UI 빌드 산출물). API·훅 라우트 이후 등록.
  await app.register(fastifyStatic, { root: publicDir });

  try {
    await app.listen({ port: config.port, host: "127.0.0.1" });
  } catch (err) {
    if ((err as { code?: string }).code === "EADDRINUSE") {
      console.log(`포트 ${config.port}가 사용 중입니다 — 이미 AISM 서버가 켜져 있으면 UI는 scripts\\open_ui.bat으로 여세요.`);
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

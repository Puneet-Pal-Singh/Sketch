import Fastify from "fastify";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { CodexRunner } from "./codex-runner.js";
import { createProjectSchema, createTurnSchema, type ElementSelection, type SessionSnapshot, type StudioEvent } from "./contracts.js";
import { LocalPreviewRunner } from "./preview-runner.js";
import { WorkspaceStore } from "./workspace.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(currentDirectory, "../../..");
const port = Number(process.env.STUDIO_SERVER_PORT ?? 8787);

const workspace = new WorkspaceStore(projectRoot);
const preview = new LocalPreviewRunner();
const codex = new CodexRunner();

let session: SessionSnapshot = {
  workspaceId: "demo-app",
  projectName: null,
  threadId: null,
  turnStatus: "idle",
  previewStatus: "stopped",
  previewUrl: null,
  previewOrigin: null,
  initialPrompt: null,
  selectedElement: null,
};
const clients = new Set<NodeJS.WritableStream>();

const app = Fastify({ logger: false });

app.addHook("onRequest", async (_request, reply) => {
  reply.header("Access-Control-Allow-Origin", "http://127.0.0.1:5173");
  reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  reply.header("Access-Control-Allow-Headers", "content-type");
});
app.options("*", async (_request, reply) => reply.code(204).send());

function snapshot() { return structuredClone(session); }

function emit(event: StudioEvent) {
  const message = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    try { client.write(message); } catch { clients.delete(client); }
  }
}

function updateSession(mutator: () => void) {
  mutator();
  emit({ type: "session.snapshot", session: snapshot() });
}

function safeDetail(detail: string | undefined) {
  return detail?.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").slice(0, 900);
}

async function startPreview() {
  void preview.start(workspace.path, {
    starting: () => {
      updateSession(() => { session.previewStatus = "starting"; session.previewUrl = null; session.previewOrigin = null; });
      emit({ type: "preview.starting" });
    },
    ready: url => {
      updateSession(() => {
        session.previewStatus = "ready";
        session.previewUrl = url;
        session.previewOrigin = new URL(url).origin;
      });
      emit({ type: "preview.ready", url, origin: new URL(url).origin });
    },
    failed: message => {
      updateSession(() => { session.previewStatus = "failed"; });
      emit({ type: "preview.failed", message });
    },
  });
}

function basePrompt(request: string, selection?: ElementSelection) {
  const envelope = [
    "You are building a frontend application inside the existing React/Vite workspace.",
    "Preserve the existing package scripts, Vite configuration, and development-only preview inspector integration.",
    "Use React DOM and CSS rather than Canvas for interactive UI. Do not change frameworks or add backend services.",
  ];
  if (!selection) return `${envelope.join("\n")}\n\nUser request:\n${request}`;
  const source = selection.source?.file ?? "No exact source annotation is available; locate it using the HTML/text/classes.";
  return [
    ...envelope,
    "",
    "This is a selection-grounded follow-up. Edit the owning source when possible.",
    `Original project request: ${session.initialPrompt ?? "(not available)"}`,
    "Selected element context (validated from the running preview):",
    `- source: ${source}`,
    `- studio id: ${selection.elementId ?? "none"}`,
    `- tag: ${selection.tagName}`,
    `- text: ${selection.text || "(empty)"}`,
    `- classes: ${selection.classNames.join(" ") || "(none)"}`,
    `- outer HTML: ${selection.outerHTML}`,
    `- rectangle: ${Math.round(selection.rect.x)},${Math.round(selection.rect.y)} ${Math.round(selection.rect.width)}x${Math.round(selection.rect.height)}`,
    "",
    `Requested change: ${request}`,
  ].join("\n");
}

async function runTurn(request: string, selection?: ElementSelection) {
  if (codex.running || session.turnStatus === "running") throw new Error("A Codex turn is already running.");
  if (selection) updateSession(() => { session.selectedElement = selection; });
  await codex.run({
    workspace: workspace.path,
    prompt: basePrompt(request, selection),
    threadId: session.threadId,
    callbacks: {
      started: turnId => {
        updateSession(() => { session.turnStatus = "running"; });
        emit({ type: "turn.started", turnId });
      },
      thread: threadId => updateSession(() => { session.threadId = threadId; }),
      activity: (title, detail) => emit({ type: "activity.updated", title, detail: safeDetail(detail) }),
      completed: async summary => {
        updateSession(() => { session.turnStatus = "succeeded"; });
        await workspace.touchApp();
        const paths = await workspace.listFiles().catch(() => []);
        emit({ type: "files.changed", paths });
        emit({ type: "turn.completed", summary: safeDetail(summary) ?? "Codex completed the workspace update." });
      },
      failed: message => {
        updateSession(() => { session.turnStatus = "failed"; });
        emit({ type: "turn.failed", message: safeDetail(message) ?? "Codex failed." });
      },
      cancelled: () => {
        updateSession(() => { session.turnStatus = "cancelled"; });
        emit({ type: "turn.cancelled" });
      },
    },
  });
}

app.get("/api/health", async () => ({ ok: true, session: snapshot() }));

app.get("/api/apps", async () => ({ apps: await workspace.listApps(), activeId: workspace.currentId }));

app.get("/api/events", async (request, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "http://127.0.0.1:5173",
  });
  reply.raw.write(`data: ${JSON.stringify({ type: "session.snapshot", session: snapshot() } satisfies StudioEvent)}\n\n`);
  clients.add(reply.raw);
  const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
  request.raw.once("close", () => { clearInterval(heartbeat); clients.delete(reply.raw); });
});

app.post("/api/projects", async (request, reply) => {
  const parsed = createProjectSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "A project prompt is required.", issues: parsed.error.flatten() });
  if (codex.running) return reply.code(409).send({ error: "A Codex turn is already running." });
  try {
    await preview.stop();
    const name = parsed.data.prompt.split(/\s+/).slice(0, 4).join(" ").replace(/[^\w\s-]/g, "") || "Untitled app";
    const localApp = await workspace.createApp(name, parsed.data.prompt);
    session = {
      workspaceId: localApp.id,
      projectName: localApp.name,
      threadId: null,
      turnStatus: "idle",
      previewStatus: "stopped",
      previewUrl: null,
      previewOrigin: null,
      initialPrompt: parsed.data.prompt,
      selectedElement: null,
    };
    emit({ type: "session.snapshot", session: snapshot() });
    emit({ type: "files.changed", paths: await workspace.listFiles() });
    await startPreview();
    void runTurn(parsed.data.prompt).catch(error => {
      updateSession(() => { session.turnStatus = "failed"; });
      emit({ type: "turn.failed", message: error instanceof Error ? error.message : "Could not start Codex." });
    });
    return reply.code(202).send(snapshot());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create workspace.";
    updateSession(() => { session.turnStatus = "failed"; session.previewStatus = "failed"; });
    emit({ type: "turn.failed", message });
    return reply.code(500).send({ error: message });
  }
});

app.post("/api/apps/:id/open", async (request, reply) => {
  const id = typeof (request.params as { id?: unknown }).id === "string" ? (request.params as { id: string }).id : "";
  if (!id) return reply.code(400).send({ error: "An app id is required." });
  try {
    await codex.stop();
    await preview.stop();
    const localApp = await workspace.openApp(id);
    session = {
      workspaceId: localApp.id,
      projectName: localApp.name,
      threadId: null,
      turnStatus: "idle",
      previewStatus: "stopped",
      previewUrl: null,
      previewOrigin: null,
      initialPrompt: localApp.prompt,
      selectedElement: null,
    };
    emit({ type: "session.snapshot", session: snapshot() });
    emit({ type: "files.changed", paths: await workspace.listFiles() });
    await startPreview();
    return reply.code(200).send(snapshot());
  } catch (error) {
    return reply.code(500).send({ error: error instanceof Error ? error.message : "Could not open local app." });
  }
});

app.post("/api/turns", async (request, reply) => {
  const parsed = createTurnSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "A valid request is required.", issues: parsed.error.flatten() });
  if (!session.initialPrompt) return reply.code(409).send({ error: "Create a project before sending a follow-up." });
  if (codex.running || session.turnStatus === "running") return reply.code(409).send({ error: "A Codex turn is already running." });
  try {
    void runTurn(parsed.data.prompt, parsed.data.selection ?? undefined).catch(error => {
      updateSession(() => { session.turnStatus = "failed"; });
      emit({ type: "turn.failed", message: error instanceof Error ? error.message : "Could not start Codex." });
    });
    return reply.code(202).send({ accepted: true });
  } catch (error) {
    return reply.code(500).send({ error: error instanceof Error ? error.message : "Could not start Codex." });
  }
});

app.post("/api/turns/current/stop", async (_request, reply) => {
  if (!codex.running) return reply.code(409).send({ error: "No active Codex turn." });
  await codex.stop();
  return reply.code(202).send({ accepted: true });
});

app.post("/api/session/reset", async (_request, reply) => {
  await codex.stop();
  await preview.stop();
  session = {
    workspaceId: "demo-app",
    projectName: null,
    threadId: null,
    turnStatus: "idle",
    previewStatus: "stopped",
    previewUrl: null,
    previewOrigin: null,
    initialPrompt: null,
    selectedElement: null,
  };
  emit({ type: "session.snapshot", session: snapshot() });
  return reply.code(200).send({ session: snapshot() });
});

app.get("/api/files", async (_request, reply) => {
  if (!session.initialPrompt) return reply.code(409).send({ error: "No active project." });
  try { return { files: await workspace.listFiles() }; }
  catch (error) { return reply.code(500).send({ error: error instanceof Error ? error.message : "Could not list files." }); }
});

app.get("/api/file", async (request, reply) => {
  const path = typeof (request.query as { path?: unknown }).path === "string" ? (request.query as { path: string }).path : "";
  try { return await workspace.readText(path); }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Could not read file." }); }
});

const close = async () => { await codex.stop(); await preview.stop(); };
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));

await app.listen({ host: "127.0.0.1", port });

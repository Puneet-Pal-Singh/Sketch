import { Codex, type Thread, type ThreadEvent } from "@openai/codex-sdk";
import { randomUUID } from "node:crypto";

export type RunnerCallbacks = {
  started(turnId: string): void;
  activity(title: string, detail?: string): void;
  completed(summary: string): void;
  failed(message: string): void;
  cancelled(): void;
  thread(threadId: string): void;
};

/**
 * Subscription-backed Codex harness. The SDK supplies a compatible local
 * runtime and streams structured agent events while all writes stay inside
 * Sketch's generated Vite workspace.
 */
export class CodexRunner {
  private codex = new Codex();
  private thread: Thread | null = null;
  private workspace: string | null = null;
  private controller: AbortController | null = null;
  private active: { callbacks: RunnerCallbacks; turnId: string } | null = null;

  get running() { return this.active !== null; }

  async run({ workspace, prompt, threadId, callbacks }: { workspace: string; prompt: string; threadId: string | null; callbacks: RunnerCallbacks }) {
    if (this.active) throw new Error("A Codex turn is already running.");
    if (this.workspace !== workspace) {
      this.workspace = workspace;
      this.thread = null;
    }
    if (!this.thread) {
      this.thread = threadId
        ? this.codex.resumeThread(threadId, { workingDirectory: workspace, sandboxMode: "workspace-write", skipGitRepoCheck: true, approvalPolicy: "never" })
        : this.codex.startThread({ workingDirectory: workspace, sandboxMode: "workspace-write", skipGitRepoCheck: true, approvalPolicy: "never" });
    }
    const turnId = randomUUID();
    this.controller = new AbortController();
    this.active = { callbacks, turnId };
    callbacks.started(turnId);
    callbacks.activity(threadId ? "Resuming Codex" : "Starting Codex", "Using the local Codex SDK harness");
    let finalMessage = "Codex completed the workspace update.";
    try {
      const streamed = await this.thread.runStreamed(prompt, { signal: this.controller.signal });
      for await (const event of streamed.events) {
        this.project(event, callbacks, message => { finalMessage = message; });
        if (!this.active) return;
      }
      if (this.active) {
        this.active = null;
        callbacks.completed(finalMessage);
      }
    } catch (error) {
      if (!this.active) return;
      this.active = null;
      if (this.controller?.signal.aborted) callbacks.cancelled();
      else callbacks.failed(error instanceof Error ? error.message : "Codex SDK could not complete the turn.");
    } finally {
      this.controller = null;
    }
  }

  async stop() {
    if (!this.active) return;
    this.controller?.abort();
  }

  private project(event: ThreadEvent, callbacks: RunnerCallbacks, setFinal: (message: string) => void) {
    switch (event.type) {
      case "thread.started":
        callbacks.thread(event.thread_id);
        callbacks.activity("Codex thread ready", event.thread_id.slice(0, 12));
        return;
      case "turn.started":
        callbacks.activity("Codex is working", "Planning and editing the generated app.");
        return;
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = event.item;
        const detail = item.type === "agent_message" || item.type === "reasoning" ? item.text
          : item.type === "command_execution" ? item.command
          : item.type === "file_change" ? item.changes.map(change => `${change.kind} ${change.path}`).join(" · ")
          : item.type === "error" ? item.message
          : item.type;
        if (item.type === "agent_message") setFinal(item.text);
        callbacks.activity(event.type === "item.completed" ? `${item.type} complete` : item.type, detail.slice(0, 900));
        return;
      }
      case "turn.failed":
        this.active = null;
        callbacks.failed(event.error.message);
        return;
      case "error":
        this.active = null;
        callbacks.failed(event.message);
    }
  }
}

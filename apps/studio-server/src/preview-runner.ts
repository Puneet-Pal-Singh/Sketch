import { ChildProcess, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export type PreviewCallbacks = {
  starting(): void;
  ready(url: string): void;
  failed(message: string): void;
};

export class LocalPreviewRunner {
  private child: ChildProcess | null = null;
  private intentionalStop = false;
  readonly url = "http://127.0.0.1:4173";

  async start(workspace: string, callbacks: PreviewCallbacks) {
    await this.stop();
    this.intentionalStop = false;
    callbacks.starting();
    this.child = spawn("pnpm", ["exec", "vite", "--host", "127.0.0.1", "--port", "4173", "--strictPort"], {
      cwd: workspace,
      env: { ...process.env, BROWSER: "none", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const capture = (chunk: Buffer) => { output = `${output}${chunk.toString()}`.slice(-4_000); };
    this.child.stdout?.on("data", capture);
    this.child.stderr?.on("data", capture);
    this.child.once("error", error => callbacks.failed(`Preview could not start: ${error.message}`));
    this.child.once("exit", (code, signal) => {
      if (!this.intentionalStop) callbacks.failed(`Preview stopped (${signal ?? `exit ${code ?? "unknown"}`})${output ? `: ${output.slice(-700)}` : ""}`);
    });
    for (let attempt = 0; attempt < 36; attempt += 1) {
      if (!this.child || this.child.exitCode !== null) return;
      try {
        const response = await fetch(this.url, { signal: AbortSignal.timeout(750) });
        if (response.ok) {
          callbacks.ready(this.url);
          return;
        }
      } catch { /* Vite is still warming up. */ }
      await delay(250);
    }
    callbacks.failed("Preview did not become ready on port 4173.");
    await this.stop();
  }

  async stop() {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    this.intentionalStop = true;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>(resolve => child.once("exit", () => resolve())),
      delay(2_000).then(() => { if (child.exitCode === null) child.kill("SIGKILL"); }),
    ]);
  }
}

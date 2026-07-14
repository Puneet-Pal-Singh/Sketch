import type { ElementSelection, LocalApp, SessionProjection, StudioEvent } from "./types";

const API_ORIGIN = import.meta.env.VITE_STUDIO_API_ORIGIN ?? "http://127.0.0.1:8787";

export interface StudioApi {
  createProject(prompt: string): Promise<SessionProjection>;
  submitTurn(prompt: string, selection?: ElementSelection): Promise<void>;
  reset(): Promise<void>;
  getApps(): Promise<{ apps: LocalApp[]; activeId: string | null }>;
  openApp(id: string): Promise<SessionProjection>;
  getFiles(): Promise<string[]>;
  getFile(path: string): Promise<string>;
  subscribe(onEvent: (event: StudioEvent) => void, onError: () => void): () => void;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = await response.text();
    throw new Error(payload || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

class RestStudioApi implements StudioApi {
  async createProject(prompt: string) {
    return readJson<SessionProjection>(await fetch(`${API_ORIGIN}/api/projects`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }),
    }));
  }

  async submitTurn(prompt: string, selection?: ElementSelection) {
    await readJson<unknown>(await fetch(`${API_ORIGIN}/api/turns`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, selection }),
    }));
  }

  async reset() {
    await readJson<unknown>(await fetch(`${API_ORIGIN}/api/session/reset`, { method: "POST" }));
  }

  async getApps() {
    return readJson<{ apps: LocalApp[]; activeId: string | null }>(await fetch(`${API_ORIGIN}/api/apps`));
  }

  async openApp(id: string) {
    return readJson<SessionProjection>(await fetch(`${API_ORIGIN}/api/apps/${encodeURIComponent(id)}/open`, { method: "POST" }));
  }

  async getFiles() {
    const payload = await readJson<{ files?: string[] } | string[]>(await fetch(`${API_ORIGIN}/api/files`));
    return Array.isArray(payload) ? payload : payload.files ?? [];
  }

  async getFile(path: string) {
    const response = await fetch(`${API_ORIGIN}/api/file?path=${encodeURIComponent(path)}`);
    if (!response.ok) throw new Error((await response.text()) || `Request failed (${response.status})`);
    const body = await response.text();
    try {
      const payload = JSON.parse(body) as { content?: string } | string;
      return typeof payload === "string" ? payload : payload.content ?? "";
    } catch { return body; }
  }

  subscribe(onEvent: (event: StudioEvent) => void, onError: () => void) {
    const source = new EventSource(`${API_ORIGIN}/api/events`);
    source.onmessage = (message) => {
      try { onEvent(JSON.parse(message.data) as StudioEvent); } catch { /* malformed server event is ignored */ }
    };
    source.onerror = onError;
    return () => source.close();
  }
}

export const studioApi: StudioApi = new RestStudioApi();

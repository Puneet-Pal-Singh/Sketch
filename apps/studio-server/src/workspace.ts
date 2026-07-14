import { cp, lstat, mkdir, readFile, realpath, rm, symlink, writeFile, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const ignored = new Set(["node_modules", ".git", "dist", ".DS_Store"]);

export type LocalApp = {
  id: string;
  name: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
};

function slugify(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 44) || "untitled-app";
}

export class WorkspaceStore {
  readonly appsPath: string;
  readonly indexPath: string;
  readonly legacyPath: string;
  readonly templatePath: string;
  private activeId: string | null = null;

  constructor(rootPath: string) {
    this.appsPath = resolve(rootPath, "local-apps");
    this.indexPath = resolve(rootPath, ".sketch", "apps.json");
    this.legacyPath = resolve(rootPath, "workspaces", "demo-app");
    this.templatePath = resolve(rootPath, "templates", "react-vite-demo");
  }

  get path() {
    if (!this.activeId) throw new Error("No local app is open");
    return resolve(this.appsPath, this.activeId);
  }

  get currentId() { return this.activeId; }

  private async readIndex(): Promise<LocalApp[]> {
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry): entry is LocalApp => !!entry && typeof entry === "object" && typeof (entry as LocalApp).id === "string" && typeof (entry as LocalApp).name === "string" && typeof (entry as LocalApp).prompt === "string" && typeof (entry as LocalApp).createdAt === "string" && typeof (entry as LocalApp).updatedAt === "string");
    } catch { return []; }
  }

  private async writeIndex(apps: LocalApp[]) {
    await mkdir(dirname(this.indexPath), { recursive: true });
    await writeFile(this.indexPath, `${JSON.stringify(apps, null, 2)}\n`, "utf8");
  }

  private async migrateLegacyApp() {
    const apps = await this.readIndex();
    if (apps.some(app => app.id === "recovered-demo-app")) return apps;
    const legacy = await lstat(this.legacyPath).catch(() => null);
    if (!legacy?.isDirectory()) return apps;
    const target = resolve(this.appsPath, "recovered-demo-app");
    const existing = await lstat(target).catch(() => null);
    if (!existing) {
      await mkdir(this.appsPath, { recursive: true });
      await cp(this.legacyPath, target, {
        recursive: true,
        filter: source => basename(source) !== "node_modules" && basename(source) !== ".DS_Store",
      });
      const templateModules = resolve(this.templatePath, "node_modules");
      await symlink(templateModules, resolve(target, "node_modules"), "dir").catch(() => undefined);
    }
    const now = new Date().toISOString();
    const recovered: LocalApp = { id: "recovered-demo-app", name: "Recovered Sketch app", prompt: "Continue the recovered local Sketch application.", createdAt: now, updatedAt: now };
    await this.writeIndex([recovered, ...apps]);
    return [recovered, ...apps];
  }

  async listApps() {
    return (await this.migrateLegacyApp()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createApp(name: string, prompt: string) {
    const now = new Date().toISOString();
    const id = `${slugify(name)}-${Math.random().toString(36).slice(2, 8)}`;
    const app: LocalApp = { id, name: name.slice(0, 90), prompt, createdAt: now, updatedAt: now };
    this.activeId = id;
    await this.materialize();
    const apps = await this.migrateLegacyApp();
    await this.writeIndex([app, ...apps]);
    return app;
  }

  async openApp(id: string) {
    const app = (await this.migrateLegacyApp()).find(entry => entry.id === id);
    if (!app) throw new Error("That local app could not be found");
    const directory = resolve(this.appsPath, app.id);
    const stats = await lstat(directory).catch(() => null);
    if (!stats?.isDirectory()) throw new Error("The local app directory is missing");
    this.activeId = app.id;
    return app;
  }

  async touchApp() {
    if (!this.activeId) return;
    const apps = await this.readIndex();
    const index = apps.findIndex(entry => entry.id === this.activeId);
    if (index === -1) return;
    apps[index] = { ...apps[index], updatedAt: new Date().toISOString() };
    await this.writeIndex(apps);
  }

  private async materialize() {
    await rm(this.path, { recursive: true, force: true });
    await mkdir(dirname(this.path), { recursive: true });
    try {
      await cp(this.templatePath, this.path, {
        recursive: true,
        filter: source => basename(source) !== "node_modules" && basename(source) !== ".DS_Store",
      });
      const templateModules = resolve(this.templatePath, "node_modules");
      await lstat(templateModules);
      await symlink(templateModules, resolve(this.path, "node_modules"), "dir");
    } catch (error) {
      await rm(this.path, { recursive: true, force: true });
      throw new Error(`Could not create the local app: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  safePath(input: string) {
    if (!input || isAbsolute(input) || input.includes("\0")) throw new Error("Invalid workspace path");
    const candidate = resolve(this.path, input);
    const rel = relative(this.path, candidate);
    if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new Error("Path is outside the workspace");
    return candidate;
  }

  async listFiles() {
    const walk = async (directory: string): Promise<string[]> => {
      const names = await readdir(directory, { withFileTypes: true });
      const nested = await Promise.all(names.sort((a, b) => a.name.localeCompare(b.name)).map(async entry => {
        if (ignored.has(entry.name)) return [];
        const full = resolve(directory, entry.name);
        if (entry.isDirectory()) return walk(full);
        if (!entry.isFile() || (await lstat(full)).size > 1_500_000) return [];
        return [relative(this.path, full)];
      }));
      return nested.flat();
    };
    return walk(this.path);
  }

  async readText(input: string) {
    const file = this.safePath(input);
    const stats = await lstat(file);
    if (!stats.isFile() || stats.size > 1_500_000) throw new Error("File cannot be read");
    const actual = await realpath(file);
    const root = await realpath(this.path);
    if (relative(root, actual).startsWith("..")) throw new Error("Path is outside the workspace");
    return { path: input, content: await readFile(actual, "utf8") };
  }
}

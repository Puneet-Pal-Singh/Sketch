import { FormEvent, type ReactNode, RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { studioApi } from "./api";
import type { Activity, ChatMessage, ElementSelection, LocalApp, PreviewStatus, SessionProjection, StudioEvent, TurnStatus } from "./types";

const examples = [
  ["Endless runner", "Build a neon three-lane endless runner with a score, coins, keyboard controls, and a start screen."],
  ["Analytics dashboard", "Build an elegant creator analytics dashboard with revenue charts, goals, and recent activity."],
  ["SaaS landing page", "Build a high-conviction landing page for a collaborative writing product."],
  ["Color utility", "Build a visual color palette tool with an accessible contrast checker and exportable swatches."],
] as const;

const starterActivities: Activity[] = [
  { id: "boot", title: "Workspace prepared", detail: "Waiting for your build brief." },
];

function cleanProjectName(prompt: string) {
  return prompt.split(/\s+/).slice(0, 4).join(" ").replace(/[^\w\s-]/g, "") || "Untitled project";
}

function nowId() { return `${Date.now()}-${Math.random().toString(16).slice(2)}`; }

function statusLabel(status: PreviewStatus, turn: TurnStatus) {
  if (turn === "running") return "Building";
  if (status === "ready") return "Live";
  if (status === "starting") return "Starting preview";
  if (status === "failed") return "Preview issue";
  return "Ready";
}

const elementSelectionSchema = z.object({
  elementId: z.string().max(160).nullable(),
  tagName: z.string().min(1).max(40),
  text: z.string().max(600),
  classNames: z.array(z.string().max(120)).max(40),
  source: z.object({ file: z.string().min(1).max(500).refine((path) => !path.startsWith("/") && !path.split("/").includes("..")) }).nullable(),
  outerHTML: z.string().max(3000),
  rect: z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative() }),
});

export function SketchApp() {
  const [screen, setScreen] = useState<"home" | "studio">("home");
  const [projectName, setProjectName] = useState("Untitled project");
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>("stopped");
  const [turnStatus, setTurnStatus] = useState<TurnStatus>("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewOrigin, setPreviewOrigin] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activities, setActivities] = useState<Activity[]>(starterActivities);
  const [selected, setSelected] = useState<ElementSelection | null>(null);
  const [activeTab, setActiveTab] = useState<"preview" | "code">("preview");
  const [files, setFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [requestError, setRequestError] = useState<string | null>(null);
  const [isInspecting, setIsInspecting] = useState(false);
  const [viewport, setViewport] = useState<"desktop" | "tablet" | "mobile">("desktop");
  const [apps, setApps] = useState<LocalApp[]>([]);
  const [activeAppId, setActiveAppId] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const nonceRef = useRef(crypto.randomUUID());

  const appendActivity = useCallback((activity: Omit<Activity, "id">) => {
    setActivities((current) => [...current.slice(-18), { ...activity, id: nowId() }]);
  }, []);

  const projectProjection = useCallback((projection: SessionProjection) => {
    if (projection.projectName) setProjectName(projection.projectName);
    if (projection.workspaceId) setActiveAppId(projection.workspaceId === "demo-app" ? null : projection.workspaceId);
    if (projection.previewStatus) setPreviewStatus(projection.previewStatus);
    if (projection.turnStatus) setTurnStatus(projection.turnStatus);
    if (projection.previewUrl) setPreviewUrl(projection.previewUrl);
    if (projection.previewOrigin) setPreviewOrigin(projection.previewOrigin);
  }, []);

  const loadFiles = useCallback(async (prefer?: string) => {
    try {
      const nextFiles = await studioApi.getFiles();
      setFiles(nextFiles);
      const target = prefer && nextFiles.includes(prefer) ? prefer : nextFiles.find((path) => /src\/(App|main)\.[tj]sx?$/.test(path)) ?? nextFiles[0];
      if (target) {
        setActiveFile(target);
        setFileContent(await studioApi.getFile(target));
      }
    } catch { /* no files until a workspace exists */ }
  }, []);

  const handleEvent = useCallback((event: StudioEvent) => {
    switch (event.type) {
      case "session.snapshot": projectProjection(event.session); break;
      case "turn.started":
        setTurnStatus("running"); appendActivity({ title: "Codex is working", detail: "Planning and editing your workspace." });
        setMessages((current) => current.some((message) => message.isWorking) ? current : [...current, { id: event.turnId, role: "agent", content: "I’m working in your project now.", isWorking: true }]); break;
      case "activity.updated": appendActivity({ title: event.title, detail: event.detail }); break;
      case "files.changed":
        appendActivity({ title: "Files updated", detail: event.paths.join(" · "), tone: "success" });
        void loadFiles(event.paths[0]); break;
      case "turn.completed":
        setTurnStatus("succeeded"); appendActivity({ title: "Build complete", detail: event.summary, tone: "success" });
        setMessages((current) => current.map((message) => message.isWorking ? { ...message, isWorking: false, content: event.summary || "The latest changes are ready." } : message));
        void loadFiles(); break;
      case "turn.failed":
        setTurnStatus("failed"); appendActivity({ title: "Build needs attention", detail: event.message, tone: "danger" });
        setMessages((current) => current.map((message) => message.isWorking ? { ...message, isWorking: false, content: event.message } : message)); break;
      case "turn.cancelled": setTurnStatus("cancelled"); appendActivity({ title: "Build stopped" }); break;
      case "preview.starting": setPreviewStatus("starting"); appendActivity({ title: "Starting preview", detail: "Vite is warming up." }); break;
      case "preview.ready": setPreviewStatus("ready"); setPreviewUrl(event.url); setPreviewOrigin(event.origin); appendActivity({ title: "Preview live", detail: event.url, tone: "success" }); break;
      case "preview.failed": setPreviewStatus("failed"); appendActivity({ title: "Preview unavailable", detail: event.message, tone: "danger" }); break;
    }
  }, [appendActivity, loadFiles]);

  useEffect(() => studioApi.subscribe(handleEvent, () => undefined), [handleEvent]);

  const refreshApps = useCallback(async () => {
    try {
      const list = await studioApi.getApps();
      setApps(list.apps); setActiveAppId(list.activeId);
    } catch { /* The server may be restarting while Vite is ready. */ }
  }, []);

  useEffect(() => { void refreshApps(); }, [refreshApps]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (!previewOrigin || event.origin !== previewOrigin || event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { type?: string; sessionNonce?: string; selection?: unknown } | null;
      if (!data || data.sessionNonce !== nonceRef.current) return;
      const selection = data.type === "ELEMENT_SELECTED" ? elementSelectionSchema.safeParse(data.selection) : null;
      if (selection?.success) {
        frameRef.current?.contentWindow?.postMessage({ type: "INSPECTOR_DISABLE", sessionNonce: nonceRef.current }, previewOrigin);
        setSelected(selection.data); setIsInspecting(false);
        appendActivity({ title: "Element attached", detail: selection.data.source?.file ?? `${selection.data.tagName.toLowerCase()} · approximate match`, tone: "success" });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [appendActivity, previewOrigin]);

  const postInspector = useCallback((enabled: boolean) => {
    if (!frameRef.current?.contentWindow || !previewOrigin) return;
    frameRef.current.contentWindow.postMessage({ type: enabled ? "INSPECTOR_ENABLE" : "INSPECTOR_DISABLE", sessionNonce: nonceRef.current }, previewOrigin);
  }, [previewOrigin]);

  const beginBuild = async (prompt: string) => {
    const text = prompt.trim(); if (!text) return;
    setRequestError(null); setProjectName(cleanProjectName(text)); setScreen("studio"); setTurnStatus("running"); setPreviewStatus("starting");
    setMessages([{ id: nowId(), role: "user", content: text }, { id: nowId(), role: "agent", content: "I’m setting up your workspace…", isWorking: true }]);
    setActivities([{ id: nowId(), title: "Creating a fresh workspace", detail: "Starting a real Codex turn." }]);
    try {
      projectProjection(await studioApi.createProject(text));
      await refreshApps();
      void loadFiles();
    } catch (error) { setTurnStatus("failed"); setRequestError(error instanceof Error ? error.message : "Could not start this build."); }
  };

  const submitFollowup = async (prompt: string) => {
    const text = prompt.trim(); if (!text || turnStatus === "running") return;
    setRequestError(null); setTurnStatus("running");
    setMessages((current) => [...current, { id: nowId(), role: "user", content: text, selection: selected ?? undefined }, { id: nowId(), role: "agent", content: "Applying that change…", isWorking: true }]);
    try { await studioApi.submitTurn(text, selected ?? undefined); setSelected(null); } catch (error) { setTurnStatus("failed"); setRequestError(error instanceof Error ? error.message : "Could not send this request."); }
  };

  const reset = async () => {
    try { await studioApi.reset(); } catch { /* UI can still reset safely */ }
    nonceRef.current = crypto.randomUUID(); setScreen("home"); setPreviewStatus("stopped"); setTurnStatus("idle"); setPreviewUrl(null); setPreviewOrigin(null); setMessages([]); setActivities(starterActivities); setSelected(null); setFiles([]); setActiveFile(""); setFileContent(""); setRequestError(null); setIsInspecting(false);
  };

  const openApp = async (id: string) => {
    if (turnStatus === "running" || id === activeAppId) return;
    setRequestError(null);
    try {
      const projection = await studioApi.openApp(id);
      projectProjection(projection); setActiveAppId(id); setScreen("studio"); setActiveTab("preview");
      setMessages([]); setActivities([{ id: nowId(), title: "Local app opened", detail: "Restored from your local-apps directory.", tone: "success" }]);
      setSelected(null); setIsInspecting(false); setFiles([]); setActiveFile(""); setFileContent("");
      await loadFiles();
      await refreshApps();
    } catch (error) { setRequestError(error instanceof Error ? error.message : "Could not open this local app."); }
  };

  const onFrameLoad = () => { if (isInspecting) postInspector(true); };
  const runtimeCopy = useMemo(() => statusLabel(previewStatus, turnStatus), [previewStatus, turnStatus]);

  if (screen === "home") return <PromptHome onBuild={beginBuild} />;
  return <Studio
    projectName={projectName} runtimeCopy={runtimeCopy} previewStatus={previewStatus} turnStatus={turnStatus} messages={messages} activities={activities}
    selected={selected} setSelected={setSelected} submitFollowup={submitFollowup} requestError={requestError}
    activeTab={activeTab} setActiveTab={setActiveTab} previewUrl={previewUrl} previewOrigin={previewOrigin} frameRef={frameRef} onFrameLoad={onFrameLoad}
    isInspecting={isInspecting} onInspect={() => { const next = !isInspecting; setIsInspecting(next); postInspector(next); }} onRefresh={() => { if (frameRef.current) frameRef.current.src = frameRef.current.src; }}
    viewport={viewport} setViewport={setViewport} files={files} activeFile={activeFile} fileContent={fileContent} onPickFile={async (path) => { setActiveFile(path); setFileContent(await studioApi.getFile(path)); }}
    apps={apps} activeAppId={activeAppId} onOpenApp={openApp} onNewApp={reset}
  />;
}

function Mark() { return <span className="mark" aria-hidden="true"><i /><i /><i /></span>; }

function PromptHome({ onBuild }: { onBuild: (prompt: string) => void }) {
  const [prompt, setPrompt] = useState("");
  const submit = (event: FormEvent) => { event.preventDefault(); onBuild(prompt); };
  return <main className="home-shell home-v2">
    <nav className="home-nav"><div className="wordmark"><Mark />Sketch</div><div className="nav-actions"><span className="nav-status"><i /> Local workspace ready</span><button className="subtle-button">⌘ K</button></div></nav>
    <section className="hero">
      <div className="home-kicker"><span>✦</span> AI product builder</div>
      <h1>Create working apps,<br /><span>not mockups.</span></h1>
      <p className="hero-copy">Describe what you want to make. Sketch gives Codex a real workspace, a live preview, and the context to refine every detail.</p>
      <form className="hero-composer" onSubmit={submit}>
        <div className="composer-label"><strong>What would you like to build?</strong><span>React + Vite</span></div>
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && prompt.trim()) { event.preventDefault(); onBuild(prompt); } }} autoFocus placeholder="A finance dashboard for freelancers with revenue charts, invoices, and monthly goals…" rows={4} />
        <div className="composer-bottom"><span><kbd>⌘</kbd><kbd>↵</kbd> to build</span><button className="build-button" disabled={!prompt.trim()}>Start building <span>↗</span></button></div>
      </form>
      <div className="example-row"><span>Try an example</span><div className="examples">{examples.slice(0, 3).map(([label, value]) => <button key={label} onClick={() => setPrompt(value)}><span>+</span>{label}</button>)}</div></div>
      <div className="home-proof"><span><i>✓</i> Real files</span><span><i>✓</i> Live preview</span><span><i>✓</i> Visual editing</span></div>
    </section>
    <footer className="home-footer"><div className="signal"><span className="signal-dot" /> Codex connected</div><p>Projects are stored locally on your machine.</p></footer>
  </main>;
}

type StudioProps = {
  projectName: string; runtimeCopy: string; previewStatus: PreviewStatus; turnStatus: TurnStatus; messages: ChatMessage[]; activities: Activity[]; selected: ElementSelection | null; setSelected: (value: ElementSelection | null) => void; submitFollowup: (prompt: string) => void; requestError: string | null;
  activeTab: "preview" | "code"; setActiveTab: (value: "preview" | "code") => void; previewUrl: string | null; previewOrigin: string | null; frameRef: RefObject<HTMLIFrameElement | null>; onFrameLoad: () => void; isInspecting: boolean; onInspect: () => void; onRefresh: () => void; viewport: "desktop" | "tablet" | "mobile"; setViewport: (value: "desktop" | "tablet" | "mobile") => void; files: string[]; activeFile: string; fileContent: string; onPickFile: (path: string) => void;
  apps: LocalApp[]; activeAppId: string | null; onOpenApp: (id: string) => void; onNewApp: () => void;
};

function Studio(props: StudioProps) {
  const { projectName, runtimeCopy, previewStatus, turnStatus, messages, activities, selected, setSelected, submitFollowup, requestError, activeTab, setActiveTab, previewUrl, frameRef, onFrameLoad, isInspecting, onInspect, onRefresh, viewport, setViewport, files, activeFile, fileContent, onPickFile, apps, activeAppId, onOpenApp, onNewApp } = props;
  const [prompt, setPrompt] = useState("");
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [appsOpen, setAppsOpen] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const submit = (event: FormEvent) => { event.preventDefault(); submitFollowup(prompt); setPrompt(""); };
  return <main className="studio-shell">
    <header className="studio-topbar"><div className="wordmark"><Mark />Sketch</div><div className="project-crumb"><span className="project-dot" />{projectName}<span className="slash">/</span><span className={`runtime ${previewStatus}`}>{runtimeCopy}</span></div><button className="reset-button" onClick={onNewApp}>+ New app</button></header>
    <div className={`studio-grid ${appsOpen ? "apps-open" : "apps-collapsed"}`}>
      <AppsSidebar apps={apps} activeAppId={activeAppId} open={appsOpen} onToggle={() => setAppsOpen(current => !current)} onOpenApp={onOpenApp} onNewApp={onNewApp} />
      <aside className="agent-panel">
        <div className="agent-heading"><div><span className="agent-avatar">S</span><div><strong>Sketch Agent</strong><small>{turnStatus === "running" ? "Working in your workspace" : "Ready for direction"}</small></div></div><button aria-label="Panel menu">•••</button></div>
        <div className="thread" aria-live="polite">
          {messages.length === 0 && <div className="empty-thread"><div className="spark">✦</div><h2>Your canvas is ready.</h2><p>Describe the next change, or point at something in Preview.</p></div>}
          {messages.map((message) => <article className={`message ${message.role}`} key={message.id}><div className="message-label">{message.role === "user" ? "You" : "Sketch"}</div><p>{message.content}</p>{message.selection && <SelectionPill selection={message.selection} />}{message.isWorking && <span className="typing"><i /><i /><i /></span>}</article>)}
          <ThinkingPanel activities={activities} open={thinkingOpen} onToggle={() => setThinkingOpen((current) => !current)} />
        </div>
        <form className="studio-composer" onSubmit={submit}>
          {selected && <div className="selection-chip"><span className="target-icon">⌖</span><div><strong>{selected.text || selected.tagName.toLowerCase()}</strong><small>{selected.source?.file ?? "Approximate element match"}</small></div><button type="button" onClick={() => setSelected(null)} aria-label="Remove selected element">×</button></div>}
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={selected ? "Describe the change to this element…" : "Make a change, add a feature, ask anything…"} rows={3} disabled={turnStatus === "running"} />
          <div className="composer-actions"><span className="attach-hint">{selected ? "Selection included" : "Use Inspect to target an element"}</span><button className="send-button" aria-label="Send request" disabled={!prompt.trim() || turnStatus === "running"}>↑</button></div>
          {requestError && <div className="request-error">{requestError}</div>}
        </form>
      </aside>
      <section className="workspace-panel">
        <div className="workspace-bar"><div className="tabs"><button className={`preview-tab ${activeTab === "preview" ? "active" : ""}`} onClick={() => setActiveTab("preview")}><span>●</span> Preview</button><button className={`code-tab ${activeTab === "code" ? "active" : ""}`} onClick={() => setActiveTab("code")}><span>⌘</span> Code</button></div>
          {activeTab === "preview" && <PreviewControls viewport={viewport} setViewport={setViewport} onRefresh={onRefresh} onFullscreen={() => setIsFullscreen(true)} isInspecting={isInspecting} onInspect={onInspect} previewReady={!!previewUrl} />}
        </div>
        {activeTab === "preview" ? <PreviewPane previewUrl={previewUrl} status={previewStatus} viewport={viewport} frameRef={frameRef} onFrameLoad={onFrameLoad} /> : <CodePane files={files} activeFile={activeFile} content={fileContent} onPickFile={onPickFile} />}
      </section>
    </div>
    {isFullscreen && <FullscreenPreview projectName={projectName} previewUrl={previewUrl} status={previewStatus} viewport={viewport} setViewport={setViewport} frameRef={frameRef} onFrameLoad={onFrameLoad} onClose={() => setIsFullscreen(false)} onRefresh={onRefresh} />}
  </main>;
}

function SelectionPill({ selection }: { selection: ElementSelection }) { return <div className="message-selection"><span>⌖</span><div><strong>{selection.text || selection.tagName.toLowerCase()}</strong><small>{selection.source?.file ?? "Approximate source"}</small></div></div>; }

function ThinkingPanel({ activities, open, onToggle }: { activities: Activity[]; open: boolean; onToggle: () => void }) {
  const items = activities.slice(-18).reverse();
  const stateFor = (activity: Activity) => activity.tone === "danger" ? "attention" : activity.tone === "success" || /complete|updated|ready|live/i.test(activity.title) ? "complete" : "working";
  const labelFor = (title: string) => title === "command_execution" ? "Ran a workspace command" : title === "command_execution complete" ? "Workspace command finished" : title === "agent_message" || title === "agent_message complete" ? "Codex update" : title.replaceAll("_", " ");
  const activeCount = items.filter((activity) => stateFor(activity) === "working").length;
  return <section className={`thinking-panel ${open ? "open" : ""}`}>
    <button className="thinking-toggle" type="button" onClick={onToggle} aria-expanded={open}>
      <span className="thinking-toggle-icon">✦</span><span><strong>Thinking</strong><small>{activeCount ? `${activeCount} step${activeCount === 1 ? "" : "s"} in progress` : `${items.length} activity updates`}</small></span><b>{open ? "−" : "+"}</b>
    </button>
    {open && <div className="thinking-list">{items.length ? items.map((activity) => { const state = stateFor(activity); return <div className={`thinking-item ${state}`} key={activity.id}><span>{state === "complete" ? "✓" : state === "attention" ? "!" : "·"}</span><div><strong>{labelFor(activity.title)}</strong>{activity.detail && <small>{activity.detail}</small>}</div><em>{state === "attention" ? "needs attention" : state}</em></div>; }) : <p>No agent activity yet.</p>}</div>}
  </section>;
}

function AppsSidebar({ apps, activeAppId, open, onToggle, onOpenApp, onNewApp }: { apps: LocalApp[]; activeAppId: string | null; open: boolean; onToggle: () => void; onOpenApp: (id: string) => void; onNewApp: () => void }) {
  return <aside className={`apps-sidebar ${open ? "open" : "collapsed"}`}>
    <div className="apps-sidebar-head"><button className="apps-collapse" onClick={onToggle} aria-label={open ? "Collapse app list" : "Expand app list"}>☰</button>{open && <strong>Apps</strong>}<button className="apps-new" onClick={onNewApp} title="Create a new app">+</button></div>
    <nav className="apps-list" aria-label="Local apps">{apps.length ? apps.map(app => <button className={app.id === activeAppId ? "active" : ""} key={app.id} onClick={() => onOpenApp(app.id)} title={app.name}><span>{app.name.slice(0, 1).toUpperCase()}</span>{open && <div><strong>{app.name}</strong><small>{new Date(app.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</small></div>}</button>) : <p>{open ? "Your saved apps will appear here." : ""}</p>}</nav>
    {open && <button className="apps-create" onClick={onNewApp}><span>+</span> Create new app</button>}
  </aside>;
}

type Viewport = "desktop" | "tablet" | "mobile";

function PreviewControls({ viewport, setViewport, onRefresh, onFullscreen, isInspecting, onInspect, previewReady }: { viewport: Viewport; setViewport: (value: Viewport) => void; onRefresh: () => void; onFullscreen: () => void; isInspecting?: boolean; onInspect?: () => void; previewReady?: boolean }) {
  return <div className="preview-controls"><div className="viewport-toggle" aria-label="Preview size"><button className={viewport === "desktop" ? "active" : ""} onClick={() => setViewport("desktop")} title="Desktop">▣<span>Desktop</span></button><button className={viewport === "tablet" ? "active" : ""} onClick={() => setViewport("tablet")} title="Tablet">▤<span>Tablet</span></button><button className={viewport === "mobile" ? "active" : ""} onClick={() => setViewport("mobile")} title="Mobile">▯<span>Mobile</span></button></div><button onClick={onRefresh} title="Refresh preview">↻</button><button onClick={onFullscreen} title="Open fullscreen preview">⛶</button>{onInspect && <button className={isInspecting ? "inspect active" : "inspect"} onClick={onInspect} disabled={!previewReady}>{isInspecting ? "Inspecting" : "Inspect"} <span>⌖</span></button>}</div>;
}

function FullscreenPreview({ projectName, previewUrl, status, viewport, setViewport, frameRef, onFrameLoad, onClose, onRefresh }: { projectName: string; previewUrl: string | null; status: PreviewStatus; viewport: Viewport; setViewport: (value: Viewport) => void; frameRef: RefObject<HTMLIFrameElement | null>; onFrameLoad: () => void; onClose: () => void; onRefresh: () => void }) {
  return <section className="fullscreen-preview" aria-label="Fullscreen application preview"><header><button onClick={onClose}>← Exit</button><strong>{projectName}</strong><div><PreviewControls viewport={viewport} setViewport={setViewport} onRefresh={onRefresh} onFullscreen={onClose} /><button className="fullscreen-close" onClick={onClose} title="Exit fullscreen">⛶</button></div></header><PreviewPane previewUrl={previewUrl} status={status} viewport={viewport} frameRef={frameRef} onFrameLoad={onFrameLoad} fullscreen /></section>;
}

function PreviewPane({ previewUrl, status, viewport, frameRef, onFrameLoad, fullscreen = false }: { previewUrl: string | null; status: PreviewStatus; viewport: Viewport; frameRef: RefObject<HTMLIFrameElement | null>; onFrameLoad: () => void; fullscreen?: boolean }) {
  if (!previewUrl) return <div className="preview-empty"><div className="preview-empty-art"><span>✦</span><i /><i /><i /></div><h2>{status === "failed" ? "Preview needs a repair" : "Your preview is getting ready"}</h2><p>{status === "failed" ? "Check the activity log for the runtime message." : "Sketch will load the live Vite app as soon as it is available."}</p><div className="loading-line"><b /></div></div>;
  return <div className={`preview-stage ${viewport} ${fullscreen ? "fullscreen-stage" : ""}`}><div className="preview-chrome"><span /><span /><span /><div>{new URL(previewUrl).host}</div><iframe ref={frameRef} src={previewUrl} title="Generated application preview" sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock" referrerPolicy="no-referrer" onLoad={onFrameLoad} /></div></div>;
}

function CodePane({ files, activeFile, content, onPickFile }: { files: string[]; activeFile: string; content: string; onPickFile: (path: string) => void }) {
  const source = content || "// Source will appear here when your project is ready.";
  return <div className="code-pane"><aside className="file-tree"><div className="file-tree-title">Workspace files</div>{files.length ? files.map((file) => <button key={file} className={file === activeFile ? "selected" : ""} onClick={() => onPickFile(file)}><span>{file.endsWith(".tsx") ? "◇" : file.endsWith(".css") ? "#" : "·"}</span>{file}</button>) : <p>Files will appear after the first edit.</p>}</aside><article className="code-view"><header><span>{activeFile || "No file selected"}</span><small>Read-only</small></header><pre><code>{source.split("\n").map((line, index) => <span className="code-line" key={`${index}-${line}`}><i>{index + 1}</i><b>{highlight(line)}</b></span>)}</code></pre></article></div>;
}

function highlight(line: string): ReactNode[] {
  const tokenPattern = /(\/\/.*$|\/\*.*?\*\/|`(?:\\.|[^`])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:import|from|export|default|const|let|function|return|if|else|type|interface|extends|new|async|await|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b)/g;
  const output: ReactNode[] = []; let last = 0;
  for (const match of line.matchAll(tokenPattern)) {
    const value = match[0]; const index = match.index ?? 0;
    if (index > last) output.push(line.slice(last, index));
    const kind = value.startsWith("//") || value.startsWith("/*") ? "comment" : value.startsWith("\"") || value.startsWith("'") || value.startsWith("`") ? "string" : /^\d/.test(value) ? "number" : "keyword";
    output.push(<span className={`token-${kind}`} key={`${index}-${value}`}>{value}</span>); last = index + value.length;
  }
  if (last < line.length) output.push(line.slice(last));
  return output;
}

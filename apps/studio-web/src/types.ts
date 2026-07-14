export type PreviewStatus = "stopped" | "starting" | "ready" | "failed";
export type TurnStatus = "idle" | "running" | "succeeded" | "failed" | "cancelled";

export type ElementSelection = {
  elementId: string | null;
  tagName: string;
  text: string;
  classNames: string[];
  source: { file: string } | null;
  outerHTML: string;
  rect: { x: number; y: number; width: number; height: number };
};

export type StudioEvent =
  | { type: "session.snapshot"; session: SessionProjection }
  | { type: "turn.started"; turnId: string }
  | { type: "activity.updated"; title: string; detail?: string }
  | { type: "files.changed"; paths: string[] }
  | { type: "turn.completed"; summary: string }
  | { type: "turn.failed"; message: string }
  | { type: "turn.cancelled" }
  | { type: "preview.starting" }
  | { type: "preview.ready"; url: string; origin: string }
  | { type: "preview.failed"; message: string };

export type Activity = { id: string; title: string; detail?: string; tone?: "normal" | "success" | "danger" };

export type ChatMessage = {
  id: string;
  role: "user" | "agent";
  content: string;
  selection?: ElementSelection;
  isWorking?: boolean;
};

export type SessionProjection = {
  workspaceId?: string;
  projectName?: string | null;
  turnStatus?: TurnStatus;
  previewStatus?: PreviewStatus;
  previewUrl?: string | null;
  previewOrigin?: string | null;
};

export type LocalApp = {
  id: string;
  name: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
};

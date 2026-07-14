import { elementSelectionSchema, turnRequestSchema } from "@sketch/contracts";
import { z } from "zod";

export const turnStatusSchema = z.enum(["idle", "running", "succeeded", "failed", "cancelled"]);
export const previewStatusSchema = z.enum(["stopped", "starting", "ready", "failed"]);

export type ElementSelection = z.infer<typeof elementSelectionSchema>;

export const createProjectSchema = z.object({ prompt: z.string().trim().min(3).max(12_000) });
export const createTurnSchema = turnRequestSchema;

export type StudioEvent =
  | { type: "session.snapshot"; session: SessionSnapshot }
  | { type: "turn.started"; turnId: string }
  | { type: "activity.updated"; title: string; detail?: string }
  | { type: "files.changed"; paths: string[] }
  | { type: "turn.completed"; summary: string }
  | { type: "turn.failed"; message: string }
  | { type: "turn.cancelled" }
  | { type: "preview.starting" }
  | { type: "preview.ready"; url: string; origin: string }
  | { type: "preview.failed"; message: string };

export type SessionSnapshot = {
  workspaceId: string;
  projectName: string | null;
  threadId: string | null;
  turnStatus: z.infer<typeof turnStatusSchema>;
  previewStatus: z.infer<typeof previewStatusSchema>;
  previewUrl: string | null;
  previewOrigin: string | null;
  initialPrompt: string | null;
  selectedElement: ElementSelection | null;
};

import { z } from "zod";

const boundedText = (limit: number) => z.string().trim().max(limit);

export const sessionNonceSchema = z.string().min(24).max(256).regex(/^[A-Za-z0-9_-]+$/);

export const rectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});

export const sourceAnnotationSchema = z.object({
  file: z.string().trim().min(1).max(500).refine(
    (value) => !value.startsWith("/") && !value.split("/").includes(".."),
    "Source path must be workspace-relative",
  ),
});

export const elementSelectionSchema = z.object({
  elementId: z.string().trim().min(1).max(160).nullable(),
  tagName: z.string().trim().min(1).max(40),
  text: boundedText(600),
  classNames: z.array(z.string().trim().min(1).max(120)).max(40),
  source: sourceAnnotationSchema.nullable(),
  outerHTML: boundedText(3000),
  rect: rectSchema,
});

export const inspectorEnableMessageSchema = z.object({
  type: z.literal("INSPECTOR_ENABLE"),
  sessionNonce: sessionNonceSchema,
});

export const inspectorDisableMessageSchema = z.object({
  type: z.literal("INSPECTOR_DISABLE"),
  sessionNonce: sessionNonceSchema,
});

export const parentToPreviewMessageSchema = z.discriminatedUnion("type", [
  inspectorEnableMessageSchema,
  inspectorDisableMessageSchema,
]);

export const previewReadyMessageSchema = z.object({
  type: z.literal("PREVIEW_READY"),
  sessionNonce: sessionNonceSchema,
});

export const elementSelectedMessageSchema = z.object({
  type: z.literal("ELEMENT_SELECTED"),
  sessionNonce: sessionNonceSchema,
  selection: elementSelectionSchema,
});

export const previewRuntimeErrorMessageSchema = z.object({
  type: z.literal("PREVIEW_RUNTIME_ERROR"),
  sessionNonce: sessionNonceSchema,
  message: boundedText(800),
});

export const previewToParentMessageSchema = z.discriminatedUnion("type", [
  previewReadyMessageSchema,
  elementSelectedMessageSchema,
  previewRuntimeErrorMessageSchema,
]);

export const turnRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(20_000),
  selection: elementSelectionSchema.nullable().optional(),
});

export const studioEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn.started"), turnId: z.string().min(1).max(160) }),
  z.object({ type: z.literal("activity.updated"), title: boundedText(300), detail: boundedText(2_000).optional() }),
  z.object({ type: z.literal("files.changed"), paths: z.array(z.string().min(1).max(500)).max(300) }),
  z.object({ type: z.literal("turn.completed"), summary: boundedText(2_000) }),
  z.object({ type: z.literal("turn.failed"), message: boundedText(2_000) }),
  z.object({ type: z.literal("turn.cancelled") }),
  z.object({ type: z.literal("preview.starting") }),
  z.object({ type: z.literal("preview.ready"), url: z.string().url(), origin: z.string().url() }),
  z.object({ type: z.literal("preview.failed"), message: boundedText(2_000) }),
]);

export type ElementSelection = z.infer<typeof elementSelectionSchema>;
export type ParentToPreviewMessage = z.infer<typeof parentToPreviewMessageSchema>;
export type PreviewToParentMessage = z.infer<typeof previewToParentMessageSchema>;
export type StudioEvent = z.infer<typeof studioEventSchema>;
export type TurnRequest = z.infer<typeof turnRequestSchema>;

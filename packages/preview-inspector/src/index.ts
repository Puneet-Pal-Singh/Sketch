import {
  elementSelectionSchema,
  parentToPreviewMessageSchema,
  type ElementSelection,
} from "@sketch/contracts";

const OVERLAY_ATTRIBUTE = "data-sketch-inspector-overlay";
const MAX_TEXT_LENGTH = 600;
const MAX_HTML_LENGTH = 3000;

type InspectorState = {
  active: boolean;
  nonce: string | null;
  parentOrigin: string | null;
  overlay: HTMLDivElement | null;
  label: HTMLDivElement | null;
  hovered: Element | null;
};

const state: InspectorState = {
  active: false,
  nonce: null,
  parentOrigin: null,
  overlay: null,
  label: null,
  hovered: null,
};

function truncate(value: string, length: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= length ? normalized : `${normalized.slice(0, Math.max(0, length - 1))}…`;
}

function elementAtPoint(event: PointerEvent | MouseEvent): Element | null {
  return document.elementFromPoint(event.clientX, event.clientY);
}

function isEligible(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element === document.documentElement || element === document.body || element === document.getElementById("root")) return false;
  if (element.closest(`[${OVERLAY_ATTRIBUTE}]`)) return false;
  if (element.closest("canvas")) return false;

  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width >= 2 && rect.height >= 2 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
}

function createOverlay(): void {
  if (state.overlay) return;
  const overlay = document.createElement("div");
  overlay.setAttribute(OVERLAY_ATTRIBUTE, "true");
  Object.assign(overlay.style, {
    position: "fixed",
    zIndex: "2147483647",
    pointerEvents: "none",
    border: "2px solid #ff8a38",
    background: "rgba(255, 138, 56, 0.13)",
    borderRadius: "5px",
    display: "none",
    boxSizing: "border-box",
    transition: "all 70ms ease-out",
  });

  const label = document.createElement("div");
  label.setAttribute(OVERLAY_ATTRIBUTE, "true");
  Object.assign(label.style, {
    position: "absolute",
    top: "-29px",
    left: "-2px",
    padding: "5px 8px",
    borderRadius: "6px 6px 6px 0",
    background: "#ff8a38",
    color: "#1a0c03",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "11px",
    fontWeight: "700",
    lineHeight: "14px",
    letterSpacing: "0.02em",
    whiteSpace: "nowrap",
    boxShadow: "0 8px 18px rgba(0,0,0,.28)",
  });
  overlay.append(label);
  document.body.append(overlay);
  state.overlay = overlay;
  state.label = label;
}

function hideOverlay(): void {
  if (state.overlay) state.overlay.style.display = "none";
  state.hovered = null;
}

function showOverlay(element: HTMLElement): void {
  createOverlay();
  const rect = element.getBoundingClientRect();
  if (!state.overlay || !state.label) return;
  state.overlay.style.display = "block";
  state.overlay.style.left = `${Math.round(rect.left)}px`;
  state.overlay.style.top = `${Math.round(rect.top)}px`;
  state.overlay.style.width = `${Math.round(rect.width)}px`;
  state.overlay.style.height = `${Math.round(rect.height)}px`;
  state.label.textContent = `<${element.tagName.toLowerCase()}>`;
  state.hovered = element;
}

function postToParent(payload: object): void {
  if (!state.nonce || !state.parentOrigin || window.parent === window) return;
  window.parent.postMessage(payload, state.parentOrigin);
}

function getSelection(element: HTMLElement): ElementSelection {
  const annotation = element.closest<HTMLElement>("[data-studio-id], [data-studio-source]");
  const sourceFile = annotation?.dataset.studioSource?.trim() || null;
  const rect = element.getBoundingClientRect();
  const selection: ElementSelection = {
    elementId: annotation?.dataset.studioId?.trim() || null,
    tagName: element.tagName.toLowerCase(),
    text: truncate(element.innerText || element.textContent || "", MAX_TEXT_LENGTH),
    classNames: Array.from(element.classList).filter(Boolean).slice(0, 40),
    source: sourceFile ? { file: sourceFile } : null,
    outerHTML: truncate(element.outerHTML, MAX_HTML_LENGTH),
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
  return elementSelectionSchema.parse(selection);
}

function onPointerMove(event: PointerEvent): void {
  if (!state.active) return;
  const target = elementAtPoint(event);
  if (!isEligible(target)) {
    hideOverlay();
    return;
  }
  if (state.hovered !== target) showOverlay(target);
}

function onClick(event: MouseEvent): void {
  if (!state.active) return;
  const target = elementAtPoint(event);
  if (!isEligible(target)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  try {
    const selection = getSelection(target);
    postToParent({ type: "ELEMENT_SELECTED", sessionNonce: state.nonce, selection });
  } catch (error) {
    postToParent({
      type: "PREVIEW_RUNTIME_ERROR",
      sessionNonce: state.nonce,
      message: error instanceof Error ? truncate(error.message, 800) : "Unable to inspect this element.",
    });
  }
}

function onRuntimeError(event: ErrorEvent | PromiseRejectionEvent): void {
  if (!state.active) return;
  const reason = event instanceof ErrorEvent ? event.message : String(event.reason ?? "Unhandled preview error");
  postToParent({
    type: "PREVIEW_RUNTIME_ERROR",
    sessionNonce: state.nonce,
    message: truncate(reason || "Unhandled preview error", 800),
  });
}

function enable(nonce: string, origin: string): void {
  state.active = true;
  state.nonce = nonce;
  state.parentOrigin = origin;
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("click", onClick, true);
  window.addEventListener("error", onRuntimeError);
  window.addEventListener("unhandledrejection", onRuntimeError);
  postToParent({ type: "PREVIEW_READY", sessionNonce: nonce });
}

function disable(): void {
  state.active = false;
  hideOverlay();
  document.removeEventListener("pointermove", onPointerMove, true);
  document.removeEventListener("click", onClick, true);
  window.removeEventListener("error", onRuntimeError);
  window.removeEventListener("unhandledrejection", onRuntimeError);
}

function onParentMessage(event: MessageEvent<unknown>): void {
  if (event.source !== window.parent || window.parent === window) return;
  const parsed = parentToPreviewMessageSchema.safeParse(event.data);
  if (!parsed.success) return;
  if (parsed.data.type === "INSPECTOR_ENABLE") {
    enable(parsed.data.sessionNonce, event.origin);
    return;
  }
  if (state.nonce === parsed.data.sessionNonce && state.parentOrigin === event.origin) disable();
}

/** Installs the development-only parent-controlled inspector exactly once. */
export function installPreviewInspector(): () => void {
  window.addEventListener("message", onParentMessage);
  return () => {
    disable();
    window.removeEventListener("message", onParentMessage);
    state.overlay?.remove();
    state.overlay = null;
    state.label = null;
    state.nonce = null;
    state.parentOrigin = null;
  };
}

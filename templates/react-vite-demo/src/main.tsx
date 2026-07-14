import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installPreviewInspector } from "@sketch/preview-inspector";
import App from "./App";
import "./styles.css";

if (import.meta.env.DEV) installPreviewInspector();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

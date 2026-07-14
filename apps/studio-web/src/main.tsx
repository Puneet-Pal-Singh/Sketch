import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { SketchApp } from "./sketch-app";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SketchApp />
  </StrictMode>,
);

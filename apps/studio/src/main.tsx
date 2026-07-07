/**
 * studio
 *
 * Visual editor application for authoring Cadra scenes: the studio shell
 * (layout, state store, project open/save/new) that hosts the Phase 14
 * preview and the timeline/inspector/asset panels later phases fill in.
 *
 * This is the real browser entry point (bootstrapped via Vite/React),
 * superseding this package's earlier placeholder scaffold (a bare `main.ts`
 * exporting a version constant, no UI at all).
 */
import "./studio-shell.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";

const container = document.getElementById("root");
if (container === null) {
  throw new Error('studio: no element with id "root" found to mount the app into.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import { ConvexProvider, ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CloudProvider, PanelLive, PetLive } from "./live";
import "./styles.css";
import "./screens.css";

// One renderer, three windows; the main process picks the view with the URL hash.
const view = location.hash === "#pet" ? "pet" : location.hash === "#panel" ? "panel" : "app";
document.documentElement.dataset["view"] = view;

const convex = new ConvexReactClient(import.meta.env.CONVEX_URL);
// The OS reports the network is back: one hand-off pass in the main process (an event, not a timer).
if (view === "app") window.addEventListener("online", () => void window.companion.cloudOnline());

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <CloudProvider>{view === "pet" ? <PetLive /> : view === "panel" ? <PanelLive /> : <App />}</CloudProvider>
    </ConvexProvider>
  </StrictMode>,
);

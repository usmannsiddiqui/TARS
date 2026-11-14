import { ConvexProvider, ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const convex = new ConvexReactClient(import.meta.env.CONVEX_URL);
// The OS reports the network is back: one hand-off pass in the main process (an event, not a timer).
window.addEventListener("online", () => void window.companion.cloudOnline());

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <App />
    </ConvexProvider>
  </StrictMode>,
);

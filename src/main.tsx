import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
import { installOverlayScroll } from "./lib/overlay-scroll";
import { applySpaceCorner, loadSpaceCorner } from "./lib/prefs";
import { applyTheme, loadTheme } from "./lib/theme";
import { AppProvider } from "./state/app-state";

applyTheme(loadTheme());
applySpaceCorner(loadSpaceCorner());
installOverlayScroll();

const root = document.querySelector("#app");
if (!root) throw new Error("#app missing");

createRoot(root).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>,
);

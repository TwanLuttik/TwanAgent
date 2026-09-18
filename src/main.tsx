import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
import { installDocumentScrollLock } from "./lib/document-scroll";
import { installOverlayScroll } from "./lib/overlay-scroll";
import { applyFileHoverCard, applySpaceCorner, loadFileHoverCard, loadSpaceCorner } from "./lib/prefs";
import { applyTheme, loadTheme } from "./lib/theme";
import { AppProvider } from "./state/app-state";

applyTheme(loadTheme());
applySpaceCorner(loadSpaceCorner());
applyFileHoverCard(loadFileHoverCard());
installOverlayScroll();
installDocumentScrollLock();

const root = document.querySelector("#app");
if (!root) throw new Error("#app missing");

createRoot(root).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>,
);

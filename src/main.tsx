import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
import { installDocumentScrollLock } from "./lib/document-scroll";
import { installOverlayScroll } from "./lib/overlay-scroll";
import { applyFileHoverCard, applySpaceCorner, loadFileHoverCard, loadSpaceCorner } from "./lib/prefs";
import { applyStoredTheme, applyTheme, loadTheme, serializeTheme, THEME_SETTING_KEY } from "./lib/theme";
import { getAppSetting, setAppSetting } from "./lib/tauri";
import { AppProvider } from "./state/app-state";

applyTheme(loadTheme());
void getAppSetting(THEME_SETTING_KEY)
  .then((stored) => {
    if (stored) {
      applyStoredTheme(stored);
      return;
    }
    const local = localStorage.getItem("twanagent.theme");
    if (local) void setAppSetting(THEME_SETTING_KEY, local);
    else void setAppSetting(THEME_SETTING_KEY, serializeTheme(loadTheme()));
  })
  .catch(() => undefined);
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

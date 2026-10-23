import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AppBoundary } from "./components/AppBoundary";
import "./index.css";
import "./window-drag";
import { startAccountUsage } from "./lib/account-usage-store";
import { installDocumentScrollLock } from "./lib/document-scroll";
import { installOverlayScroll } from "./lib/overlay-scroll";
import { applyFileHoverCard, applySpaceCorner, loadFileHoverCard, loadSpaceCorner } from "./lib/prefs";
import { applyStoredTheme, applyTheme, loadTheme, serializeTheme, THEME_SETTING_KEY } from "./lib/theme";
import { getAppSetting, microphoneInfo, setAppSetting } from "./lib/tauri";
import { AppProvider } from "./state/app-state";

applyTheme(loadTheme());
// Allowance checks start before the first paint and keep running while settings
// covers the sidebar. The row only reads the latest snapshot.
startAccountUsage();
void microphoneInfo().catch(() => undefined);
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
      <AppBoundary>
        <App />
      </AppBoundary>
    </AppProvider>
  </StrictMode>,
);

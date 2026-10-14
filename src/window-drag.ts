/**
 * macOS overlay titlebars start a window drag from the top strip. Tauri's
 * listener is on the bubble phase and calls preventDefault before it asks the
 * window to move. This capture listener runs first. preventDefault here makes
 * that call a no-op, and it does not stop the event, so the tab's own drag
 * (dnd-kit, the same library as the sidebar) still receives the press.
 * The empty strip beside the tabs is not matched, so it still moves the window.
 */
const TAB_HOLD = "[data-tab-key], .chrome-tab, .chrome-tab-group";

document.addEventListener(
  "mousedown",
  (event) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(TAB_HOLD)) return;
    event.preventDefault();
  },
  true,
);

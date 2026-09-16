import { createTerminalSessionStore } from "./dev-terminal-chat";
import * as api from "./tauri";

export const terminalSessions = createTerminalSessionStore({
  openGrok: (workspace, cols, rows) => api.devPtyOpenGrok(workspace, cols, rows),
  kill: (id) => api.devPtyKill(id),
  listen: (fn) => api.onDevPty(fn),
});

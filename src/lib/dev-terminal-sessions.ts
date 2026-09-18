import { createTerminalSessionStore } from "./dev-terminal-chat";
import * as api from "./tauri";

export const terminalSessions = createTerminalSessionStore({
  openGrok: (workspace, cols, rows, sessionId) => api.devPtyOpenGrok(workspace, cols, rows, sessionId),
  kill: (id) => api.devPtyKill(id),
  listen: (fn) => api.onDevPty(fn),
});

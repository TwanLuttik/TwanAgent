import { createTerminalSessionStore } from "./terminal-chat";
import * as api from "./tauri";

export const terminalSessions = createTerminalSessionStore({
  openGrok: (workspace, cols, rows, sessionId) => api.ptyOpenGrok(workspace, cols, rows, sessionId),
  kill: (id) => api.ptyKill(id),
  listen: (fn) => api.onPty(fn),
});

import { createShellSessionStore } from "./shell-sessions.ts";
import * as api from "./tauri";

export const shellSessions = createShellSessionStore({
  open: (workspace, cols, rows) => api.ptyOpen(workspace, cols, rows),
  write: (id, data) => api.ptyWrite(id, data),
  writeBytes: (id, data) => api.ptyWriteBytes(id, data),
  resize: (id, cols, rows) => api.ptyResize(id, cols, rows),
  kill: (id) => api.ptyKill(id),
  listen: (fn) => api.onPty(fn),
});

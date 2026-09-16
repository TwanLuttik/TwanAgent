export const PERMISSION_MODES = [
  { id: "ask", label: "Ask" },
  { id: "approve-all", label: "Approve all" },
  { id: "read-only", label: "Read only" },
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number]["id"];

const WRITE_TOOLS = new Set(["write_file", "edit_file", "run_command"]);

export function parsePermissionMode(raw: unknown): PermissionMode {
  if (raw === "ask" || raw === "approve-all" || raw === "read-only") return raw;
  return "ask";
}

export function permissionLabel(mode: PermissionMode): string {
  return PERMISSION_MODES.find((item) => item.id === mode)?.label ?? "Ask";
}

export function toolDeniedByPermission(mode: PermissionMode, tool: string): string | null {
  if (mode === "read-only" && WRITE_TOOLS.has(tool)) {
    return `Error: ${tool} is blocked in read-only mode.`;
  }
  return null;
}

export function shouldPromptShell(mode: PermissionMode): boolean {
  return mode === "ask";
}

export function permissionSystemLine(mode: PermissionMode): string {
  switch (mode) {
    case "approve-all":
      return "Use tools to inspect and edit this folder. File edits and shell commands run without asking.";
    case "read-only":
      return "Use tools to inspect this folder. Read-only: do not edit files or run shell commands.";
    default:
      return "Use tools to inspect and edit this folder. File edits apply immediately. Shell commands require the user to approve.";
  }
}

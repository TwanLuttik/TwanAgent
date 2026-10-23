export const PERMISSION_MODES = [
  {
    id: "ask",
    label: "Ask",
    detail: "Edits apply immediately. Shell commands wait for approval.",
  },
  {
    id: "approve-all",
    label: "Approve all",
    detail: "Edits and shell commands run without asking.",
  },
  {
    id: "read-only",
    label: "Read only",
    detail: "Grok can read this folder, but not edit files or run commands.",
  },
] as const;

/** What each mode does to a tool. The settings screen shows this instead of one sentence. */
export const PERMISSION_ACTIONS = [
  { id: "read", label: "Read files" },
  { id: "edit", label: "Edit files" },
  { id: "shell", label: "Run commands" },
] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number]["id"];
export type PermissionEffect = "allow" | "ask" | "block";

export function permissionEffect(mode: PermissionMode, action: PermissionAction): PermissionEffect {
  if (action === "read") return "allow";
  if (mode === "read-only") return "block";
  if (action === "shell" && mode === "ask") return "ask";
  return "allow";
}

export type PermissionMode = (typeof PERMISSION_MODES)[number]["id"];

const WRITE_TOOLS = new Set(["write_file", "edit_file", "run_command", "git_commit"]);

export function parsePermissionMode(raw: unknown): PermissionMode {
  if (raw === "ask" || raw === "approve-all" || raw === "read-only") return raw;
  return "ask";
}

export function permissionLabel(mode: PermissionMode): string {
  return PERMISSION_MODES.find((item) => item.id === mode)?.label ?? "Ask";
}

export function permissionDetail(mode: PermissionMode): string {
  return PERMISSION_MODES.find((item) => item.id === mode)?.detail ?? PERMISSION_MODES[0].detail;
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
      return "Use tools to inspect this folder. Read-only: do not edit files or run shell commands. Web search is allowed.";
    default:
      return "Use tools to inspect and edit this folder. File edits apply immediately. Shell commands require the user to approve.";
  }
}

export type RemoteWorkspace = {
  machineName: string;
  host: string;
  user: string;
  port: number;
  remotePath: string;
  online: boolean;
  /** Provider ids whose keys were copied to this server. Missing until that lookup returns. */
  providers?: string[];
  /** True when this Mac has paired twanagent-server on that machine. Chats then run there. */
  paired?: boolean;
};

export function remoteWorkspaceLine(remote: RemoteWorkspace | null | undefined): string {
  if (!remote?.machineName || !remote.remotePath) return "";
  return `This folder is on ${remote.machineName} at ${remote.remotePath}. File tools read and write that project. Shell commands run on that server in that directory.`;
}

export function shellApprovalLabel(_command: string, machineName?: string | null): string {
  const target = machineName?.trim();
  return target ? `Run this command on ${target}?` : "Run this command?";
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export const TURN_FAILURE_PREFIX = "Couldn't continue: ";

export type ChatToolCall = { id: string; name: string; arguments: string };

export type ChatImage = {
  id: string;
  path: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  resized: boolean;
  dataUrl?: string;
  /** Local preview while a dropped picture is still being copied. Not saved. */
  previewUrl?: string;
  /** Missing on pictures saved before other files could be attached. */
  kind?: "image" | "file";
  /** Size of a non-image file, in bytes. Pictures leave this unset. */
  bytes?: number;
};

/** One Anthropic thinking block, replayed unmodified on the next request. */
export type ThinkingBlock = {
  type: "thinking" | "redacted_thinking";
  thinking?: string;
  signature?: string;
  data?: string;
};

export type ChatMessage = {
  role: ChatRole;
  content?: string | null;
  /** Display text for this assistant step. Grok does not send it back. */
  reasoning?: string;
  /** Signed Claude thinking blocks. Required, unchanged, on the next Claude request. */
  thinking?: ThinkingBlock[];
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  error?: boolean;
  images?: ChatImage[];
  /** How long this prompt took, in milliseconds. Kept on the final assistant reply. */
  durationMs?: number;
  /** When this reply finished, as an ISO timestamp. Kept on the final assistant reply. */
  finishedAt?: string;
};

export const HEAVY_DIRS = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  ".git",
  "__pycache__",
  ".next",
  ".turbo",
]);

import { invoke } from "@tauri-apps/api/core";

export type KeyStatus = { saved: boolean; env: boolean };
export type Effort = { id: string; label: string; detail?: string };
export type ModelProvider = "xai" | "anthropic" | "minimax" | string;

export type Model = {
  id: string;
  name: string;
  efforts: Effort[];
  context_window?: number | null;
  context_windows?: number[] | null;
  provider?: ModelProvider;
  /** Claude capability ids: vision, thinking, pdf, effort. */
  capabilities?: string[] | null;
};
export type ProviderStatus = {
  id: string;
  ready: boolean;
  hint: string;
};

export type Runtime = {
  installed: boolean;
  logged_in: boolean;
  version: string | null;
  email: string | null;
  default_model: string;
  default_effort: string;
  models: Model[];
  has_key: boolean;
  ready: boolean;
  hint: string;
  providers?: ProviderStatus[];
};

export function runtime(): Promise<Runtime> {
  return invoke("dev_runtime");
}

/** The runtime painted last launch. Null until one probe has finished. */
export function runtimeCached(): Promise<Runtime | null> {
  return invoke("dev_runtime_cached");
}

export type GrokCliInfo = {
  installed: boolean;
  path: string;
  version: string | null;
  logged_in: boolean;
  email: string | null;
  /** A newer release than `version`. Empty when this install is current. */
  update?: string;
};

export function cliInfo(): Promise<GrokCliInfo> {
  return invoke("dev_cli_info");
}

export type ClaudeCliInfo = {
  installed: boolean;
  path: string;
  version: string | null;
  logged_in: boolean;
  email: string | null;
  /** A newer release than `version`. Empty when this install is current. */
  update?: string;
};

export function claudeCliInfo(): Promise<ClaudeCliInfo> {
  return invoke("dev_claude_cli_info");
}

export type MinimaxCliInfo = {
  installed: boolean;
  path: string;
  version: string | null;
  logged_in: boolean;
  email: string | null;
  /** A newer release than `version`. Empty when this install is current. */
  update?: string;
};

export function minimaxCliInfo(): Promise<MinimaxCliInfo> {
  return invoke("dev_minimax_cli_info");
}

/** Install the newer CLI with that CLI's own updater, then return the version now on disk. */
export function cliUpdate(provider: "xai" | "anthropic" | "minimax"): Promise<GrokCliInfo> {
  return invoke("dev_cli_update", { provider });
}

export type ApiAccountUsageWindow = {
  id: string;
  label: string;
  used_percent: number;
  resets_at?: string | null;
};

export type ApiAccountUsage = {
  provider: string;
  connected: boolean;
  label: string;
  windows: ApiAccountUsageWindow[];
};

/** Allowance on the signed-in Claude account. Disconnected when Claude is not logged in. */
export function accountUsage(): Promise<ApiAccountUsage> {
  return invoke("dev_account_usage");
}

/** The last Claude allowance saved in the app database. Null until one has loaded. */
export function accountUsageCached(): Promise<ApiAccountUsage | null> {
  return invoke("dev_account_usage_cached");
}

/** Token-plan quota, or a pay-as-you-go balance, for the signed-in MiniMax account. */
export function minimaxAccountUsage(): Promise<ApiAccountUsage> {
  return invoke("dev_minimax_account_usage");
}

/** The last MiniMax allowance saved in the app database. Null until one has loaded. */
export function minimaxAccountUsageCached(): Promise<ApiAccountUsage | null> {
  return invoke("dev_minimax_account_usage_cached");
}

/** Weekly pool, or a prepaid balance, for the signed-in Grok account. An API key has neither. */
export function xaiAccountUsage(): Promise<ApiAccountUsage> {
  return invoke("dev_xai_account_usage");
}

/** The last Grok allowance saved in the app database. Null until one has loaded. */
export function xaiAccountUsageCached(): Promise<ApiAccountUsage | null> {
  return invoke("dev_xai_account_usage_cached");
}

/** Prepaid credits, monthly cap, and the token window from the last GPT reply. */
export function openaiAccountUsage(): Promise<ApiAccountUsage> {
  return invoke("dev_openai_account_usage");
}

/** The last GPT allowance saved in the app database. Null until one has loaded. */
export function openaiAccountUsageCached(): Promise<ApiAccountUsage | null> {
  return invoke("dev_openai_account_usage_cached");
}

export type ApiAccountUsageSample = {
  provider: string;
  window_id: string;
  resets_at: string;
  used_percent: number;
  recorded_at: string;
};

/** Allowance readings saved each time an account refreshes. Oldest first. */
export function accountUsageHistory(): Promise<ApiAccountUsageSample[]> {
  return invoke("dev_account_usage_history");
}

export type UsageDbInfo = {
  path: string;
  bytes: number;
  exists: boolean;
};

export function usageDbInfo(): Promise<UsageDbInfo> {
  return invoke("dev_usage_db_info");
}

export function usageDbReset(): Promise<UsageDbInfo> {
  return invoke("dev_usage_db_reset");
}

export function usageDbOpen(): Promise<void> {
  return invoke("dev_usage_db_open");
}

export function openedWorkspaces(): Promise<string[]> {
  return invoke("dev_opened_workspaces");
}

export function forgetWorkspace(path: string): Promise<boolean> {
  return invoke("dev_forget_workspace", { path });
}

export function keyStatus(): Promise<KeyStatus> {
  return invoke("dev_key_status");
}

export function setKey(key: string): Promise<KeyStatus> {
  return invoke("dev_set_key", { key });
}

export function clearKey(): Promise<KeyStatus> {
  return invoke("dev_clear_key");
}

export function anthropicKeyStatus(): Promise<KeyStatus> {
  return invoke("dev_anthropic_key_status");
}

export function setAnthropicKey(key: string): Promise<KeyStatus> {
  return invoke("dev_set_anthropic_key", { key });
}

export function clearAnthropicKey(): Promise<KeyStatus> {
  return invoke("dev_clear_anthropic_key");
}

export function minimaxKeyStatus(): Promise<KeyStatus> {
  return invoke("dev_minimax_key_status");
}

export function setMinimaxKey(key: string): Promise<KeyStatus> {
  return invoke("dev_set_minimax_key", { key });
}

export function clearMinimaxKey(): Promise<KeyStatus> {
  return invoke("dev_clear_minimax_key");
}

export function openAiKeyStatus(): Promise<KeyStatus> {
  return invoke("dev_openai_key_status");
}

export function setOpenAiKey(key: string): Promise<KeyStatus> {
  return invoke("dev_set_openai_key", { key });
}

export function clearOpenAiKey(): Promise<KeyStatus> {
  return invoke("dev_clear_openai_key");
}

import { useCallback, useEffect, useState } from "react";
import { contextWindowChoices, resolveContextWindow } from "../../lib/context";
import { loadContextWindow, loadEffort, loadModel } from "../../lib/prefs";
import { startAccountUsage } from "../../lib/account-usage-store";
import { startProviderStatus } from "../../lib/provider-status";
import * as api from "../../lib/tauri";
import type { Runtime } from "../../lib/tauri";

/** Grok install, login, and the model list. Checked once when the app opens. */
export function useRuntime() {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [contextWindow, setContextWindow] = useState(0);

  const applyRuntime = useCallback((next: Runtime) => {
    setRuntime(next);
    const savedModel = loadModel();
    const nextModel = next.models.some((m) => m.id === savedModel) ? savedModel : next.default_model;
    const chosen = next.models.find((m) => m.id === nextModel) ?? next.models[0];
    const savedEffort = loadEffort();
    const nextEffort = chosen?.efforts.some((e) => e.id === savedEffort) ? savedEffort : next.default_effort;
    setModel(nextModel);
    setEffort(chosen?.efforts.some((e) => e.id === nextEffort) ? nextEffort : (chosen?.efforts[0]?.id ?? ""));
    const choices = contextWindowChoices(chosen?.context_windows, chosen?.context_window);
    setContextWindow(resolveContextWindow(choices, loadContextWindow(), chosen?.context_window, nextModel));
  }, []);

  const reloadRuntime = useCallback(() => {
    void api
      .runtime()
      .then(applyRuntime)
      .catch(() =>
        applyRuntime({
          installed: false,
          logged_in: false,
          version: null,
          email: null,
          default_model: "grok-4.6",
          default_effort: "high",
          models: [
            {
              id: "grok-4.6",
              name: "Grok 4.6",
              efforts: [
                { id: "xhigh", label: "Extra high" },
                { id: "high", label: "High" },
                { id: "medium", label: "Medium" },
                { id: "low", label: "Low" },
              ],
              context_window: 256000,
              context_windows: [256000, 500000],
              provider: "xai",
            },
          ],
          has_key: false,
          ready: false,
          hint: "Install the Grok CLI, or add an xAI API key in Settings.",
        }),
      );
  }, [applyRuntime]);

  useEffect(() => {
    reloadRuntime();
    // Provider, storage, folder, and account allowance checks start with the app.
    // Opening settings only reads them, and closing settings does not cancel them.
    startProviderStatus();
    startAccountUsage();
  }, [reloadRuntime]);

  return { runtime, model, setModel, effort, setEffort, contextWindow, setContextWindow, reloadRuntime };
}

import { useCallback, useEffect, useState } from "react";
import { contextWindowChoices, resolveContextWindow } from "../lib/context";
import { loadContextWindow, loadEffort, loadModel } from "../lib/prefs";
import * as api from "../lib/tauri";
import type { Runtime } from "../lib/tauri";

/** Shown only when no runtime has loaded and the probe itself fails. */
function grokFallbackRuntime(): Runtime {
  return {
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
  };
}

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
      .catch(() => {
        // A failed probe must not wipe a MiniMax or Claude login with a Grok-only snapshot.
        setRuntime((current) => current ?? grokFallbackRuntime());
      });
  }, [applyRuntime]);

  useEffect(() => {
    let cancelled = false;
    // Paint the last snapshot before the CLI and model probes, so the composer
    // does not jump from empty to filled. The live probe replaces it.
    void api.runtimeCached().then((cached) => {
      if (!cancelled && cached) applyRuntime(cached);
    }).catch(() => undefined);
    reloadRuntime();
    return () => {
      cancelled = true;
    };
  }, [reloadRuntime, applyRuntime]);

  return { runtime, model, setModel, effort, setEffort, contextWindow, setContextWindow, reloadRuntime };
}

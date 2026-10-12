import { useCallback, useState } from "react";
import type { SettingsTab } from "../views/SettingsView";

/** Which full-page screen covers the chat. Opening one closes the others. */
export function useOverlays() {
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("providers");
  const [showServers, setShowServers] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [projectSettings, setProjectSettings] = useState<{ path: string; name: string } | null>(null);

  const closeSettings = useCallback(() => setShowSettings(false), []);
  const closeServers = useCallback(() => setShowServers(false), []);
  const closeUsage = useCallback(() => setShowUsage(false), []);
  const closeProjectSettings = useCallback(() => setProjectSettings(null), []);

  const openSettings = useCallback(() => {
    setShowUsage(false);
    setShowServers(false);
    setProjectSettings(null);
    setShowSettings(true);
  }, []);

  const openServers = useCallback(() => {
    setShowSettings(false);
    setShowUsage(false);
    setProjectSettings(null);
    setShowServers(true);
  }, []);

  const openUsage = useCallback(() => {
    setShowSettings(false);
    setShowServers(false);
    setProjectSettings(null);
    setShowUsage(true);
  }, []);

  const openProjectSettings = useCallback((path: string, name: string) => {
    setShowSettings(false);
    setShowUsage(false);
    setShowServers(false);
    setProjectSettings({ path, name });
  }, []);

  return {
    showSettings,
    setShowSettings,
    settingsTab,
    setSettingsTab,
    showServers,
    setShowServers,
    showUsage,
    setShowUsage,
    projectSettings,
    setProjectSettings,
    closeSettings,
    closeServers,
    closeUsage,
    closeProjectSettings,
    openSettings,
    openServers,
    openUsage,
    openProjectSettings,
  };
}

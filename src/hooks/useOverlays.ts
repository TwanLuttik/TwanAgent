import { useCallback, useState } from "react";
import type { SettingsTab } from "../views/SettingsView";

/** Which full-page screen covers the chat. Opening one closes the others. */
export function useOverlays() {
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("providers");
  const [showServers, setShowServers] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [showDocs, setShowDocs] = useState(false);
  const [projectSettings, setProjectSettings] = useState<{ path: string; name: string } | null>(null);

  const closeSettings = useCallback(() => setShowSettings(false), []);
  const closeServers = useCallback(() => setShowServers(false), []);
  const closeUsage = useCallback(() => setShowUsage(false), []);
  const closeDocs = useCallback(() => setShowDocs(false), []);
  const closeProjectSettings = useCallback(() => setProjectSettings(null), []);

  const openSettings = useCallback(() => {
    setShowUsage(false);
    setShowDocs(false);
    setShowServers(false);
    setProjectSettings(null);
    setShowSettings(true);
  }, []);

  const openServers = useCallback(() => {
    setShowSettings(false);
    setShowUsage(false);
    setShowDocs(false);
    setProjectSettings(null);
    setShowServers(true);
  }, []);

  const openUsage = useCallback(() => {
    setShowSettings(false);
    setShowDocs(false);
    setShowServers(false);
    setProjectSettings(null);
    setShowUsage(true);
  }, []);

  const openDocs = useCallback(() => {
    setShowSettings(false);
    setShowUsage(false);
    setShowServers(false);
    setProjectSettings(null);
    setShowDocs(true);
  }, []);

  const openProjectSettings = useCallback((path: string, name: string) => {
    setShowSettings(false);
    setShowUsage(false);
    setShowDocs(false);
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
    showDocs,
    setShowDocs,
    projectSettings,
    setProjectSettings,
    closeSettings,
    closeServers,
    closeUsage,
    closeDocs,
    closeProjectSettings,
    openSettings,
    openServers,
    openUsage,
    openDocs,
    openProjectSettings,
  };
}

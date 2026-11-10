import { useCallback, useMemo, useState } from "react";
import {
  closeEveryOverlay,
  closeOverlay,
  dismissProjectOverlay,
  openProjectOverlay,
  overlayFlags,
  overlayNone,
  showOverlay,
  type AppOverlay,
} from "../lib/overlay";
import type { SettingsTab } from "../views/SettingsView";

/** Settings and docs are dialogs. Usage, servers, and project settings cover the chat. Opening one closes the others. */
export function useOverlays() {
  const [overlay, setOverlay] = useState<AppOverlay>(overlayNone);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("providers");
  const flags = useMemo(() => overlayFlags(overlay), [overlay]);

  const closeOverlays = useCallback(() => {
    setOverlay((current) => closeEveryOverlay(current));
  }, []);
  const closeSettings = useCallback(() => {
    setOverlay((current) => closeOverlay(current, "settings"));
  }, []);
  const closeServers = useCallback(() => {
    setOverlay((current) => closeOverlay(current, "servers"));
  }, []);
  const closeUsage = useCallback(() => {
    setOverlay((current) => closeOverlay(current, "usage"));
  }, []);
  const closeDocs = useCallback(() => {
    setOverlay((current) => closeOverlay(current, "docs"));
  }, []);
  const closeProjectSettings = useCallback(() => {
    setOverlay((current) => closeOverlay(current, "project"));
  }, []);

  const openSettings = useCallback(() => {
    setOverlay((current) => showOverlay(current, "settings"));
  }, []);
  const openServers = useCallback(() => {
    setOverlay((current) => showOverlay(current, "servers"));
  }, []);
  const openUsage = useCallback(() => {
    setOverlay((current) => showOverlay(current, "usage"));
  }, []);
  const openDocs = useCallback(() => {
    setOverlay((current) => showOverlay(current, "docs"));
  }, []);
  const openProjectSettings = useCallback((path: string, name: string) => {
    setOverlay((current) => openProjectOverlay(current, path, name));
  }, []);
  const dismissProjectSettings = useCallback((path: string, same: (left: string, right: string) => boolean) => {
    setOverlay((current) => dismissProjectOverlay(current, path, same));
  }, []);

  return {
    overlay,
    ...flags,
    settingsTab,
    setSettingsTab,
    closeOverlays,
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
    dismissProjectSettings,
  };
}

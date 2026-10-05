type HotkeyEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
};

function isModHotkey(ev: HotkeyEvent, mac: boolean, key: string): boolean {
  if (ev.repeat || ev.altKey || ev.shiftKey) return false;
  if (ev.key.toLowerCase() !== key) return false;
  return mac ? ev.metaKey && !ev.ctrlKey : ev.ctrlKey && !ev.metaKey;
}

export function isNewChatHotkey(ev: HotkeyEvent, mac: boolean): boolean {
  return isModHotkey(ev, mac, "n");
}

export function isSettingsHotkey(ev: HotkeyEvent, mac: boolean): boolean {
  return isModHotkey(ev, mac, ",");
}

import { useEffect, useState } from "react";
import { Button } from "../components/Button";
import { formatBytes } from "../lib/usage";
import { folderName } from "../lib/core";
import { parsePermissionMode, type PermissionMode } from "../lib/permission";
import * as api from "../lib/tauri";
import {
  setProviderCli,
  setProviderDb,
  setProviderFolders,
  setProviderKeyStatus,
  startProviderStatusCached,
  useProviderStatus,
} from "../lib/provider-status";
import { useApp } from "../state/app-state";
import { SPEECH_MODELS, type SpeechModelInfo } from "../lib/speech";
import { AppearancePane } from "./settings/AppearancePane";
import { Group, Line, Page } from "./settings/SettingsChrome";
import { ProvidersPane, PROVIDER_CARDS, type ProviderCard, type ProviderCardId } from "./settings/ProvidersPane";
import { MicTest, VoiceModelCard, VoiceModelDialog } from "./settings/VoiceSettings";
import { StorageInventory } from "./settings/StorageInventory";
import { PermissionsPane } from "./settings/PermissionsPane";

export type SettingsTab = "appearance" | "providers" | "voice" | "storage" | "permissions";

export const SETTINGS_TABS: { id: SettingsTab; label: string; hint: string; icon: string; group: string }[] = [
  { id: "appearance", label: "Appearance", hint: "Theme and display", icon: "paintbrush", group: "General" },
  { id: "providers", label: "Providers", hint: "Grok, Claude, and MiniMax", icon: "sparkles", group: "Models" },
  { id: "voice", label: "Voice", hint: "Dictation", icon: "mic", group: "Models" },
  { id: "permissions", label: "Permissions", hint: "Folders and chats", icon: "lock", group: "System" },
  { id: "storage", label: "Storage", hint: "Projects and usage", icon: "externaldrive", group: "System" },
];

export function SettingsView({
  embedded = false,
  active = true,
  tab: tabProp,
  onTab,
  permission: permissionProp,
  onPermission,
  speechModel,
  speechModels = [],
  speechProgress,
  speechDownloading,
  onSpeechModel,
  onSpeechDownload,
  onKeyChange,
  onClose,
}: {
  embedded?: boolean;
  /** False while the page is kept mounted but hidden. Escape is ignored then. */
  active?: boolean;
  tab?: SettingsTab;
  onTab?: (tab: SettingsTab) => void;
  permission?: PermissionMode;
  onPermission?: (id: PermissionMode) => void;
  speechModel?: string;
  speechModels?: SpeechModelInfo[];
  speechProgress?: { id?: string; received: number; total: number } | null;
  speechDownloading?: boolean;
  onSpeechModel?: (id: string) => void;
  onSpeechDownload?: (id: string) => void;
  onKeyChange?: () => void;
  onClose?: () => void;
} = {}) {
  const { setFlash } = useApp();
  const providerStatus = useProviderStatus();
  useEffect(() => {
    if (active) startProviderStatusCached();
  }, [active]);
  const [providerKeys, setProviderKeys] = useState<Record<ProviderCardId, string>>({
    xai: "",
    anthropic: "",
    minimax: "",
  });
  const [savingProvider, setSavingProvider] = useState<ProviderCardId | null>(null);
  const [updatingCli, setUpdatingCli] = useState<ProviderCardId | "all" | null>(null);
  const [revealedEmail, setRevealedEmail] = useState<ProviderCardId | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ProviderCardId>("xai");
  const db = providerStatus.db;
  const [resettingDb, setResettingDb] = useState(false);
  const [openingDb, setOpeningDb] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const folders = providerStatus.folders;
  const [addingFolder, setAddingFolder] = useState(false);
  const [permissionLocal, setPermissionLocal] = useState<PermissionMode>(() => parsePermissionMode(permissionProp));
  const permission = permissionProp ?? permissionLocal;
  const tab: SettingsTab = tabProp ?? "providers";
  void onTab;
  const [voicePicker, setVoicePicker] = useState(false);

  useEffect(() => {
    if (!onClose) return;
    const close = onClose;
    function onKey(ev: KeyboardEvent) {
      if (!active || ev.key !== "Escape" || voicePicker) return;
      ev.preventDefault();
      close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onClose, voicePicker]);

  function updateProvider(card: ProviderCard) {
    const cli = providerStatus[card.cli];
    if (!cli?.installed || !cli.update || cli.update === cli.version) return Promise.resolve();
    return api.cliUpdate(card.id).then((info) => {
      setProviderCli(card.id, info);
      const version = info.version || cli.version || "";
      setFlash({
        kind: "ok",
        text: version ? `Updated the ${card.title} CLI to ${version}.` : `Updated the ${card.title} CLI.`,
      });
    });
  }

  function resetDatabase() {
    setResettingDb(true);
    void api
      .usageDbReset()
      .then((info) => {
        setProviderDb(info);
        setConfirmReset(false);
        setFlash({ kind: "ok", text: "Reset the usage database." });
      })
      .catch((e) => setFlash({ kind: "err", text: String(e) }))
      .finally(() => setResettingDb(false));
  }

  const body = (
    <div className="flex min-h-0 flex-1">
      <div className="min-h-0 flex-1 overflow-auto px-8 py-6">
        <div className="grid w-full max-w-[960px] gap-5">
          {tab === "appearance" && <AppearancePane />}

          {tab === "providers" && (
            <ProvidersPane
              cards={PROVIDER_CARDS}
              selectedId={selectedProvider}
              onSelect={setSelectedProvider}
              statusFor={(card) => providerStatus[card.id]}
              cliFor={(card) => providerStatus[card.cli]}
              draftFor={(card) => providerKeys[card.id]}
              onDraft={(card, value) => setProviderKeys((prev) => ({ ...prev, [card.id]: value }))}
              savingId={savingProvider}
              updatingId={updatingCli}
              revealed={revealedEmail === selectedProvider}
              onToggleReveal={() =>
                setRevealedEmail((current) => (current === selectedProvider ? null : selectedProvider))
              }
              onUpdate={(card) => {
                setUpdatingCli(card.id);
                void updateProvider(card)
                  .catch((e) => setFlash({ kind: "err", text: String(e) }))
                  .finally(() => setUpdatingCli(null));
              }}
              onUpdateAll={() => {
                const due = PROVIDER_CARDS.filter((card) => {
                  const cli = providerStatus[card.cli];
                  return Boolean(cli?.installed && cli.update && cli.update !== cli.version);
                });
                if (due.length === 0 || updatingCli) return;
                setUpdatingCli("all");
                void due
                  .reduce((chain, card) => chain.then(() => updateProvider(card)), Promise.resolve())
                  .catch((e) => setFlash({ kind: "err", text: String(e) }))
                  .finally(() => setUpdatingCli(null));
              }}
              onClear={(card) => {
                setSavingProvider(card.id);
                void card
                  .clear()
                  .then((next) => {
                    setProviderKeyStatus(card.id, next);
                    setProviderKeys((prev) => ({ ...prev, [card.id]: "" }));
                    onKeyChange?.();
                    setFlash({ kind: "ok", text: `Removed the saved ${card.keyName} key.` });
                  })
                  .catch((e) => setFlash({ kind: "err", text: String(e) }))
                  .finally(() => setSavingProvider(null));
              }}
              onSave={(card) => {
                setSavingProvider(card.id);
                void card
                  .save(providerKeys[card.id].trim())
                  .then((next) => {
                    setProviderKeyStatus(card.id, next);
                    setProviderKeys((prev) => ({ ...prev, [card.id]: "" }));
                    onKeyChange?.();
                    setFlash({ kind: "ok", text: `Saved the ${card.keyName} API key.` });
                  })
                  .catch((e) => setFlash({ kind: "err", text: String(e) }))
                  .finally(() => setSavingProvider(null));
              }}
            />
          )}

          {tab === "voice" && (
            <Page
              title="Voice"
              text="Dictate into the message box. A model downloads once and runs on this Mac."
              action={
                <Button size="sm" variant="primary" onClick={() => setVoicePicker(true)}>
                  Add model
                </Button>
              }
            >
              <Group title="Model">
                <VoiceModelCard
                  modelId={speechModel || SPEECH_MODELS[0].id}
                  models={speechModels}
                  progress={speechProgress}
                  downloading={speechDownloading}
                />
              </Group>
              <Group title="Microphone">
                <div className="px-3.5 py-3">
                  <MicTest />
                </div>
              </Group>
              {voicePicker ? (
                <VoiceModelDialog
                  currentId={speechModel || SPEECH_MODELS[0].id}
                  models={speechModels}
                  progress={speechProgress}
                  downloading={Boolean(speechDownloading)}
                  onClose={() => setVoicePicker(false)}
                  onUse={(id) => {
                    onSpeechModel?.(id);
                    setVoicePicker(false);
                  }}
                  onDownload={(id) => onSpeechDownload?.(id)}
                />
              ) : null}
            </Page>
          )}

          {tab === "storage" && (
            <Page
              title="Storage"
              text="Usage history is a local database. Projects and chats on this Mac are listed below, with their open worktrees. Cloud projects stay on the paired machine."
            >
              <Group
                title="Usage database"
                action={
                  confirmReset ? (
                    <div className="flex gap-2">
                      <Button size="sm" disabled={resettingDb} onClick={() => setConfirmReset(false)}>
                        Cancel
                      </Button>
                      <Button size="sm" variant="danger" disabled={resettingDb} onClick={resetDatabase}>
                        {resettingDb ? "Resetting…" : "Delete"}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={!db || openingDb}
                        onClick={() => {
                          setOpeningDb(true);
                          void api
                            .usageDbOpen()
                            .catch((e) => setFlash({ kind: "err", text: String(e) }))
                            .finally(() => setOpeningDb(false));
                        }}
                      >
                        {openingDb ? "Opening…" : "Open folder"}
                      </Button>
                      <Button size="sm" variant="danger" disabled={!db?.exists || resettingDb} onClick={() => setConfirmReset(true)}>
                        Reset
                      </Button>
                    </div>
                  )
                }
              >
                {confirmReset ? (
                  <p className="m-0 px-3.5 py-2 text-[12px] text-err">Delete the usage database? This cannot be undone.</p>
                ) : null}
                <Line label="File" value={db?.path || "Checking…"} title={db?.path} mono />
                <Line label="Size" value={db ? formatBytes(db.bytes) : "—"} />
                <Line label="Status" value={db ? (db.exists ? "On disk" : "Not created yet") : "—"} ok={db?.exists} />
              </Group>
              <StorageInventory />
            </Page>
          )}

          {tab === "permissions" && (
            <PermissionsPane
              mode={permission}
              folders={folders}
              adding={addingFolder}
              onMode={(id) => {
                if (onPermission) onPermission(id);
                else setPermissionLocal(id);
              }}
              onAdd={() => {
                setAddingFolder(true);
                void api
                  .pickDir()
                  .then(async (path) => {
                    if (!path) return;
                    const opened = await api.openFolder(path);
                    setProviderFolders(folders.includes(opened) ? folders : [...folders, opened].sort());
                    setFlash({ kind: "ok", text: `Allowed ${folderName(opened)}. macOS will not ask for this folder again.` });
                  })
                  .catch((e) => setFlash({ kind: "err", text: String(e) }))
                  .finally(() => setAddingFolder(false));
              }}
              onRemove={(path) => {
                void api
                  .forgetWorkspace(path)
                  .then(() => {
                    setProviderFolders(folders.filter((row) => row !== path));
                    setFlash({ kind: "ok", text: `Removed access to ${folderName(path)}.` });
                  })
                  .catch((e) => setFlash({ kind: "err", text: String(e) }));
              }}
            />
          )}
        </div>
      </div>
    </div>
  );

  if (embedded) {
    return <div className="flex min-h-0 flex-1 flex-col">{body}</div>;
  }
  return body;
}

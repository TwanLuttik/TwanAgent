import { useEffect, useState } from "react";
import { Button } from "../components/Button";
import { ThemePicker } from "../components/ThemePicker";
import { formatBytes } from "../lib/usage";
import { folderName } from "../lib/core";
import { parsePermissionMode, type PermissionMode } from "../lib/permission";
import {
  loadExpandEdits,
  loadFileHoverCard,
  loadLiveSocketDebug,
  loadMarkdownOpenMode,
  loadPerfOverlay,
  loadSpaceCorner,
  loadSpaceCornerImage,
  loadSpaceCornerScene,
  loadWrapLines,
  saveMarkdownOpenMode,
  setExpandEdits,
  setFileHoverCard,
  setLiveSocketDebug,
  setPerfOverlay,
  setSpaceCorner,
  setSpaceCornerImage,
  setSpaceCornerScene,
  setWrapLines,
  type SpaceCornerImage,
  type MarkdownOpenMode,
} from "../lib/prefs";
import { DEFAULT_SCENE, isSceneId, SCENES, type SceneId } from "../lib/ascii/scenes";
import { loadTheme, type ThemeSelection } from "../lib/theme";
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
import { Card, Row, Section, Toggle } from "./settings/SettingsChrome";
import { ProvidersPane, PROVIDER_CARDS, type ProviderCard, type ProviderCardId } from "./settings/ProvidersPane";
import { MicTest, VoiceModelCard, VoiceModelDialog } from "./settings/VoiceSettings";
import { StorageInventory } from "./settings/StorageInventory";
import { PermissionsPane } from "./settings/PermissionsPane";

export type SettingsTab = "appearance" | "providers" | "voice" | "storage" | "permissions";

export const SETTINGS_TABS: { id: SettingsTab; label: string; hint: string; icon: string }[] = [
  { id: "providers", label: "Model Providers", hint: "Grok, Claude, and MiniMax", icon: "sparkles" },
  { id: "voice", label: "Voice", hint: "Dictation model", icon: "mic" },
  { id: "permissions", label: "Permissions", hint: "Folders and chats", icon: "lock" },
  { id: "storage", label: "Storage", hint: "Usage database", icon: "externaldrive" },
  { id: "appearance", label: "Appearance", hint: "Theme and display", icon: "paintbrush" },
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
  const [theme, setThemeSel] = useState<ThemeSelection>(() => loadTheme());
  const [spaceArt, setSpaceArt] = useState(() => loadSpaceCorner());
  const [spaceScene, setSpaceScene] = useState<SceneId>(() => {
    const stored = loadSpaceCornerScene();
    return isSceneId(stored) ? stored : DEFAULT_SCENE;
  });
  const [spaceVideo, setSpaceVideo] = useState(() => isSceneId(loadSpaceCornerScene()));
  const [spaceImage, setSpaceImage] = useState<SpaceCornerImage | null>(() => loadSpaceCornerImage());
  const [pickingImage, setPickingImage] = useState(false);
  const [fileHoverCard, setFileHoverCardOn] = useState(() => loadFileHoverCard());
  const [perfOverlay, setPerfOverlayOn] = useState(() => loadPerfOverlay());
  const [liveSocketDebug, setLiveSocketDebugOn] = useState(() => loadLiveSocketDebug());
  const [expandEdits, setExpandEditsOn] = useState(() => loadExpandEdits());
  const [wrapLines, setWrapLinesOn] = useState(() => loadWrapLines());
  const [markdownOpen, setMarkdownOpen] = useState<MarkdownOpenMode>(() => loadMarkdownOpenMode());
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

  const body = (
    <div className="flex min-h-0 flex-1">
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="grid max-w-[520px] gap-4">
          {tab === "appearance" && (
            <Section title="Appearance" text="Finder is the default. Custom builds a theme from light or dark plus accent, background, and sidebar.">
              <ThemePicker value={theme} onChange={setThemeSel} />
              <Toggle
                title="Space corner"
                text="Show a faded picture in the top-left of the sidebar."
                checked={spaceArt}
                onChange={(next) => {
                  setSpaceArt(next);
                  setSpaceCorner(next);
                }}
              />
              <div className="grid gap-1.5">
                <span className="block text-[13px] font-medium text-ink">Picture</span>
                <span className="text-[12px] leading-relaxed text-muted">
                  {spaceImage
                    ? `${spaceImage.name} is saved in the TwanAgent folder, so it stays if you delete the original.`
                    : "Uses the built-in picture. A chosen image is copied into the TwanAgent folder."}
                </span>
                <div className="flex gap-2">
                  <Button
                    disabled={pickingImage}
                    onClick={() => {
                      setPickingImage(true);
                      void api
                        .pickImage()
                        .then(async (path) => {
                          if (!path) return;
                          const saved = await api.setSpaceCornerImage(path);
                          const next = {
                            path: saved.path,
                            name: saved.name,
                            width: saved.width,
                            height: saved.height,
                          };
                          setSpaceImage(next);
                          setSpaceCornerImage(next);
                          if (!spaceArt) {
                            setSpaceArt(true);
                            setSpaceCorner(true);
                          }
                          if (spaceVideo) {
                            setSpaceVideo(false);
                            setSpaceCornerScene("");
                          }
                          setFlash({ kind: "ok", text: `Using ${saved.name} in the corner.` });
                        })
                        .catch((e) => setFlash({ kind: "err", text: String(e) }))
                        .finally(() => setPickingImage(false));
                    }}
                  >
                    {pickingImage ? "Choosing…" : spaceImage ? "Change image" : "Choose image"}
                  </Button>
                  {spaceImage ? (
                    <Button
                      onClick={() => {
                        void api
                          .clearSpaceCornerImage()
                          .then(() => {
                            setSpaceImage(null);
                            setSpaceCornerImage(null);
                            setFlash({ kind: "ok", text: "Using the built-in picture." });
                          })
                          .catch((e) => setFlash({ kind: "err", text: String(e) }));
                      }}
                    >
                      Use default
                    </Button>
                  ) : null}
                </div>
              </div>
              <Toggle
                title="Video"
                text="Play an animated ascii scene from ascii.rest instead of the picture."
                checked={spaceVideo}
                onChange={(next) => {
                  setSpaceVideo(next);
                  setSpaceCornerScene(next ? spaceScene : "");
                  if (next && !spaceArt) {
                    setSpaceArt(true);
                    setSpaceCorner(true);
                  }
                }}
              />
              {spaceVideo ? (
                <label className="grid gap-1.5">
                  <span className="block text-[13px] font-medium text-ink">Scene</span>
                  <select
                    value={spaceScene}
                    onChange={(e) => {
                      const next = e.target.value;
                      if (!isSceneId(next)) return;
                      setSpaceScene(next);
                      setSpaceCornerScene(next);
                    }}
                    className="h-8 rounded-md border border-line bg-canvas px-2 text-[13px] text-ink outline-none focus:border-accent"
                  >
                    {SCENES.map((scene) => (
                      <option key={scene.id} value={scene.id}>
                        {scene.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <Toggle
                title="File hover cards"
                text="Show a small preview when you hover a file name in chat."
                checked={fileHoverCard}
                onChange={(next) => {
                  setFileHoverCardOn(next);
                  setFileHoverCard(next);
                }}
              />
              <Toggle
                title="Performance overlay"
                text="Show FPS, native CPU, and memory in the bottom-right, with a live graph."
                checked={perfOverlay}
                onChange={(next) => {
                  setPerfOverlayOn(next);
                  setPerfOverlay(next);
                }}
              />
              <Toggle
                title="Live socket debug"
                text="Show raw websocket frames from a cloud conversation in a window at the bottom-right."
                checked={liveSocketDebug}
                onChange={(next) => {
                  setLiveSocketDebugOn(next);
                  setLiveSocketDebug(next);
                }}
              />
              <Toggle
                title="Wrap lines"
                text="Break long lines in the code editor onto the next row so you don't have to scroll sideways."
                checked={wrapLines}
                onChange={(next) => {
                  setWrapLinesOn(next);
                  setWrapLines(next);
                }}
              />
              <Toggle
                title="Expand edits"
                text="Open file edit diffs in chat. Reads, lists, and commands stay collapsed."
                checked={expandEdits}
                onChange={(next) => {
                  setExpandEditsOn(next);
                  setExpandEdits(next);
                }}
              />
              <div className="grid gap-1.5">
                <span className="block text-[13px] font-medium text-ink">Open Markdown files in</span>
                <span className="text-[12px] leading-relaxed text-muted">
                  Editor shows source. Viewer renders the file. You can switch on the file tab.
                </span>
                <div className="flex gap-1">
                  {(
                    [
                      { id: "editor", label: "Editor" },
                      { id: "viewer", label: "Viewer" },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => {
                        setMarkdownOpen(opt.id);
                        saveMarkdownOpenMode(opt.id);
                      }}
                      className={`rounded-[6px] px-2 py-1 text-[12px] ${
                        markdownOpen === opt.id ? "bg-wash-strong text-ink" : "text-muted hover:text-ink"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </Section>
          )}

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
                  .reduce(
                    (chain, card) => chain.then(() => updateProvider(card)),
                    Promise.resolve(),
                  )
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
            <Section
              title="Voice"
              text="Dictate into the message box. A model downloads once and runs on this Mac."
            >
              <VoiceModelCard
                modelId={speechModel || SPEECH_MODELS[0].id}
                models={speechModels}
                progress={speechProgress}
                downloading={speechDownloading}
              />
              <MicTest />
              <div className="flex justify-end">
                <Button variant="primary" onClick={() => setVoicePicker(true)}>
                  Add model
                </Button>
              </div>
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
            </Section>
          )}

          {tab === "storage" && (
            <Section
              title="Storage"
              text="Usage history is a local database. Projects and chats on this Mac are listed below, with their open worktrees. Cloud projects stay on the paired machine."
            >
              <Card>
                <Row label="File" value={db?.path || "Checking…"} title={db?.path} mono />
                <Row label="Size" value={db ? formatBytes(db.bytes) : "—"} />
                <Row label="Status" value={db ? (db.exists ? "On disk" : "Not created yet") : "—"} ok={db?.exists} />
              </Card>
              {confirmReset ? (
                <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-panel px-3 py-2">
                  <span className="text-[12px] text-ink">Delete the usage database?</span>
                  <div className="flex shrink-0 gap-2">
                    <Button disabled={resettingDb} onClick={() => setConfirmReset(false)}>
                      Cancel
                    </Button>
                    <Button
                      variant="danger"
                      disabled={resettingDb}
                      onClick={() => {
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
                      }}
                    >
                      {resettingDb ? "Resetting…" : "Reset"}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex justify-end gap-2">
                  <Button
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
                  <Button variant="danger" disabled={!db?.exists || resettingDb} onClick={() => setConfirmReset(true)}>
                    Reset database
                  </Button>
                </div>
              )}
              <StorageInventory />
            </Section>
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

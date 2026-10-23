import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../components/Button";
import { Symbol } from "../components/Symbol";
import { ThemePicker } from "../components/ThemePicker";
import { maskEmail } from "../lib/mask";
import { formatBytes } from "../lib/usage";
import { folderName, projectKey } from "../lib/core";
import {
  PERMISSION_ACTIONS,
  PERMISSION_MODES,
  parsePermissionMode,
  permissionEffect,
  type PermissionMode,
} from "../lib/permission";
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
import {
  SPEECH_MODELS,
  loadMicDevice,
  micAudioConstraints,
  meterLevel,
  saveMicDevice,
  speechModel,
  speechNote,
  speechSizeLabel,
  type MicDevice,
  type SpeechModelInfo,
} from "../lib/speech";
import type { SpeechModelStatus } from "../lib/tauri";

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

type StorageProject = {
  name: string;
  path: string;
  bytes: number | null;
  chats: number | null;
  worktrees: { path: string; branch: string; bytes: number | null }[];
};

type StorageCloud = {
  id: string;
  name: string;
  path: string;
  host: string;
  chats: number | null;
};

/** Local projects, their chats and open worktrees, plus the cloud projects on paired machines. */
function StorageInventory() {
  const [local, setLocal] = useState<StorageProject[] | null>(null);
  const [cloud, setCloud] = useState<StorageCloud[] | null>(null);

  useEffect(() => {
    let alive = true;
    void api
      .listProjects()
      .then(async (projects) => {
        const rows = await Promise.all(
          projects.map(async (project) => {
            const [chats, size, listed] = await Promise.all([
              api.listConversations(project.path).then((rows) => rows.length).catch(() => null),
              api.projectRemoval(project.path).catch(() => null),
              api.gitWorktrees(project.path).catch(() => [] as api.GitWorktree[]),
            ]);
            const branchFor = new Map(
              listed.map((row) => [
                projectKey(row.path),
                row.detached ? "detached" : row.branch?.trim() || folderName(row.path),
              ]),
            );
            const trees = (size?.worktree_sizes ?? []).map((row) => ({
              path: row.path,
              branch: branchFor.get(projectKey(row.path)) || folderName(row.path),
              bytes: row.bytes,
            }));
            return {
              name: project.name || folderName(project.path),
              path: project.path,
              bytes: size ? size.project : null,
              chats,
              worktrees: trees,
            };
          }),
        );
        if (!alive) return;
        // A linked worktree can also be saved as its own project. It belongs under the main checkout.
        const linked = new Set(rows.flatMap((row) => row.worktrees.map((tree) => projectKey(tree.path))));
        setLocal(rows.filter((row) => !linked.has(projectKey(row.path))).sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch(() => {
        if (alive) setLocal([]);
      });
    void api
      .listRemoteProjects()
      .then(async (projects) => {
        const machines = await api.listMachines().catch(() => []);
        const hostFor = new Map(machines.map((machine) => [machine.id, machine.host]));
        const rows = await Promise.all(
          projects.map(async (project) => {
            const chats = await api
              .hostedSidebarCached(project.mount_path)
              .then((cached) => cached.conversations.length)
              .catch(() => null);
            return {
              id: project.id,
              name: project.name || folderName(project.remote_path),
              path: project.remote_path,
              host: hostFor.get(project.machine_id) || "",
              chats,
            };
          }),
        );
        if (alive) setCloud(rows.sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch(() => {
        if (alive) setCloud([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const worktrees = (local ?? []).reduce((sum, row) => sum + row.worktrees.length, 0);
  const chats = (local ?? []).reduce((sum, row) => sum + (row.chats ?? 0), 0);
  const cloudChats = (cloud ?? []).reduce((sum, row) => sum + (row.chats ?? 0), 0);
  return (
    <div className="grid gap-5">
      <div className="grid grid-cols-3 gap-2">
        <CountTile label="Projects" value={local == null ? "—" : String(local.length)} />
        <CountTile label="Chats" value={local == null ? "—" : String(chats)} />
        <CountTile label="Worktrees" value={local == null ? "—" : String(worktrees)} />
      </div>
      <StorageGroup
        title="On this Mac"
        empty={local == null ? "Checking…" : "No saved projects yet."}
        rows={local}
        render={(project) => (
          <ProjectLine
            key={project.path}
            icon="folder"
            name={project.name}
            hint={project.path}
            size={project.bytes}
            count={project.chats}
            chips={project.worktrees.map((tree) => ({
              label: tree.branch,
              detail: tree.bytes == null ? "" : formatBytes(tree.bytes),
            }))}
          />
        )}
      />
      <StorageGroup
        title="Cloud"
        note={cloud && cloud.length > 0 ? `${cloudChats} ${cloudChats === 1 ? "chat" : "chats"}` : undefined}
        empty={cloud == null ? "Checking…" : "No cloud projects yet."}
        rows={cloud}
        render={(project) => (
          <ProjectLine
            key={project.id}
            icon="cloud"
            name={project.name}
            hint={project.host || project.path}
            title={project.host ? `${project.host} · ${project.path}` : project.path}
            count={project.chats}
          />
        )}
      />
    </div>
  );
}

function CountTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-inset/70 px-2.5 py-2">
      <div className="text-[16px] font-semibold leading-none tabular-nums text-ink">{value}</div>
      <div className="mt-1 text-[11px] text-muted">{label}</div>
    </div>
  );
}

function StorageGroup<T>({
  title,
  note,
  empty,
  rows,
  render,
}: {
  title: string;
  note?: string;
  empty: string;
  rows: T[] | null;
  render: (row: T) => ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <div className="text-[13px] font-medium text-ink">{title}</div>
        {note ? <div className="text-[11px] text-muted">{note}</div> : null}
      </div>
      {!rows || rows.length === 0 ? (
        <p className="m-0 text-[12px] text-muted">{empty}</p>
      ) : (
        <div className="grid gap-0.5">{rows.map(render)}</div>
      )}
    </div>
  );
}

function ProjectLine({
  icon,
  name,
  hint,
  title,
  size,
  count,
  chips = [],
}: {
  icon: string;
  name: string;
  hint: string;
  title?: string;
  size?: number | null;
  count: number | null;
  chips?: { label: string; detail: string }[];
}) {
  return (
    <div className="grid gap-1 rounded-md px-1.5 py-1.5 hover:bg-wash" title={title ?? hint}>
      <div className="flex min-w-0 items-center gap-2">
        <Symbol name={icon} className="size-3.5 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{name}</span>
        {size != null ? <span className="shrink-0 text-[11px] tabular-nums text-muted">{formatBytes(size)}</span> : null}
        <span className="w-6 shrink-0 text-right text-[11px] tabular-nums text-muted">{count == null ? "—" : count}</span>
      </div>
      {chips.length > 0 ? (
        <div className="flex flex-wrap gap-1 pl-5">
          {chips.map((chip) => (
            <span
              key={chip.label}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-inset px-1.5 py-0.5 text-[11px] text-muted"
            >
              <Symbol name="arrow.triangle.branch" className="size-2.5 shrink-0" />
              <span className="truncate">{chip.label}</span>
              {chip.detail ? <span className="shrink-0 tabular-nums text-muted/80">{chip.detail}</span> : null}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function speechRowStatus(models: SpeechModelInfo[], id: string): SpeechModelStatus {
  return models.find((row) => row.id === id)?.status ?? "missing";
}

function VoiceModelCard({
  modelId,
  models,
  progress,
  downloading,
}: {
  modelId: string;
  models: SpeechModelInfo[];
  progress?: { id?: string; received: number; total: number } | null;
  downloading?: boolean;
}) {
  const model = speechModel(modelId);
  const status = speechRowStatus(models, model.id);
  const active = downloading && (!progress?.id || progress.id === model.id);
  return (
    <Card>
      <div className="text-[13px] font-medium text-ink">{model.label}</div>
      <div className="text-[12px] text-muted">{speechNote(model.id)}</div>
      <div className="text-[12px] text-muted">
        {speechSizeLabel(model.bytes)} · {voiceStatusText(status, active ? progress : null, active)}
      </div>
    </Card>
  );
}

function MicTest() {
  const { setFlash } = useApp();
  const [devices, setDevices] = useState<MicDevice[]>([]);
  const [deviceId, setDeviceId] = useState(loadMicDevice);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);

  const refreshDevices = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
    const rows = await navigator.mediaDevices.enumerateDevices();
    const mics = rows
      .filter((row) => row.kind === "audioinput")
      .map((row, index) => ({
        id: row.deviceId,
        label: row.label || `Microphone ${index + 1}`,
      }));
    setDevices(mics);
  }, []);

  useEffect(() => {
    void refreshDevices().catch(() => undefined);
  }, [refreshDevices]);

  useEffect(() => {
    return () => stopRef.current?.();
  }, []);

  async function startTest() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setFlash({ kind: "err", text: "Allow the microphone to test it." });
      return;
    }
    const info = await api.microphoneInfo().catch(() => null);
    if (!info?.ready) {
      setFlash({
        kind: "err",
        text: info?.reason || "This build cannot use the microphone yet. Quit TwanAgent and open it again from a new build.",
      });
      return;
    }
    stopRef.current?.();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: micAudioConstraints(deviceId) });
    } catch {
      setFlash({ kind: "err", text: "Allow the microphone to test it." });
      return;
    }
    await refreshDevices().catch(() => undefined);
    const AudioCtx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      stream.getTracks().forEach((track) => track.stop());
      setFlash({ kind: "err", text: "This browser cannot test the microphone." });
      return;
    }
    const ctx = new AudioCtx();
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        /* the meter still reads once the context starts */
      }
    }
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.35;
    const samples = new Float32Array(analyser.fftSize);
    source.connect(analyser);
    let peak = 0;
    let frame = 0;
    const tick = () => {
      analyser.getFloatTimeDomainData(samples);
      const next = meterLevel(samples);
      peak = Math.max(peak * 0.82, next);
      setLevel(peak);
      if (next > 0.12) setHeard(true);
      frame = requestAnimationFrame(tick);
    };
    setHeard(false);
    setLevel(0);
    setTesting(true);
    frame = requestAnimationFrame(tick);
    stopRef.current = () => {
      cancelAnimationFrame(frame);
      source.disconnect();
      analyser.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void ctx.close();
      stopRef.current = null;
      setTesting(false);
      setLevel(0);
    };
  }

  return (
    <div className="grid gap-2">
      <label className="grid gap-1.5">
        <span className="block text-[13px] font-medium text-ink">Microphone</span>
        <select
          value={devices.some((row) => row.id === deviceId) ? deviceId : ""}
          onChange={(event) => {
            const next = event.target.value;
            setDeviceId(next);
            saveMicDevice(next);
            if (testing) {
              stopRef.current?.();
              void startTest();
            }
          }}
          className="h-8 rounded-md border border-line bg-canvas px-2 text-[13px] text-ink outline-none focus:border-accent"
        >
          <option value="">System default</option>
          {devices.map((device) => (
            <option key={device.id || "default"} value={device.id}>
              {device.label}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="h-2 overflow-hidden rounded-full bg-wash">
            <div
              className={`h-full rounded-full ${heard ? "bg-ok" : "bg-accent"}`}
              style={{ width: `${Math.round(level * 100)}%` }}
            />
          </div>
          <p className="mt-1 mb-0 text-[12px] text-muted">
            {testing ? (heard ? "Hearing you." : "Speak to see the level move.") : "Check that the selected mic hears you."}
          </p>
        </div>
        <Button
          onClick={() => {
            if (testing) stopRef.current?.();
            else void startTest();
          }}
        >
          {testing ? "Stop" : "Test mic"}
        </Button>
      </div>
    </div>
  );
}

function VoiceModelDialog({
  currentId,
  models,
  progress,
  downloading,
  onClose,
  onUse,
  onDownload,
}: {
  currentId: string;
  models: SpeechModelInfo[];
  progress?: { id?: string; received: number; total: number } | null;
  downloading: boolean;
  onClose: () => void;
  onUse: (id: string) => void;
  onDownload: (id: string) => void;
}) {
  const [picked, setPicked] = useState(currentId);
  const status = speechRowStatus(models, picked);
  const active = downloading && (!progress?.id || progress.id === picked);
  const ready = status === "ready";

  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      onClose();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/25 p-6" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-labelledby="voice-model-title"
        className="grid w-full max-w-[420px] gap-3 rounded-xl border border-line bg-canvas p-4 shadow-card"
        onMouseDown={(ev) => ev.stopPropagation()}
      >
        <div>
          <h3 id="voice-model-title" className="m-0 text-[15px] font-semibold">
            Add a voice model
          </h3>
          <p className="mt-1 mb-0 text-[12px] leading-relaxed text-muted">
            Pick a free model. It downloads once and stays on this Mac.
          </p>
        </div>
        <div className="grid gap-1.5" role="listbox" aria-label="Voice models">
          {SPEECH_MODELS.map((model) => {
            const rowStatus = speechRowStatus(models, model.id);
            const on = picked === model.id;
            return (
              <button
                key={model.id}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => setPicked(model.id)}
                className={`rounded-md border px-3 py-2 text-left ${
                  on ? "border-accent bg-wash" : "border-line hover:bg-wash"
                }`}
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px] font-medium text-ink">{model.label}</span>
                  <span className="shrink-0 text-[11px] text-muted">{speechSizeLabel(model.bytes)}</span>
                </span>
                <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">{speechNote(model.id)}</span>
                <span className="mt-1 block text-[11px] text-muted">
                  {rowStatus === "ready" ? "Downloaded" : rowStatus === "partial" ? "Download incomplete" : "Not downloaded"}
                  {model.id === currentId ? " · In use" : ""}
                </span>
              </button>
            );
          })}
        </div>
        {active && progress && progress.total > 0 ? (
          <div className="grid gap-1">
            <div className="h-1.5 overflow-hidden rounded-full bg-wash">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${Math.min(100, Math.round((progress.received / progress.total) * 100))}%` }}
              />
            </div>
            <span className="text-[11px] text-muted">{voiceStatusText(status, progress, true)}</span>
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          {ready ? (
            <Button variant="primary" onClick={() => onUse(picked)}>
              Use model
            </Button>
          ) : (
            <Button variant="primary" disabled={active} onClick={() => onDownload(picked)}>
              {active ? "Downloading…" : status === "partial" ? "Resume download" : "Download"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function voiceStatusText(
  status: SpeechModelStatus | undefined,
  progress: { received: number; total: number } | null | undefined,
  downloading: boolean | undefined,
): string {
  if (downloading && progress && progress.total > 0) {
    return `Downloading… ${speechSizeLabel(progress.received)} / ${speechSizeLabel(progress.total)}`;
  }
  if (status === "ready") return "Ready";
  if (status === "partial") return "Download incomplete";
  return "Not downloaded";
}

type ProviderCardId = "xai" | "anthropic" | "minimax";

type ProviderCard = {
  id: ProviderCardId;
  cli: "grokCli" | "claudeCli" | "minimaxCli";
  title: string;
  text: string;
  logo: string;
  markClass: string;
  keyLabel: string;
  keyName: string;
  envName: string;
  placeholder: string;
  save: (key: string) => Promise<{ saved: boolean; env: boolean }>;
  clear: () => Promise<{ saved: boolean; env: boolean }>;
};

/** One card per provider. A new provider is another row here, not another copy of the form. */
const PROVIDER_CARDS: ProviderCard[] = [
  {
    id: "xai",
    cli: "grokCli",
    title: "Grok",
    text: "xAI models. The CLI login is used when no API key is saved.",
    logo: "logo.grok",
    markClass: "bg-[#1a1a1a] text-white",
    keyLabel: "xAI API key",
    keyName: "xAI",
    envName: "XAI_API_KEY",
    placeholder: "xai-…",
    save: api.setKey,
    clear: api.clearKey,
  },
  {
    id: "anthropic",
    cli: "claudeCli",
    title: "Claude",
    text: "Anthropic models. The CLI login is used when no API key is saved.",
    logo: "logo.claude",
    markClass: "bg-[#d97757] text-[#faf9f5]",
    keyLabel: "Anthropic API key",
    keyName: "Anthropic",
    envName: "ANTHROPIC_API_KEY",
    placeholder: "sk-ant-…",
    save: api.setAnthropicKey,
    clear: api.clearAnthropicKey,
  },
  {
    id: "minimax",
    cli: "minimaxCli",
    title: "MiniMax",
    text: "MiniMax models. The mmx login is used when no API key is saved.",
    logo: "logo.minimax",
    markClass: "bg-wash",
    keyLabel: "MiniMax API key",
    keyName: "MiniMax",
    envName: "MINIMAX_API_KEY",
    placeholder: "sk-…",
    save: api.setMinimaxKey,
    clear: api.clearMinimaxKey,
  },
];

type CliRow = {
  installed: boolean;
  path: string;
  version: string | null;
  logged_in: boolean;
  email: string | null;
  update?: string;
};

function cliCanUpdate(cli: CliRow | null): boolean {
  return Boolean(cli?.installed && cli.update && cli.update !== cli.version);
}

function providerStatusLine(cli: CliRow | null, key: { saved: boolean; env: boolean } | null): string {
  if (!cli && !key) return "Checking…";
  if (cli?.logged_in) {
    return cli.email ? "Authenticated" : "Authenticated · CLI";
  }
  if (key?.saved) return "Authenticated · saved key";
  if (key?.env) return "Authenticated · environment";
  if (cli && !cli.installed) return "CLI not found";
  return "Not signed in";
}

function ProvidersPane({
  cards,
  selectedId,
  onSelect,
  statusFor,
  cliFor,
  draftFor,
  onDraft,
  savingId,
  updatingId,
  revealed,
  onToggleReveal,
  onUpdate,
  onUpdateAll,
  onClear,
  onSave,
}: {
  cards: ProviderCard[];
  selectedId: ProviderCardId;
  onSelect: (id: ProviderCardId) => void;
  statusFor: (card: ProviderCard) => { saved: boolean; env: boolean } | null;
  cliFor: (card: ProviderCard) => CliRow | null;
  draftFor: (card: ProviderCard) => string;
  onDraft: (card: ProviderCard, value: string) => void;
  savingId: ProviderCardId | null;
  updatingId: ProviderCardId | "all" | null;
  revealed: boolean;
  onToggleReveal: () => void;
  onUpdate: (card: ProviderCard) => void;
  onUpdateAll: () => void;
  onClear: (card: ProviderCard) => void;
  onSave: (card: ProviderCard) => void;
}) {
  const selected = cards.find((card) => card.id === selectedId) ?? cards[0];
  const due = cards.filter((card) => cliCanUpdate(cliFor(card))).length;
  const updatingAll = updatingId === "all";
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="m-0 text-[15px] font-semibold">Providers</h2>
          <p className="mt-1 mb-0 text-[12px] leading-relaxed text-muted">
            A saved key is used first, then the signed-in CLI.
          </p>
        </div>
        <button
          type="button"
          disabled={due === 0 || updatingId != null}
          title={due === 0 ? "Every CLI is current" : `Update ${due} ${due === 1 ? "CLI" : "CLIs"}`}
          onClick={onUpdateAll}
          className="shrink-0 text-[12px] text-muted hover:text-ink disabled:cursor-default disabled:opacity-40 disabled:hover:text-muted"
        >
          {updatingAll ? "Updating…" : "Update all"}
        </button>
      </div>
      <div className="grid gap-x-4 gap-y-4 md:grid-cols-[minmax(168px,190px)_minmax(0,1fr)]">
        <div className="grid content-start gap-1 px-1">
          {cards.map((card) => {
            const cli = cliFor(card);
            const status = statusFor(card);
            const on = card.id === selected.id;
            const version = cli?.installed ? cli.version : null;
            return (
              <button
                key={card.id}
                type="button"
                aria-pressed={on}
                onClick={() => onSelect(card.id)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${
                  on ? "bg-wash-strong" : "hover:bg-wash"
                }`}
              >
                <span className={`flex size-6 shrink-0 items-center justify-center rounded-md ${card.markClass}`}>
                  <Symbol name={card.logo} colored className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate text-[13px] font-medium text-ink">{card.title}</span>
                    {version ? <span className="shrink-0 font-mono text-[10px] text-muted">{version}</span> : null}
                    {cliCanUpdate(cli) ? (
                      <Symbol name="arrow.up" className="size-2.5 shrink-0 self-center text-ok" />
                    ) : null}
                  </span>
                  <span className="block truncate text-[11px] text-muted">
                    {providerStatusLine(cli, status)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {selected ? (
          <ProviderDetail
            card={selected}
            cli={cliFor(selected)}
            status={statusFor(selected)}
            draft={draftFor(selected)}
            onDraft={(value) => onDraft(selected, value)}
            saving={savingId === selected.id}
            updating={updatingId === selected.id || updatingAll}
            revealed={revealed}
            onToggleReveal={onToggleReveal}
            onUpdate={() => onUpdate(selected)}
            onClear={() => onClear(selected)}
            onSave={() => onSave(selected)}
          />
        ) : null}
      </div>
    </div>
  );
}

function ProviderDetail({
  card,
  cli,
  status,
  draft,
  onDraft,
  saving,
  updating,
  revealed,
  onToggleReveal,
  onUpdate,
  onClear,
  onSave,
}: {
  card: ProviderCard;
  cli: CliRow | null;
  status: { saved: boolean; env: boolean } | null;
  draft: string;
  onDraft: (value: string) => void;
  saving: boolean;
  updating: boolean;
  revealed: boolean;
  onToggleReveal: () => void;
  onUpdate: () => void;
  onClear: () => void;
  onSave: () => void;
}) {
  const canUpdate = cliCanUpdate(cli);
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2">
        <span className={`flex size-6 shrink-0 items-center justify-center rounded-md ${card.markClass}`}>
          <Symbol name={card.logo} colored className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-[13px] font-semibold text-ink">{card.title}</h3>
          <p className="m-0 truncate text-[11px] text-muted">{providerStatusLine(cli, status)}</p>
        </div>
        {canUpdate ? (
          <button
            type="button"
            disabled={updating}
            title={`Install ${cli?.update}`}
            onClick={onUpdate}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-ok/15 px-2 py-0.5 text-[11px] font-medium text-ok hover:bg-ok/25 disabled:opacity-60"
          >
            <Symbol name="arrow.up" className={`size-2.5 ${updating ? "animate-pulse" : ""}`} />
            {updating ? "Updating…" : cli?.update}
          </button>
        ) : null}
      </div>
      <div className="grid gap-2.5">
        <Fact
          label="CLI"
          value={cli ? (cli.installed ? cli.version || "Installed" : "Not found") : "Checking…"}
          tone={cli?.installed ? "ok" : cli ? "err" : "muted"}
        />
        <Fact
          label="Path"
          value={cli?.installed && cli.path ? cli.path : "Not found"}
          mono
          title={cli?.path}
        />
        <Fact
          label="Login"
          value={
            !cli
              ? "Checking…"
              : cli.logged_in
                ? cli.email
                  ? maskEmail(cli.email, revealed)
                  : "Signed in"
                : "Not signed in"
          }
          tone={cli?.logged_in ? "ok" : cli ? "err" : "muted"}
          action={
            cli?.email ? (
              <button
                type="button"
                aria-label={revealed ? "Hide email" : "Show email"}
                onClick={onToggleReveal}
                className="flex size-5 items-center justify-center rounded text-muted hover:bg-wash hover:text-ink"
              >
                <Symbol name={revealed ? "eye.slash" : "eye"} className="size-3.5" />
              </button>
            ) : null
          }
        />
      </div>
      <KeyField
        label={card.keyLabel}
        value={draft}
        onChange={onDraft}
        placeholder={status?.saved ? "Key saved — paste to replace" : card.placeholder}
        status={status}
        envName={card.envName}
        saving={saving}
        onClear={onClear}
        onSave={onSave}
      />
    </div>
  );
}

/** A value the app reads. Not an input, so it has no field chrome. */
function Fact({
  label,
  value,
  mono,
  title,
  tone = "ink",
  action,
}: {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
  tone?: "ok" | "err" | "muted" | "ink";
  action?: ReactNode;
}) {
  const color = tone === "ok" ? "text-ok" : tone === "err" ? "text-err" : tone === "muted" ? "text-muted" : "text-ink";
  return (
    <div className="grid grid-cols-[52px_minmax(0,1fr)] items-center gap-3">
      <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">{label}</span>
      <span className="flex min-w-0 items-center gap-1">
        <span title={title ?? value} className={`min-w-0 truncate text-[12px] ${mono ? "font-mono" : ""} ${color}`}>
          {value}
        </span>
        {action}
      </span>
    </div>
  );
}

function KeyField({
  label,
  value,
  onChange,
  placeholder,
  status,
  envName,
  saving,
  onSave,
  onClear,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  status: { saved: boolean; env: boolean } | null;
  envName: string;
  saving: boolean;
  onSave: () => void;
  onClear: () => void;
}) {
  const note = status?.saved
    ? "Using the saved key."
    : status?.env
      ? `Using ${envName} from the environment.`
      : "No key saved here.";
  const tone = status?.saved || status?.env ? "text-ok" : "text-muted";
  return (
    <div className="grid gap-2">
      <label className="grid gap-1">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">
          <Symbol name="key" className="size-3" />
          {label}
        </span>
        <input
          type="password"
          value={value}
          autoComplete="off"
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 rounded-md border border-line bg-canvas px-2.5 text-[13px] outline-none focus:border-accent"
        />
      </label>
      <div className="flex items-center justify-between gap-2">
        <p className={`m-0 flex items-center gap-1.5 text-[12px] ${tone}`}>
          <Symbol name={status?.saved || status?.env ? "lock.fill" : "lock"} className="size-3" />
          {note}
        </p>
        <div className="flex shrink-0 gap-2">
          {status?.saved ? (
            <Button disabled={saving} onClick={onClear}>
              Clear
            </Button>
          ) : null}
          <Button variant="primary" disabled={saving || !value.trim()} onClick={onSave}>
            {saving ? "Saving…" : "Save key"}
          </Button>
        </div>
      </div>
    </div>
  );
}

const EFFECT_LABEL: Record<ReturnType<typeof permissionEffect>, string> = {
  allow: "Allowed",
  ask: "Asks first",
  block: "Blocked",
};

function PermissionsPane({
  mode,
  folders,
  adding,
  onMode,
  onAdd,
  onRemove,
}: {
  mode: PermissionMode;
  folders: string[];
  adding: boolean;
  onMode: (id: PermissionMode) => void;
  onAdd: () => void;
  onRemove: (path: string) => void;
}) {
  return (
    <div className="grid gap-6">
      <section className="grid gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="m-0 text-[15px] font-semibold">Folders</h2>
            <p className="mt-1 mb-0 text-[12px] leading-relaxed text-muted">
              Approve a folder once. Access stays until you remove it, including after you quit.
            </p>
          </div>
          <Button disabled={adding} onClick={onAdd}>
            {adding ? "Opening…" : "Add folder"}
          </Button>
        </div>
        {folders.length === 0 ? (
          <p className="m-0 rounded-lg bg-inset/70 px-3 py-2.5 text-[12px] leading-relaxed text-muted">
            No folders yet. Add one, or open a project. macOS may ask the first time. It should not ask again.
          </p>
        ) : (
          <div className="grid gap-1">
            {folders.map((path) => (
              <div key={path} className="flex items-center gap-2 rounded-lg bg-inset/70 px-2.5 py-2">
                <Symbol name="folder" className="size-3.5 shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] text-ink">{folderName(path)}</div>
                  <div className="truncate font-mono text-[11px] text-muted" title={path}>
                    {path}
                  </div>
                </div>
                <span className="hidden shrink-0 text-[11px] text-ok sm:inline">Kept</span>
                <Button size="sm" variant="danger" onClick={() => onRemove(path)}>
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="grid gap-3">
        <div>
          <h2 className="m-0 text-[15px] font-semibold">In a chat</h2>
          <p className="mt-1 mb-0 text-[12px] leading-relaxed text-muted">
            This applies to the open chat. Reading is always allowed inside an approved folder.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Chat permissions">
          {PERMISSION_MODES.map((item) => {
            const on = mode === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onMode(item.id)}
                className={`rounded-md border px-2.5 py-2 text-left ${
                  on ? "border-accent bg-wash" : "border-line hover:bg-wash"
                }`}
              >
                <span className="block text-[13px] font-medium text-ink">{item.label}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted">{item.detail}</span>
              </button>
            );
          })}
        </div>
        <div className="overflow-hidden rounded-lg bg-inset/70">
          {PERMISSION_ACTIONS.map((action, index) => {
            const effect = permissionEffect(mode, action.id);
            return (
              <div
                key={action.id}
                className={`flex items-center justify-between gap-3 px-3 py-2 ${index > 0 ? "border-t border-line/70" : ""}`}
              >
                <span className="text-[13px] text-ink">{action.label}</span>
                <span
                  className={`text-[12px] font-medium ${
                    effect === "block" ? "text-err" : effect === "ask" ? "text-ink" : "text-ok"
                  }`}
                >
                  {EFFECT_LABEL[effect]}
                </span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function Section({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <div>
        <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
        <p className="mt-1 mb-0 text-[12px] leading-relaxed text-muted">{text}</p>
      </div>
      {children}
    </section>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="grid gap-1.5 rounded-lg bg-inset/70 px-3 py-2.5">{children}</div>;
}

function Row({
  label,
  value,
  mono,
  ok,
  title,
  action,
}: {
  label: string;
  value: string;
  mono?: boolean;
  ok?: boolean;
  title?: string;
  action?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2">
      <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">{label}</span>
      <span className="flex min-w-0 items-center gap-1">
        <span
          title={title}
          className={`min-w-0 truncate text-[12px] ${mono ? "font-mono" : ""} ${ok ? "text-ok" : "text-ink"}`}
        >
          {value}
        </span>
        {action}
      </span>
    </div>
  );
}

function Toggle({
  title,
  text,
  checked,
  onChange,
}: {
  title: string;
  text: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-ink">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">{text}</span>
      </span>
    </label>
  );
}

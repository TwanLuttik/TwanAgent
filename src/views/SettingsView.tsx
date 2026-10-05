import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../components/Button";
import { ThemePicker } from "../components/ThemePicker";
import { formatBytes } from "../lib/usage";
import { folderName } from "../lib/core";
import {
  PERMISSION_MODES,
  parsePermissionMode,
  permissionDetail,
  type PermissionMode,
} from "../lib/permission";
import {
  loadFileHoverCard,
  loadMarkdownOpenMode,
  loadPerfOverlay,
  loadSpaceCorner,
  saveMarkdownOpenMode,
  setFileHoverCard,
  setPerfOverlay,
  setSpaceCorner,
  type MarkdownOpenMode,
} from "../lib/prefs";
import { loadTheme, type ThemeSelection } from "../lib/theme";
import * as api from "../lib/tauri";
import type { GrokCliInfo, UsageDbInfo } from "../lib/tauri";
import { useApp } from "../state/app-state";

export type SettingsTab = "appearance" | "grok" | "storage" | "permissions";

const SETTINGS_TABS: { id: SettingsTab; label: string; hint: string }[] = [
  { id: "grok", label: "Grok", hint: "CLI and API key" },
  { id: "permissions", label: "Permissions", hint: "Folders and tools" },
  { id: "storage", label: "Storage", hint: "Usage database" },
  { id: "appearance", label: "Appearance", hint: "Theme and display" },
];

export function SettingsView({
  initialTab = "appearance",
  embedded = false,
  permission: permissionProp,
  onPermission,
  onKeyChange,
  onClose,
}: {
  initialTab?: SettingsTab;
  embedded?: boolean;
  permission?: PermissionMode;
  onPermission?: (id: PermissionMode) => void;
  onKeyChange?: () => void;
  onClose?: () => void;
} = {}) {
  const { setFlash } = useApp();
  const [theme, setThemeSel] = useState<ThemeSelection>(() => loadTheme());
  const [spaceArt, setSpaceArt] = useState(() => loadSpaceCorner());
  const [fileHoverCard, setFileHoverCardOn] = useState(() => loadFileHoverCard());
  const [perfOverlay, setPerfOverlayOn] = useState(() => loadPerfOverlay());
  const [markdownOpen, setMarkdownOpen] = useState<MarkdownOpenMode>(() => loadMarkdownOpenMode());
  const version = __APP_VERSION_LABEL__;
  const [xaiKey, setXaiKey] = useState("");
  const [keyStatus, setKeyStatus] = useState<{ saved: boolean; env: boolean } | null>(null);
  const [savingKey, setSavingKey] = useState(false);
  const [cli, setCli] = useState<GrokCliInfo | null>(null);
  const [db, setDb] = useState<UsageDbInfo | null>(null);
  const [resettingDb, setResettingDb] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  const [addingFolder, setAddingFolder] = useState(false);
  const [permissionLocal, setPermissionLocal] = useState<PermissionMode>(() => parsePermissionMode(permissionProp));
  const permission = permissionProp ?? permissionLocal;
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  useEffect(() => {
    if (!onClose) return;
    const close = onClose;
    function onKey(ev: KeyboardEvent) {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let gone = false;
    void api
      .keyStatus()
      .then((s) => {
        if (!gone) setKeyStatus(s);
      })
      .catch(() => undefined);
    void api
      .cliInfo()
      .then((info) => {
        if (!gone) setCli(info);
      })
      .catch(() => undefined);
    void api
      .usageDbInfo()
      .then((info) => {
        if (!gone) setDb(info);
      })
      .catch(() => undefined);
    void api
      .openedWorkspaces()
      .then((rows) => {
        if (!gone) setFolders(rows);
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, []);

  const body = (
    <div className="flex min-h-0 flex-1">
      <nav className="flex w-[168px] shrink-0 flex-col gap-0.5 border-r border-line/70 px-2 py-3" aria-label="Settings">
        {SETTINGS_TABS.map((opt) => {
          const on = tab === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              aria-current={on ? "page" : undefined}
              onClick={() => setTab(opt.id)}
              className={`rounded-md px-2.5 py-1.5 text-left ${
                on ? "bg-wash-strong text-ink" : "text-muted hover:bg-wash hover:text-ink"
              }`}
            >
              <span className="block text-[13px] font-medium">{opt.label}</span>
              <span className="block truncate text-[11px] text-muted">{opt.hint}</span>
            </button>
          );
        })}
        <div className="mt-auto px-2.5 pt-4">
          <div className="text-[12px] font-medium text-ink">TwanAgent{version ? ` ${version}` : ""}</div>
          <div className="text-[11px] text-muted">Desktop Grok workspace</div>
        </div>
      </nav>
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="grid max-w-[520px] gap-4">
          {tab === "appearance" && (
            <Section title="Appearance" text="Finder is the default. Custom builds a theme from light or dark plus accent, background, and sidebar.">
              <ThemePicker value={theme} onChange={setThemeSel} />
              <Toggle
                title="Space corner"
                text="Show a faded starfield in the top-left of the sidebar."
                checked={spaceArt}
                onChange={(next) => {
                  setSpaceArt(next);
                  setSpaceCorner(next);
                }}
              />
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

          {tab === "grok" && (
            <Section
              title="Grok"
              text="TwanAgent uses the Grok CLI login when it can find one, then a key saved here, then XAI_API_KEY."
            >
              <Card>
                <Row label="CLI" value={cli ? (cli.installed ? "Installed" : "Not found") : "Checking…"} ok={cli?.installed} />
                <Row label="Path" value={cli?.path || "—"} mono />
                <Row label="Version" value={cli?.version || "—"} />
                <Row
                  label="Login"
                  value={
                    cli?.logged_in
                      ? cli.email || "Signed in"
                      : cli
                        ? "Not signed in"
                        : "—"
                  }
                  ok={cli?.logged_in}
                />
              </Card>
              <label className="grid gap-1">
                <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">xAI API key</span>
                <input
                  type="password"
                  value={xaiKey}
                  autoComplete="off"
                  placeholder={keyStatus?.saved ? "Key saved — paste to replace" : "xai-…"}
                  onChange={(e) => setXaiKey(e.target.value)}
                  className="h-8 rounded-md border border-line bg-canvas px-2.5 text-[13px] outline-none focus:border-accent"
                />
              </label>
              <p className="m-0 text-[12px] text-muted">
                {keyStatus?.saved
                  ? "Using the saved key."
                  : keyStatus?.env
                    ? "Using XAI_API_KEY from the environment."
                    : "No key saved here."}
              </p>
              <div className="flex justify-end gap-2">
                {keyStatus?.saved && (
                  <Button
                    disabled={savingKey}
                    onClick={() => {
                      setSavingKey(true);
                      void api
                        .clearKey()
                        .then((s) => {
                          setKeyStatus(s);
                          setXaiKey("");
                          onKeyChange?.();
                          setFlash({ kind: "ok", text: "Removed the saved xAI key." });
                        })
                        .catch((e) => setFlash({ kind: "err", text: String(e) }))
                        .finally(() => setSavingKey(false));
                    }}
                  >
                    Clear
                  </Button>
                )}
                <Button
                  variant="primary"
                  disabled={savingKey || !xaiKey.trim()}
                  onClick={() => {
                    setSavingKey(true);
                    void api
                      .setKey(xaiKey.trim())
                      .then((s) => {
                        setKeyStatus(s);
                        setXaiKey("");
                        onKeyChange?.();
                        setFlash({ kind: "ok", text: "Saved the xAI API key." });
                      })
                      .catch((e) => setFlash({ kind: "err", text: String(e) }))
                      .finally(() => setSavingKey(false));
                  }}
                >
                  {savingKey ? "Saving…" : "Save key"}
                </Button>
              </div>
            </Section>
          )}

          {tab === "storage" && (
            <Section
              title="Storage"
              text="Usage history is kept in a local SQLite file. Resetting it clears the usage chart and does not delete chats."
            >
              <Card>
                <Row label="File" value={db?.path || "Checking…"} mono />
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
                            setDb(info);
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
                <div className="flex justify-end">
                  <Button variant="danger" disabled={!db?.exists || resettingDb} onClick={() => setConfirmReset(true)}>
                    Reset database
                  </Button>
                </div>
              )}
            </Section>
          )}

          {tab === "permissions" && (
            <Section
              title="Permissions"
              text="Grok can only read and edit folders you have opened. Tool permissions decide whether edits and shell commands need approval."
            >
              <div className="grid gap-1.5">
                {PERMISSION_MODES.map((mode) => {
                  const on = permission === mode.id;
                  return (
                    <button
                      key={mode.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => {
                        if (onPermission) onPermission(mode.id);
                        else setPermissionLocal(mode.id);
                      }}
                      className={`rounded-md border px-3 py-2 text-left ${
                        on ? "border-accent bg-wash" : "border-line hover:bg-wash"
                      }`}
                    >
                      <span className="block text-[13px] font-medium text-ink">{mode.label}</span>
                      <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">
                        {permissionDetail(mode.id)}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[13px] font-medium text-ink">Allowed folders</div>
                  <div className="text-[12px] text-muted">Disk access for chats, files, and commands.</div>
                </div>
                <Button
                  disabled={addingFolder}
                  onClick={() => {
                    setAddingFolder(true);
                    void api
                      .pickDir()
                      .then(async (path) => {
                        if (!path) return;
                        const opened = await api.openFolder(path);
                        setFolders((rows) => (rows.includes(opened) ? rows : [...rows, opened].sort()));
                        setFlash({ kind: "ok", text: `Allowed ${folderName(opened)}.` });
                      })
                      .catch((e) => setFlash({ kind: "err", text: String(e) }))
                      .finally(() => setAddingFolder(false));
                  }}
                >
                  {addingFolder ? "Opening…" : "Add folder"}
                </Button>
              </div>
              {folders.length === 0 ? (
                <p className="m-0 text-[12px] text-muted">No folders yet. Open a project to allow it.</p>
              ) : (
                <div className="grid gap-1">
                  {folders.map((path) => (
                    <div key={path} className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] text-ink">{folderName(path)}</div>
                        <div className="truncate font-mono text-[11px] text-muted">{path}</div>
                      </div>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          void api
                            .forgetWorkspace(path)
                            .then(() => {
                              setFolders((rows) => rows.filter((row) => row !== path));
                              setFlash({ kind: "ok", text: `Removed access to ${folderName(path)}.` });
                            })
                            .catch((e) => setFlash({ kind: "err", text: String(e) }));
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </Section>
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
  return <div className="grid gap-1.5 rounded-md border border-line bg-panel px-3 py-2.5">{children}</div>;
}

function Row({ label, value, mono, ok }: { label: string; value: string; mono?: boolean; ok?: boolean }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] items-baseline gap-2">
      <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">{label}</span>
      <span className={`min-w-0 truncate text-[12px] ${mono ? "font-mono" : ""} ${ok ? "text-ok" : "text-ink"}`}>
        {value}
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

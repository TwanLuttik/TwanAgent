import { useEffect, useState } from "react";
import { Button } from "../components/Button";
import { ThemePicker } from "../components/ThemePicker";
import {
  loadFileHoverCard,
  loadMarkdownOpenMode,
  loadSpaceCorner,
  saveMarkdownOpenMode,
  setFileHoverCard,
  setSpaceCorner,
  type MarkdownOpenMode,
} from "../lib/prefs";
import { loadTheme, type ThemeSelection } from "../lib/theme";
import * as api from "../lib/tauri";
import { useApp } from "../state/app-state";

export type SettingsTab = "appearance" | "grok";

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "grok", label: "Grok" },
];

export function SettingsView({
  initialTab = "appearance",
  embedded = false,
  onKeyChange,
  onClose,
}: {
  initialTab?: SettingsTab;
  embedded?: boolean;
  onKeyChange?: () => void;
  onClose?: () => void;
} = {}) {
  const { setFlash } = useApp();
  const [theme, setThemeSel] = useState<ThemeSelection>(() => loadTheme());
  const [spaceArt, setSpaceArt] = useState(() => loadSpaceCorner());
  const [fileHoverCard, setFileHoverCardOn] = useState(() => loadFileHoverCard());
  const [markdownOpen, setMarkdownOpen] = useState<MarkdownOpenMode>(() => loadMarkdownOpenMode());
  const [version, setVersion] = useState("");
  const [xaiKey, setXaiKey] = useState("");
  const [keyStatus, setKeyStatus] = useState<{ saved: boolean; env: boolean } | null>(null);
  const [savingKey, setSavingKey] = useState(false);
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
      .appVersion()
      .then((v) => {
        if (!gone) setVersion(v);
      })
      .catch(() => undefined);
    void api
      .devKeyStatus()
      .then((s) => {
        if (!gone) setKeyStatus(s);
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, []);

  const tabs = (
    <div className="flex gap-1">
      {SETTINGS_TABS.map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => setTab(opt.id)}
          className={`rounded-[6px] px-2 py-1 text-[12px] ${
            tab === opt.id ? "bg-wash-strong text-ink" : "text-muted hover:text-ink"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );

  const body = (
    <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
      <div className="grid max-w-[420px] gap-5">
        {tabs}
        {tab === "appearance" && (
          <>
            <section className="grid gap-3">
              <h2 className="m-0 text-[13px] font-semibold">Appearance</h2>
              <p className="m-0 text-[12px] leading-relaxed text-muted">
                Finder is the default. Custom builds a theme from light or dark plus accent,
                background, and sidebar.
              </p>
              <ThemePicker value={theme} onChange={setThemeSel} />
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={spaceArt}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setSpaceArt(next);
                    setSpaceCorner(next);
                  }}
                />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-ink">Space corner</span>
                  <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">
                    Show a faded starfield in the top-left of the sidebar.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={fileHoverCard}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setFileHoverCardOn(next);
                    setFileHoverCard(next);
                  }}
                />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-ink">File hover cards</span>
                  <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">
                    Show a small preview when you hover a file name in chat.
                  </span>
                </span>
              </label>
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
                        markdownOpen === opt.id
                          ? "bg-wash-strong text-ink"
                          : "text-muted hover:text-ink"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </section>
            <section className="grid gap-1 border-t border-line pt-5">
              <h2 className="m-0 text-[13px] font-semibold">About</h2>
              <p className="m-0 text-[13px]">TwanAgent{version ? ` ${version}` : ""}</p>
              <p className="m-0 text-[12px] text-muted">Desktop Grok workspace for this computer.</p>
            </section>
          </>
        )}

        {tab === "grok" && (
          <section className="grid gap-3">
            <h2 className="m-0 text-[13px] font-semibold">Grok</h2>
            <p className="m-0 text-[12px] leading-relaxed text-muted">
              TwanAgent talks to Grok only. It uses the Grok CLI login when that’s available, then a
              key saved here, then <code className="rounded bg-inset px-1">XAI_API_KEY</code>.
            </p>
            <label className="grid gap-1">
              <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">
                xAI API key
              </span>
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
                  : "No key yet."}
            </p>
            <div className="flex justify-end gap-2">
              {keyStatus?.saved && (
                <Button
                  disabled={savingKey}
                  onClick={() => {
                    setSavingKey(true);
                    void api
                      .devClearKey()
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
                    .devSetKey(xaiKey.trim())
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
          </section>
        )}
      </div>
    </div>
  );

  if (embedded) {
    return <div className="flex min-h-0 flex-1 flex-col">{body}</div>;
  }
  return body;
}

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "motion/react";
import { Symbol } from "../../components/Symbol";
import { useMain } from "../main/context";
import { SettingsView, SETTINGS_TABS, type SettingsTab } from "../SettingsView";

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * Settings stays mounted after the first open. Hiding it only plays the
 * transition, so closing does not tear the page down or restart its checks.
 */
export function SettingsDialog() {
  const {
    closeSettings,
    downloadSpeech,
    folderOpen,
    permission,
    pickPermission,
    pickSpeechModel,
    reloadRuntime,
    settingsTab,
    setSettingsTab,
    showSettings,
    speechDownloading,
    speechModel,
    speechModels,
    speechProgress,
  } = useMain();
  const [alive, setAlive] = useState(showSettings);
  const panelRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  if (showSettings && !alive) setAlive(true);
  useEffect(() => {
    if (!showSettings) return;
    panelRef.current?.focus();
  }, [showSettings, alive]);
  if (!alive) return null;

  const close = folderOpen || !showSettings ? undefined : closeSettings;
  const duration = reduceMotion ? 0 : 0.2;

  return createPortal(
    <motion.div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45"
      initial={{ opacity: 0 }}
      animate={{ opacity: showSettings ? 1 : 0 }}
      transition={{ duration, ease: EASE }}
      style={{ pointerEvents: showSettings ? "auto" : "none" }}
      inert={!showSettings}
      onMouseDown={() => close?.()}
    >
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal={showSettings}
        aria-hidden={!showSettings}
        aria-label="Settings"
        tabIndex={-1}
        className="relative flex h-[70%] w-[70%] min-h-0 min-w-0 overflow-hidden rounded-xl border border-line bg-canvas shadow-card outline-none"
        initial={reduceMotion ? false : { y: 10, scale: 0.98 }}
        animate={showSettings ? { y: 0, scale: 1 } : { y: 8, scale: 0.98 }}
        transition={{ duration, ease: EASE }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <SettingsNav tab={settingsTab} onTab={setSettingsTab} />
        <button
          type="button"
          aria-label="Close settings"
          title="Close"
          onClick={() => close?.()}
          className="absolute top-2 right-2 z-10 flex size-7 items-center justify-center rounded-[6px] text-muted hover:bg-wash hover:text-ink"
        >
          <Symbol name="xmark" className="size-3.5" />
        </button>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <SettingsView
            embedded
            active={showSettings}
            tab={settingsTab}
            onTab={setSettingsTab}
            permission={permission}
            onPermission={pickPermission}
            speechModel={speechModel}
            speechModels={speechModels}
            speechProgress={speechProgress}
            speechDownloading={speechDownloading}
            onSpeechModel={pickSpeechModel}
            onSpeechDownload={downloadSpeech}
            onKeyChange={reloadRuntime}
            onClose={close}
          />
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}

function SettingsNav({ tab, onTab }: { tab: SettingsTab; onTab: (id: SettingsTab) => void }) {
  return (
    <nav
      className="flex w-52 shrink-0 flex-col overflow-auto border-r border-line/55 bg-sidebar px-2 py-3"
      aria-label="Settings"
    >
      {SETTINGS_TABS.map((opt, index) => {
        const on = tab === opt.id;
        const groupStart = index === 0 || SETTINGS_TABS[index - 1]?.group !== opt.group;
        return (
          <div key={opt.id} className={groupStart && index > 0 ? "mt-2" : undefined}>
            {groupStart ? (
              <div className="px-2 pt-1.5 pb-1 text-[10px] font-semibold tracking-[0.08em] text-muted uppercase">
                {opt.group}
              </div>
            ) : null}
            <button
              type="button"
              aria-current={on ? "page" : undefined}
              title={opt.hint}
              onClick={() => onTab(opt.id)}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] ${
                on ? "bg-wash-strong text-ink" : "text-ink/85 hover:bg-wash"
              }`}
            >
              <Symbol name={opt.icon} className={`size-4 shrink-0 ${on ? "text-ink" : "text-muted"}`} />
              <span className="min-w-0 truncate">{opt.label}</span>
            </button>
          </div>
        );
      })}
    </nav>
  );
}

import { DropImagesHint } from "../../components/ChatTranscript";
import { Flash } from "../../components/Flash";
import { FolderDialog } from "../../components/FolderDialog";
import { SpaceCorner } from "../../components/SpaceCorner";
import { Symbol } from "../../components/Symbol";
import { headerBarClass, isMacOS, WindowButtons } from "../../components/WindowButtons";
import { useMain } from "./context";
import { SessionComposer } from "./SessionComposer";

export function LandingScreen() {
  const {
    applyWorkspace,
    fileDrag,
    folderOpen,
    openSettings,
    openUsage,
    recents,
    runtime,
    setFolderOpen,
    startNewChat,
    workspace,
  } = useMain();

  return (
    <div className="relative flex h-full min-w-0 flex-col overflow-hidden bg-canvas">
      <Flash />
      <SpaceCorner />
      <div className={`relative z-10 flex shrink-0 items-center ${headerBarClass()}`} data-tauri-drag-region>
        <WindowButtons />
        <div className="min-w-0 flex-1" data-tauri-drag-region />
        <button
          type="button"
          aria-label="Usage"
          title="Usage"
          onClick={openUsage}
          className="mr-1 flex size-7 items-center justify-center rounded-[6px] text-muted hover:bg-wash hover:text-ink"
        >
          <Symbol name="chart.xyaxis.line" className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="Settings"
          title={isMacOS() ? "Settings ⌘," : "Settings Ctrl+,"}
          onClick={openSettings}
          className="mr-1 flex size-7 items-center justify-center rounded-[6px] text-muted hover:bg-wash hover:text-ink"
        >
          <Symbol name="gearshape" className="size-3.5" />
        </button>
      </div>
      {folderOpen ? (
        <FolderDialog
          onClose={() => setFolderOpen(false)}
          onPick={applyWorkspace}
          showProjects
          recents={recents}
        />
      ) : null}
      <div className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-16">
        {fileDrag ? <DropImagesHint /> : null}
        <div className="w-full max-w-[640px]">
          <SessionComposer placement="landing" />
          {runtime && !runtime.ready && runtime.hint && (
            <p className="mt-3 text-center text-[12px] text-muted">{runtime.hint}</p>
          )}
          {workspace ? (
            <p className="mt-4 text-center">
              <button
                type="button"
                onClick={() => void startNewChat("terminal")}
                className="text-[12px] text-muted hover:text-ink"
              >
                Open a Grok terminal
              </button>
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

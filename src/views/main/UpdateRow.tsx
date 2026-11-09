import { updateButtonLabel, updateCopy, versionCore } from "../../lib/update";
import { failUpdateDemo, installAppUpdate, relaunchAppUpdate, toggleUpdateDemo, useAppUpdate } from "../../lib/update-store";
import { useApp } from "../../state/app-state";

export function VersionChip() {
  const { dev, demo } = useAppUpdate();
  return (
    <p
      className="flex min-w-0 items-center gap-1 truncate text-[11px] tabular-nums text-muted/55"
      title={`TwanAgent ${__APP_VERSION_LABEL__}`}
    >
      <span className="truncate">{versionCore(__APP_VERSION_LABEL__)}</span>
      {dev ? (
        <button
          type="button"
          onClick={() => toggleUpdateDemo()}
          aria-pressed={demo}
          title={demo ? "Stop the update preview" : "Preview an update"}
          className={`shrink-0 rounded-[4px] px-1 py-px text-[10px] font-semibold tracking-wide uppercase ${
            demo ? "bg-accent/15 text-accent" : "bg-wash text-muted hover:text-ink"
          }`}
        >
          {demo ? "Demo on" : "Demo"}
        </button>
      ) : null}
    </p>
  );
}

export function UpdateNotice() {
  const { setFlash } = useApp();
  const { update, phase, received, total, error, demo } = useAppUpdate();
  if (!update) return null;

  const bytes = total || update.bytes;
  const busy = phase === "downloading" || phase === "installing";
  const copy = updateCopy(phase, update.version, update.notes, received, bytes, error);
  const ratio = bytes > 0 ? Math.min(1, received / bytes) : phase === "installing" ? 1 : 0;
  const percent = Math.round(ratio * 100);
  const showFail = demo && busy;

  function install() {
    void installAppUpdate();
  }

  function restart() {
    void relaunchAppUpdate().catch((err) => setFlash({ kind: "err", text: String(err) }));
  }

  return (
    <div className="px-2 py-1">
      <div className="flex items-center gap-2">
        <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
          <span className={`size-1.5 rounded-full ${phase === "error" ? "bg-err" : "bg-accent"}`} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] leading-4 text-ink">{copy.title}</p>
          {copy.detail ? (
            <p
              className={`truncate text-[11px] leading-4 ${phase === "error" ? "text-err" : "text-muted/80"}`}
              title={copy.detail}
            >
              {copy.detail}
            </p>
          ) : null}
        </div>
        {busy ? (
          <span className="flex shrink-0 items-center gap-2">
            {showFail ? (
              <button type="button" onClick={() => failUpdateDemo()} className="text-[11px] text-muted hover:text-ink">
                Fail
              </button>
            ) : null}
            {phase === "downloading" ? (
              <span className="min-w-9 text-right text-[11px] tabular-nums text-muted">{percent}%</span>
            ) : null}
          </span>
        ) : (
          <button
            type="button"
            aria-label={updateButtonLabel(phase, received, bytes)}
            onClick={phase === "ready" ? restart : install}
            className="shrink-0 rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-medium text-on-accent hover:bg-accent-hover"
          >
            {updateButtonLabel(phase, received, bytes)}
          </button>
        )}
      </div>
      {busy ? (
        <div
          className="mt-1.5 ml-6 h-[3px] overflow-hidden rounded-full bg-ink/10"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={updateButtonLabel(phase, received, bytes)}
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-150 ease-out motion-reduce:transition-none"
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

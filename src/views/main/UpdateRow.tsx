import { Symbol } from "../../components/Symbol";
import { updateButtonLabel, updateNote } from "../../lib/update";
import { installAppUpdate, relaunchAppUpdate, useAppUpdate } from "../../lib/update-store";
import { useApp } from "../../state/app-state";

export function UpdateRow() {
  const { setFlash } = useApp();
  const { update, phase, received, total, dev } = useAppUpdate();
  const busy = phase === "downloading" || phase === "installing";
  const note = update ? updateNote(update.notes) : "";
  const label = update ? updateButtonLabel(phase, received, total || update.bytes) : "";
  const tip = update
    ? phase === "ready"
      ? `${update.version} is installed. Restart to open it.`
      : [label, note || `${update.version} is available.`].filter(Boolean).join("\n")
    : "";

  function install() {
    if (!update || busy) return;
    void installAppUpdate().then((error) => {
      if (error) setFlash({ kind: "err", text: error });
    });
  }

  function restart() {
    void relaunchAppUpdate().catch((err) => setFlash({ kind: "err", text: String(err) }));
  }

  return (
    <div className="flex shrink-0 items-center gap-1 pr-1">
      <p
        className="flex min-w-0 items-center gap-1 truncate text-[11px] tabular-nums text-muted/55"
        title={`TwanAgent ${__APP_VERSION_LABEL__}`}
      >
        <span className="truncate">{__APP_VERSION_LABEL__}</span>
        {dev ? (
          <span className="shrink-0 rounded-[4px] bg-wash px-1 py-px text-[10px] font-semibold tracking-wide text-muted uppercase">
            Dev
          </span>
        ) : null}
      </p>
      {update ? (
        <span className="group/tip relative">
          <button
            type="button"
            disabled={busy}
            aria-label={label}
            onClick={phase === "ready" ? restart : install}
            className="flex size-6 items-center justify-center rounded-[6px] bg-accent text-on-accent hover:bg-accent-hover disabled:opacity-60"
          >
            <Symbol name={phase === "ready" ? "arrow.clockwise" : "arrow.down.to.line"} className="size-3.5" />
          </button>
          <span
            role="tooltip"
            className="pointer-events-none absolute bottom-full right-0 z-30 mb-1 hidden w-max max-w-56 rounded-md border border-line/25 bg-canvas px-2 py-1 text-left text-[11px] leading-snug whitespace-pre-line text-ink shadow-card group-hover/tip:block"
          >
            {tip}
          </span>
        </span>
      ) : null}
    </div>
  );
}

import { useEffect } from "react";

export function ProjectSettingsView({
  name,
  path,
  onClose,
}: {
  name: string;
  path: string;
  onClose?: () => void;
}) {
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

  return (
    <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
      <div className="mx-auto grid w-full max-w-[420px] gap-5">
        <div>
          <h1 className="m-0 text-[15px] font-semibold">Project settings</h1>
          <p className="mt-1 mb-0 text-[12px] leading-relaxed text-muted">{name}</p>
        </div>
        <section className="grid gap-1">
          <h2 className="m-0 text-[11px] font-semibold tracking-wide text-muted uppercase">Folder path</h2>
          <p className="m-0 rounded-md border border-line bg-inset px-2.5 py-2 font-mono text-[12px] leading-relaxed break-all text-ink">
            {path}
          </p>
        </section>
      </div>
    </div>
  );
}

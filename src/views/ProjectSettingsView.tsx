import { useEffect } from "react";
import { Group, Page } from "./settings/SettingsChrome";

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
    <div className="min-h-0 flex-1 overflow-auto px-8 py-6">
      <div className="mx-auto grid w-full max-w-[640px]">
        <Page title="Project" text={name}>
          <Group title="Folder">
            <p className="m-0 px-3.5 py-3 font-mono text-[12px] leading-relaxed break-all text-ink">{path}</p>
          </Group>
        </Page>
      </div>
    </div>
  );
}

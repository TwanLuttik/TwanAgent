import { Button } from "../../components/Button";
import { Symbol } from "../../components/Symbol";
import { folderName } from "../../lib/core";
import {
  PERMISSION_ACTIONS,
  PERMISSION_MODES,
  permissionEffect,
  type PermissionMode,
} from "../../lib/permission";

const EFFECT_LABEL: Record<ReturnType<typeof permissionEffect>, string> = {
  allow: "Allowed",
  ask: "Asks first",
  block: "Blocked",
};

export function PermissionsPane({
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

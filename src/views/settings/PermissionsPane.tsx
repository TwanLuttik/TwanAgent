import { Button } from "../../components/Button";
import { Symbol } from "../../components/Symbol";
import { folderName } from "../../lib/core";
import {
  PERMISSION_ACTIONS,
  PERMISSION_MODES,
  permissionEffect,
  type PermissionMode,
} from "../../lib/permission";
import { Block, Group, Page } from "./SettingsChrome";

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
    <Page title="Permissions" text="Folders you have approved, and what the open chat is allowed to do.">
      <Group
        title="Folders"
        text="Approve a folder once. Access stays until you remove it, including after you quit."
        action={
          <Button size="sm" disabled={adding} onClick={onAdd}>
            {adding ? "Opening…" : "Add folder"}
          </Button>
        }
      >
        {folders.length === 0 ? (
          <p className="m-0 px-3.5 py-3 text-[12px] leading-relaxed text-muted">
            No folders yet. Add one, or open a project. macOS may ask the first time. It should not ask again.
          </p>
        ) : (
          folders.map((path) => (
            <div key={path} className="flex items-center gap-2 px-3.5 py-2">
              <Symbol name="folder" className="size-3.5 shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-ink">{folderName(path)}</div>
                <div className="truncate font-mono text-[11px] text-muted" title={path}>
                  {path}
                </div>
              </div>
              <Button size="sm" variant="danger" onClick={() => onRemove(path)}>
                Remove
              </Button>
            </div>
          ))
        )}
      </Group>

      <Group title="This chat" text="Reading is always allowed inside an approved folder.">
        <Block>
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
                  className={`rounded-lg border px-2.5 py-2 text-left ${
                    on ? "border-accent bg-canvas" : "border-line/70 hover:bg-wash"
                  }`}
                >
                  <span className="block text-[13px] font-medium text-ink">{item.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted">{item.detail}</span>
                </button>
              );
            })}
          </div>
        </Block>
        {PERMISSION_ACTIONS.map((action) => {
          const effect = permissionEffect(mode, action.id);
          return (
            <div key={action.id} className="flex items-center justify-between gap-3 px-3.5 py-2">
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
      </Group>
    </Page>
  );
}

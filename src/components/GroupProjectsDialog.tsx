import { useState } from "react";
import { createPortal } from "react-dom";

export function GroupProjectsDialog({
  count,
  onCancel,
  onConfirm,
}: {
  count: number;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20" onMouseDown={onCancel}>
      <form
        role="dialog"
        aria-label="Group projects"
        className="w-[320px] rounded-lg border border-line bg-canvas p-3 shadow-card"
        onMouseDown={(ev) => ev.stopPropagation()}
        onSubmit={(ev) => {
          ev.preventDefault();
          if (trimmed) onConfirm(trimmed);
        }}
      >
        <div className="text-[13px] font-medium text-ink">Group {count} projects</div>
        <p className="mt-1 text-[12px] text-muted">
          The folders stay where they are. A new chat in the group can read and edit all of them.
        </p>
        <input
          autoFocus
          value={name}
          onChange={(ev) => setName(ev.target.value)}
          placeholder="Group name"
          aria-label="Group name"
          className="mt-3 w-full rounded-[6px] bg-wash px-2 py-1.5 text-[13px] text-ink outline-none"
        />
        <div className="mt-3 flex items-center justify-end gap-1.5">
          <button type="button" onClick={onCancel} className="rounded-[6px] px-2 py-1 text-[12px] text-muted hover:bg-wash">
            Cancel
          </button>
          <button
            type="submit"
            disabled={!trimmed}
            className="rounded-[6px] bg-accent px-2 py-1 text-[12px] text-white disabled:opacity-40"
          >
            Group projects
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

export function RemoveGroupDialog({
  name,
  chats,
  onCancel,
  onConfirm,
}: {
  name: string;
  chats: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const chatLabel = chats === 1 ? "1 chat in the group" : `${chats} chats in the group`;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20" onMouseDown={onCancel}>
      <div
        role="dialog"
        aria-label={`Remove ${name}`}
        className="w-[320px] rounded-lg border border-line bg-canvas p-3 shadow-card"
        onMouseDown={(ev) => ev.stopPropagation()}
      >
        <div className="text-[13px] font-medium text-ink">Remove {name}?</div>
        <p className="mt-1 text-[12px] text-muted">
          This deletes the group and {chatLabel}. The project folders and their own chats stay.
        </p>
        <div className="mt-3 flex items-center justify-end gap-1.5">
          <button type="button" onClick={onCancel} className="rounded-[6px] px-2 py-1 text-[12px] text-muted hover:bg-wash">
            Cancel
          </button>
          <button type="button" onClick={onConfirm} className="rounded-[6px] bg-err px-2 py-1 text-[12px] text-white">
            Remove group
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

import { useEffect, useRef, useState } from "react";
import { ChromeTab, ChromeTabStrip } from "../../components/ChromeTabs";
import { Symbol } from "../../components/Symbol";
import { isMacOS } from "../../components/WindowButtons";
import type { EditorState } from "../../lib/editor";
import { chatHasRunningTurn, type RunningTurn } from "../../lib/turn";
import type { ConversationKind } from "../../lib/terminal-chat";

export function NewChatMenu({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (kind: ConversationKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(ev: MouseEvent) {
      if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={isMacOS() ? "New chat ⌘N" : "New chat Ctrl+N"}
        className="text-[11px] text-muted hover:text-ink disabled:opacity-35"
      >
        New chat
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute top-full right-0 z-30 mt-1 min-w-[148px] overflow-hidden rounded-md border border-line bg-canvas py-1 shadow-card"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onPick("chat");
              setOpen(false);
            }}
            className="flex w-full items-center justify-between gap-4 px-2.5 py-1.5 text-left text-[13px] text-ink/80 hover:bg-inset"
          >
            <span className="flex items-center gap-2">
              <Symbol name="bubble.left" className="size-3.5 text-muted" />
              Chat
            </span>
            <span className="text-[11px] text-muted">{isMacOS() ? "⌘N" : "Ctrl+N"}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onPick("terminal");
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] text-ink/80 hover:bg-inset"
          >
            <Symbol name="terminal" className="size-3.5 text-muted" />
            Terminal (deprecated)
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function CenterTabs({
  editor,
  chats,
  activeChatId,
  runningTurns,
  onChat,
  onCloseChat,
  onCode,
}: {
  editor: EditorState;
  chats: { id: string; title: string; kind: ConversationKind; running?: boolean }[];
  activeChatId: string;
  runningTurns?: Readonly<Record<string, RunningTurn>>;
  onChat: (id: string) => void;
  onCloseChat: (id: string) => void;
  onCode: () => void;
}) {
  const chatOn = editor.focus === "chat";
  const codeOn = editor.focus === "file";
  return (
    <ChromeTabStrip>
      {chats.map((chat) => {
        const terminal = chat.kind === "terminal";
        const running = chat.running ?? chatHasRunningTurn(runningTurns, chat.id);
        return (
          <ChromeTab
            key={chat.id}
            selected={chatOn && chat.id === activeChatId}
            label={chat.title || (terminal ? "Terminal" : "Chat")}
            icon={<Symbol name={terminal ? "terminal.fill" : "bubble.left.fill"} className="size-3.5 shrink-0" />}
            running={running}
            onClick={() => onChat(chat.id)}
            onClose={() => onCloseChat(chat.id)}
          />
        );
      })}
      {editor.tabs.length > 0 ? (
        <ChromeTab
          selected={codeOn}
          label="Code"
          icon={<Symbol name="doc.fill" className="size-3.5 shrink-0" />}
          onClick={onCode}
        />
      ) : null}
    </ChromeTabStrip>
  );
}

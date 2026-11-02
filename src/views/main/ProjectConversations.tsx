import { useMemo, useRef } from "react";
import { ConversationList } from "../../components/ConversationList";
import { chatSelectionKey, sidebarTodoKey } from "../../lib/all-projects";
import { conversationActivityLabel } from "../../lib/core";
import type { ConversationSummary } from "../../lib/tauri";
import type { TodoBadge } from "../../lib/todo";
import { useSidebar } from "./context";

export function ProjectConversations({
  conversations,
  path,
  dimmed,
  archivedView,
  reorderable = true,
  todoByChat,
  loadingId = "",
  selectedKeys,
  onSelectChat,
  onArchiveSelected,
}: {
  conversations: ConversationSummary[];
  path?: string;
  dimmed: boolean;
  archivedView?: boolean;
  /** Finished order is a view, so dragging would fight it. */
  reorderable?: boolean;
  todoByChat: Record<string, TodoBadge>;
  loadingId?: string;
  selectedKeys?: ReadonlySet<string>;
  onSelectChat?: (path: string, id: string, mods: { toggle: boolean; range: boolean }) => void;
  onArchiveSelected?: (id: string, archived: boolean) => void;
}) {
  const {
    activeId,
    archiveChat,
    openSidebarChat,
    removeChat,
    reorderChats,
    runningTurns,
    unseenFinished,
    openListedChat,
  } = useSidebar();
  const actions = useRef({
    archiveChat,
    openSidebarChat,
    removeChat,
    reorderChats,
    openListedChat,
  });
  actions.current = {
    archiveChat,
    openSidebarChat,
    removeChat,
    reorderChats,
    openListedChat,
  };
  const handlers = useMemo(
    () => ({
      onOpen: (id: string) =>
        path ? void actions.current.openSidebarChat(path, id) : actions.current.openListedChat(id),
      onSelect: path && onSelectChat
        ? (id: string, mods: { toggle: boolean; range: boolean }) => onSelectChat(path, id, mods)
        : undefined,
      onDelete: (id: string) => void actions.current.removeChat(id, path),
      onArchive: (id: string, archived: boolean) =>
        onArchiveSelected
          ? onArchiveSelected(id, archived)
          : void actions.current.archiveChat(id, archived, path),
      onReorder: (fromId: string, toId: string) => void actions.current.reorderChats(fromId, toId, path),
    }),
    [path, onSelectChat, onArchiveSelected],
  );
  const runningPreview = useMemo(
    () => (id: string) => conversationActivityLabel(runningTurns[id]?.activity),
    [runningTurns],
  );
  const todoFor = useMemo(
    () => (id: string) => {
      const live = runningTurns[id]?.todo;
      if (live) return { done: live.done, total: live.total, finished: false };
      if (id in runningTurns) return null;
      return todoByChat[sidebarTodoKey(path || "", id)] ?? null;
    },
    [runningTurns, todoByChat, path],
  );

  return (
    <ConversationList
      conversations={conversations}
      activeId={activeId}
      runningIds={runningTurns}
      unseenIds={unseenFinished}
      loadingId={loadingId}
      runningPreview={runningPreview}
      todoFor={todoFor}
      showSettings={dimmed}
      archivedView={archivedView}
      reorderable={reorderable}
      selectedIds={
        path && selectedKeys
          ? new Set(
              conversations
                .filter((row) => selectedKeys.has(chatSelectionKey(path, row.id)))
                .map((row) => row.id),
            )
          : undefined
      }
      {...handlers}
    />
  );
}

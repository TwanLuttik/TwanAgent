import { Composer } from "../../components/Composer";
import { contextWindowForModel } from "../../lib/context";
import { setImagesForChat } from "../../lib/image";
import type { ChatImage } from "../../lib/core";
import { todosFromMessages } from "../../lib/todo";
import { chatHasRunningTurn } from "../../lib/turn";
import { useMain } from "./context";

export function SessionComposer({ placement }: { placement: "landing" | "chat" }) {
  const {
    activeId,
    addPromptImages,
    busy,
    contextWindow,
    draft,
    draftPastes,
    mentionFiles,
    effort,
    messages,
    model,
    models,
    openFolder,
    permission,
    pickContextWindow,
    pickEffort,
    pickModel,
    pickPermission,
    promptImages,
    ready,
    runningId,
    runningTurns,
    send,
    setDraft,
    setDraftPastes,
    setDraftImages,
    stop,
    usageByChat,
    workspace,
  } = useMain();
  const landing = placement === "landing";
  return (
    <Composer
      draft={draft}
      onDraft={setDraft}
      onSend={() => void send()}
      onStop={stop}
      busy={landing ? busy && runningId === activeId : chatHasRunningTurn(runningTurns, activeId)}
      ready={ready}
      placeholder={
        ready ? (landing ? "Ask Grok…" : "Message Grok…") : landing ? "Sign in to Grok to start" : "Sign in to Grok to continue"
      }
      workspace={workspace}
      onOpenFolder={openFolder}
      models={models}
      model={model}
      onModel={pickModel}
      effort={effort}
      onEffort={pickEffort}
      contextWindow={contextWindow}
      onContextWindow={pickContextWindow}
      permission={permission}
      onPermission={pickPermission}
      autoFocus={landing}
      compact={!landing}
      usage={landing || !activeId ? undefined : usageByChat[activeId]}
      usageWindow={
        landing
          ? undefined
          : contextWindow > 0
            ? contextWindow
            : contextWindowForModel(
                model,
                models.find((row: { id: string; context_window?: number }) => row.id === model)?.context_window,
              )
      }
      mentionFiles={mentionFiles}
      pastes={draftPastes}
      onPastes={setDraftPastes}
      images={promptImages}
      onImages={(next: ChatImage[]) =>
        setDraftImages((prev: Record<string, ChatImage[]>) => setImagesForChat(prev, activeId, next))
      }
      onAddImages={(files) => void addPromptImages(files)}
      todos={todosFromMessages(messages)}
    />
  );
}

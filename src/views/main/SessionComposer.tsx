import { memo, useMemo } from "react";
import { Composer } from "../../components/Composer";
import { contextWindowForModel } from "../../lib/context";
import { providerProfile } from "../../lib/provider";
import { fileToBase64, setImagesForChat } from "../../lib/image";
import type { ChatImage } from "../../lib/core";
import { dictationFilename, insertTranscript } from "../../lib/speech";
import { todosFromMessages } from "../../lib/todo";
import { chatHasRunningTurn } from "../../lib/turn";
import { useApp } from "../../state/app-state";
import { useMain } from "./context";

export const SessionComposer = memo(function SessionComposer({ placement }: { placement: "landing" | "chat" }) {
  const {
    activeId,
    addPromptImages,
    contextWindow,
    draft,
    draftPastes,
    mentionFiles,
    allProjectGroups,
    applyWorkspace,
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
    pickPlanMode,
    planMode,
    promptImages,
    ready,
    remoteWorkspace,
    runtime,
    runningTurns,
    send,
    setDraft,
    setDraftPastes,
    setDraftImages,
    stop,
    usageByChat,
    workspace,
    dictate,
  } = useMain();
  const { setFlash } = useApp();
  const todos = useMemo(() => todosFromMessages(messages), [messages]);
  const landing = placement === "landing";
  const profile = providerProfile(model);
  const providerReady = runtime?.providers?.find((row: { id: string; ready: boolean }) => row.id === profile.id)?.ready ?? ready;
  const ask = `Ask ${profile.agentName}…`;
  const message = `Message ${profile.agentName}…`;
  const signIn = `Sign in to ${profile.agentName}`;
  return (
    <Composer
      onDictate={async (blob, mime) => {
        const filename = dictationFilename(mime);
        if (!filename) {
          setFlash({ kind: "err", text: "This browser recorded a format the local model cannot read." });
          return null;
        }
        try {
          const text = await dictate(await fileToBase64(blob), filename);
          return (draft, start, end) => insertTranscript(draft, start, end, text);
        } catch (err) {
          setFlash({ kind: "err", text: String(err) });
          return null;
        }
      }}
      onDictateError={(message) => setFlash({ kind: "err", text: message })}
      draft={draft}
      onDraft={setDraft}
      onSend={() => void send()}
      onStop={stop}
      busy={chatHasRunningTurn(runningTurns, activeId)}
      ready={providerReady}
      placeholder={
        providerReady ? (landing ? ask : message) : landing ? `${signIn} to start` : `${signIn} to continue`
      }
      workspace={workspace}
      projects={allProjectGroups}
      onOpenProject={(path) => applyWorkspace(path)}
      onOpenFolder={openFolder}
      models={models}
      model={model}
      onModel={pickModel}
      lockedProviders={remoteWorkspace ? remoteWorkspace.providers ?? [] : null}
      effort={effort}
      onEffort={pickEffort}
      contextWindow={contextWindow}
      onContextWindow={pickContextWindow}
      permission={permission}
      onPermission={pickPermission}
      planMode={profile.planMode ? planMode : undefined}
      onPlanMode={profile.planMode ? pickPlanMode : undefined}
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
      todos={todos}
      commandChatId={landing ? "" : activeId}
    />
  );
});

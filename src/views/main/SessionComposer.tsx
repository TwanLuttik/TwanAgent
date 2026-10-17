import { memo, useMemo, useState, useSyncExternalStore } from "react";
import { Composer } from "../../components/Composer";
import { bumpFileRefresh } from "../../lib/file-structure";
import * as api from "../../lib/tauri";
import {
  provisionalWorktreeName,
  publishWorktreeList,
  subscribeWorktreeLists,
  worktreeListsFor,
  worktreeNameForChat,
  worktreeNameFromPrompt,
  worktreeNameRevision,
} from "../../lib/worktree";
import { contextWindowForModel } from "../../lib/context";
import { providerProfile } from "../../lib/provider";
import { fileToBase64, imagesForChat, setImagesForChat } from "../../lib/image";
import type { ChatImage } from "../../lib/core";
import { dictationFilename, insertTranscript } from "../../lib/speech";
import { todosFromMessages } from "../../lib/todo";
import { chatHasRunningTurn, composerSettingsForChat, draftForChat } from "../../lib/turn";
import { useApp } from "../../state/app-state";
import { useMain } from "./context";

export const SessionComposer = memo(function SessionComposer({
  placement,
  chatId,
}: {
  placement: "landing" | "chat";
  /** Split panes pass the chat this input belongs to. The focused chat is the default. */
  chatId?: string;
}) {
  const {
    activeId,
    addPromptImages,
    contextWindow,
    conversations,
    draft,
    drafts,
    draftImages,
    draftPastes,
    mentionFiles,
    allProjectGroups,
    applyWorkspace,
    assignDraftProject,
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
    ready,
    remoteWorkspace,
    runtime,
    runningTurns,
    send,
    setDraft,
    setChatDraft,
    setDraftPastes,
    setDraftImages,
    stop,
    usageByChat,
    workspace,
    dictate,
  } = useMain();
  const { setFlash } = useApp();
  const [creatingWorktree, setCreatingWorktree] = useState(false);
  const [checkingOut, setCheckingOut] = useState(0);
  const worktreeTick = useSyncExternalStore(subscribeWorktreeLists, worktreeNameRevision, worktreeNameRevision);
  void worktreeTick;
  const boundId = chatId ?? activeId;
  const suggestedWorktree =
    worktreeNameForChat(boundId) ||
    worktreeNameFromPrompt(
      String(messages.find((item: { role: string; content?: string | null }) => item.role === "user")?.content ?? ""),
    );
  async function openPullRequest(number: number) {
    if (!workspace || creatingWorktree || checkingOut || !number) return;
    // A checkout that is already here just opens. The spinner is for the fetch.
    const branch = `pr/${number}`;
    const already = worktreeListsFor(workspace).some((row) => row.branch === branch);
    if (!already) setCheckingOut(number);
    try {
      const added = await api.gitPullRequestCheckout(workspace, number);
      publishWorktreeList(workspace, added.worktrees);
      bumpFileRefresh();
      if (added.opened) applyWorkspace(added.opened);
    } catch (err) {
      setFlash({ kind: "err", text: String(err) });
    } finally {
      setCheckingOut(0);
    }
  }
  async function createWorktree(branch: string) {
    // An empty name still checks out a folder. A later reply replaces that branch.
    const name = branch.trim() || suggestedWorktree || provisionalWorktreeName();
    if (!workspace || creatingWorktree) return;
    setCreatingWorktree(true);
    try {
      const added = await api.gitWorktreeAdd(workspace, name, true);
      publishWorktreeList(workspace, added.worktrees);
      bumpFileRefresh();
      if (added.opened) applyWorkspace(added.opened);
    } catch (err) {
      setFlash({ kind: "err", text: String(err) });
    } finally {
      setCreatingWorktree(false);
    }
  }
  const focused = !boundId || boundId === activeId;
  const row = conversations.find((item: { id: string }) => item.id === boundId);
  const settings = focused
    ? { model, effort, contextWindow, permission }
    : composerSettingsForChat(
        {
          model: row?.model,
          effort: row?.effort,
          contextWindow: row?.context_window,
          permission: row?.permission,
        },
        models,
        { model, effort, contextWindow, permission },
      );
  const boundDraft = focused ? draft : draftForChat(drafts, boundId);
  const boundImages = imagesForChat(draftImages, boundId);
  const writeDraft = focused ? setDraft : (text: string) => setChatDraft(boundId, text);
  const todos = useMemo(
    () => (boundId === activeId ? todosFromMessages(messages) : []),
    [boundId, activeId, messages],
  );
  const landing = placement === "landing";
  const projectOpen = !boundId || (focused && messages.length === 0);
  const profile = providerProfile(settings.model);
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
      draft={boundDraft}
      onDraft={writeDraft}
      onSend={() => void send(boundId)}
      onStop={() => stop(boundId)}
      busy={chatHasRunningTurn(runningTurns, boundId)}
      ready={providerReady}
      placeholder={
        providerReady ? (landing ? ask : message) : landing ? `${signIn} to start` : `${signIn} to continue`
      }
      workspace={workspace}
      projects={allProjectGroups}
      showProject={projectOpen}
      onOpenProject={(path) => {
        if (!boundId) assignDraftProject(path);
        else applyWorkspace(path);
      }}
      onOpenWorktree={(path) => {
        // A new chat only picks where the first prompt lands. Opening the folder
        // would load a conversation that checkout already has.
        if (!boundId) assignDraftProject(path);
        else applyWorkspace(path);
      }}
      onCreateWorktree={(branch) => void createWorktree(branch)}
      onOpenPullRequest={(number) => void openPullRequest(number)}
      checkingOutPullRequest={checkingOut}
      suggestedWorktree={suggestedWorktree}
      onOpenFolder={openFolder}
      models={models}
      model={settings.model}
      onModel={(id) => pickModel(id, boundId)}
      lockedProviders={boundId && remoteWorkspace ? remoteWorkspace.providers ?? [] : null}
      effort={settings.effort}
      onEffort={(id) => pickEffort(id, boundId)}
      contextWindow={settings.contextWindow}
      onContextWindow={(tokens) => pickContextWindow(tokens, boundId)}
      permission={settings.permission}
      onPermission={(id) => pickPermission(id, boundId)}
      planMode={profile.planMode && focused ? planMode : undefined}
      onPlanMode={profile.planMode && focused ? pickPlanMode : undefined}
      autoFocus={landing}
      compact={!landing}
      usage={landing || !boundId ? undefined : usageByChat[boundId]}
      usageWindow={
        landing
          ? undefined
          : settings.contextWindow > 0
            ? settings.contextWindow
            : contextWindowForModel(
                settings.model,
                models.find((item: { id: string; context_window?: number }) => item.id === settings.model)?.context_window,
              )
      }
      mentionFiles={mentionFiles}
      pastes={draftPastes}
      onPastes={setDraftPastes}
      images={boundImages}
      onImages={(next: ChatImage[]) =>
        setDraftImages((prev: Record<string, ChatImage[]>) => setImagesForChat(prev, boundId, next))
      }
      onAddImages={(files) => void addPromptImages(files, boundId)}
      todos={todos}
      commandChatId={landing ? "" : boundId}
    />
  );
});

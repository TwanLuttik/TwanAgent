import { useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { rememberCloudTranscripts } from "./useChatSession";
import {
  applyLiveProjectChats,
  isLocalCloudDraft,
  isSameProject,
  groupsFromSidebarSnapshot,
  mergeLoadedProjectGroups,
  placeProjectChats,
  sameSidebarConversationList,
  sidebarProjects,
  stampProjectServer,
  type ProjectChatGroup,
} from "../lib/all-projects";
import { projectKey } from "../lib/core";
import {
  loadCollapsedProjects,
  loadRecentWorkspaces,
  loadWorkspace,
  pushRecentWorkspace,
  rewriteStoredProjectPaths,
} from "../lib/prefs";
import * as api from "../lib/tauri";
import type { ConversationSummary } from "../lib/tauri";
import type { RemoteWorkspace } from "../lib/permission";

type Update<T> = Dispatch<SetStateAction<T>>;

/**
 * The sidebar's project list. One load fills every project, then the open
 * project's chats and server stamp stay in step with the chat on screen.
 */
export function useProjectIndex({
  workspace,
  setWorkspace,
  conversations,
  remoteWorkspace,
  remoteForRef,
  sidebarSyncRef,
  sidebarLoadedForRef,
  workspaceRef,
  cloudTranscriptsRef,
  setFlash,
}: {
  workspace: string;
  setWorkspace: Update<string>;
  conversations: ConversationSummary[];
  remoteWorkspace: RemoteWorkspace | null;
  remoteForRef: RefObject<string>;
  sidebarSyncRef: RefObject<{ workspace: string; conversations: ConversationSummary[] }>;
  sidebarLoadedForRef: RefObject<string>;
  workspaceRef: RefObject<string>;
  cloudTranscriptsRef: RefObject<Map<string, import("../lib/tauri").Conversation>>;
  setFlash: (flash: { kind: "err"; text: string }) => void;
}) {
  const [recents, setRecents] = useState(loadRecentWorkspaces);
  const [allProjectGroups, setAllProjectGroups] = useState<ProjectChatGroup[]>([]);
  // False until the first frame has every cached chat. The list stays hidden so
  // project names do not paint, then jump as each conversation list arrives.
  const [sidebarReady, setSidebarReady] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState(loadCollapsedProjects);
  const [projectsRoot, setProjectsRoot] = useState("");
  const [legacyProjectsRoot, setLegacyProjectsRoot] = useState("");
  const [pathsReady, setPathsReady] = useState(false);

  useEffect(() => {
    if (!pathsReady || !workspace) return;
    setRecents(pushRecentWorkspace(workspace));
  }, [pathsReady, workspace]);

  useEffect(() => {
    let cancelled = false;
    void api
      .projectsLocation()
      .then((loc) => {
        if (cancelled) return;
        rewriteStoredProjectPaths(loc.moves);
        setProjectsRoot(loc.root);
        setLegacyProjectsRoot(loc.legacy_root);
        const saved = loadWorkspace();
        if (saved) setRecents(pushRecentWorkspace(saved));
        setCollapsedProjects(loadCollapsedProjects());
        const next = loadWorkspace();
        setWorkspace((current) => (current === next ? current : next));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setPathsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [setWorkspace]);

  useEffect(() => {
    if (!pathsReady) return;
    let cancelled = false;
    void (async () => {
      try {
        const fromDisk = await api.listProjects();
        let remoteMounts = new Set<string>();
        try {
          const remotes = await api.listRemoteProjects();
          remoteMounts = new Set(remotes.map((row) => projectKey(row.mount_path)));
        } catch {
          remoteMounts = new Set();
        }
        const rows = sidebarProjects(fromDisk).map((row) =>
          remoteMounts.has(projectKey(row.path)) ? { ...row, remote: true } : row,
        );
        // One read of the index. Cached chats paint with their project instead of
        // staggering in after the names. A project the index does not know yet stays empty.
        let snapshot: Awaited<ReturnType<typeof api.sidebarSnapshot>> = [];
        try {
          snapshot = await api.sidebarSnapshot();
        } catch {
          snapshot = [];
        }
        if (cancelled) return;
        const firstFrame = groupsFromSidebarSnapshot(rows, snapshot);
        setAllProjectGroups((prev) => mergeLoadedProjectGroups(prev, firstFrame));
        setSidebarReady(true);
        const cached = new Set(snapshot.map((group) => projectKey(group.path)));
        const openPath = workspaceRef.current;
        // Indexed projects are already on screen. Only a project missing from the
        // snapshot still needs its own store, and the open one goes first.
        // `loaded` starts as that frame so each fill keeps the chats already painted.
        const pending = rows.filter((row) => !cached.has(projectKey(row.path)));
        const ordered = [
          ...pending.filter((row) => isSameProject(row.path, openPath)),
          ...pending.filter((row) => !isSameProject(row.path, openPath)),
        ];
        const loaded: ProjectChatGroup[] = firstFrame.map((group) => ({ ...group }));
        for (const row of ordered) {
          if (cancelled) return;
          const listed = await api
            .listConversations(row.path)
            .then((rows) => ({ rows, failed: false }))
            .catch(() => ({ rows: [] as ConversationSummary[], failed: true }));
          if (cancelled) return;
          // A cloud call that fails, or is still the empty index, must not replace chats
          // the sidebar already showed. The next pass fills them in.
          // A cloud project's chats live on the server. The local list is the mount
          // database, which only holds empty drafts created before the link was up.
          const localRows = row.remote ? listed.rows.filter((item) => !isLocalCloudDraft(item)) : listed.rows;
          const convs = listed.failed && row.remote ? null : localRows;
          let conversations = convs ?? [];
          // The local list of a cloud project is the empty mount. Paint the last
          // server copy now, then the open project replaces it when SSH returns.
          if (row.remote && conversations.length === 0 && !listed.failed) {
            try {
              const cached = await api.hostedSidebarCached(row.path);
              rememberCloudTranscripts(cloudTranscriptsRef.current, row.path, cached.transcripts);
              if (cached.conversations.length > 0) conversations = cached.conversations;
            } catch {
              /* the server copy is missing; the list stays empty until SSH */
            }
          }
          let next = {
            ...row,
            conversations,
            journeys: [],
            remote: Boolean(row.remote),
          };
          if (next.remote && isSameProject(next.path, workspaceRef.current)) {
            try {
              const remote = await api.workspaceRemote(next.path);
              if (remote) {
                next = {
                  ...next,
                  server: {
                    machineName: remote.machine_name,
                    host: remote.host,
                    user: remote.user,
                    port: remote.port,
                    remotePath: remote.remote_path,
                    online: remote.online,
                  },
                };
              }
            } catch {
              /* leave the cloud without a status */
            }
          }
          loaded.push(next);
          if (!cancelled) {
            const ready = applyLiveProjectChats(loaded, sidebarSyncRef.current, sidebarLoadedForRef.current);
            // `loaded` is open-project-first. Paint it back in the sidebar's own order.
            const byPath = new Map(ready.map((group) => [projectKey(group.path), group]));
            const inOrder = rows.flatMap((item) => {
              const group = byPath.get(projectKey(item.path));
              return group ? [group] : [];
            });
            setAllProjectGroups((prev) => mergeLoadedProjectGroups(prev, inOrder));
          }
        }
      } catch (e) {
        if (!cancelled) {
          setSidebarReady(true);
          setFlash({ kind: "err", text: String(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pathsReady, setFlash, sidebarLoadedForRef, sidebarSyncRef, workspaceRef, cloudTranscriptsRef]);

  useEffect(() => {
    if (!workspace) return;
    if (!isSameProject(sidebarLoadedForRef.current, workspace)) return;
    // An empty list here is the gap between two projects, not a finished load.
    // A cloud project keeps the cached rows until the server list arrives.
    if (conversations.length === 0) return;
    setAllProjectGroups((prev) => {
      const placed = placeProjectChats(prev, workspace, conversations, [], sidebarLoadedForRef.current);
      const stamped = stampProjectServer(placed, workspace, remoteWorkspace, remoteForRef.current);
      if (
        stamped.length === prev.length &&
        stamped.every((group, i) => {
          const before = prev[i];
          return (
            before &&
            before.path === group.path &&
            before.remote === group.remote &&
            before.server === group.server &&
            sameSidebarConversationList(before.conversations, group.conversations) &&
            before.journeys.length === group.journeys.length
          );
        })
      ) {
        return prev;
      }
      return stamped;
    });
  }, [workspace, conversations, remoteWorkspace, remoteForRef, sidebarLoadedForRef]);

  return {
    recents,
    setRecents,
    allProjectGroups,
    setAllProjectGroups,
    collapsedProjects,
    setCollapsedProjects,
    projectsRoot,
    legacyProjectsRoot,
    pathsReady,
    sidebarReady,
  };
}

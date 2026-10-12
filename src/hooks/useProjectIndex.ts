import { useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import {
  applyLiveProjectChats,
  isSameProject,
  mergeLoadedProjectGroups,
  placeProjectChats,
  sameJourneyList,
  sameSidebarConversationList,
  sidebarProjects,
  stampProjectServer,
  type ProjectChatGroup,
} from "../lib/all-projects";
import { projectKey } from "../lib/core";
import type { JourneySummary } from "../lib/journey";
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
  journeys,
  remoteWorkspace,
  remoteForRef,
  sidebarSyncRef,
  sidebarLoadedForRef,
  workspaceRef,
  setFlash,
}: {
  workspace: string;
  setWorkspace: Update<string>;
  conversations: ConversationSummary[];
  journeys: JourneySummary[];
  remoteWorkspace: RemoteWorkspace | null;
  remoteForRef: RefObject<string>;
  sidebarSyncRef: RefObject<{ workspace: string; conversations: ConversationSummary[]; journeys: JourneySummary[] }>;
  sidebarLoadedForRef: RefObject<string>;
  workspaceRef: RefObject<string>;
  setFlash: (flash: { kind: "err"; text: string }) => void;
}) {
  const [recents, setRecents] = useState(loadRecentWorkspaces);
  const [allProjectGroups, setAllProjectGroups] = useState<ProjectChatGroup[]>([]);
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
        const loaded: ProjectChatGroup[] = [];
        for (const row of rows) {
          if (cancelled) return;
          const [listed, journeyListed] = await Promise.all([
            api.listConversations(row.path).then((rows) => ({ rows, failed: false })).catch(() => ({ rows: [] as ConversationSummary[], failed: true })),
            api.listJourneys(row.path).then((rows) => ({ rows, failed: false })).catch(() => ({ rows: [] as JourneySummary[], failed: true })),
          ]);
          if (cancelled) return;
          // A cloud call that fails, or is still the empty index, must not replace chats
          // the sidebar already showed. The next pass fills them in.
          const convs = listed.failed && row.remote ? null : listed.rows;
          const nextJourneys = journeyListed.failed && row.remote ? null : journeyListed.rows;
          let next = {
            ...row,
            conversations: convs ?? [],
            journeys: nextJourneys ?? [],
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
            setAllProjectGroups((prev) => mergeLoadedProjectGroups(prev, ready));
          }
        }
      } catch (e) {
        if (!cancelled) setFlash({ kind: "err", text: String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pathsReady, setFlash, sidebarLoadedForRef, sidebarSyncRef, workspaceRef]);

  useEffect(() => {
    if (!workspace) return;
    if (!isSameProject(sidebarLoadedForRef.current, workspace)) return;
    // An empty list here is the gap between two projects, not a finished load.
    if (conversations.length === 0) return;
    setAllProjectGroups((prev) => {
      const placed = placeProjectChats(prev, workspace, conversations, journeys, sidebarLoadedForRef.current);
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
            sameJourneyList(before.journeys, group.journeys)
          );
        })
      ) {
        return prev;
      }
      return stamped;
    });
  }, [workspace, conversations, journeys, remoteWorkspace, remoteForRef, sidebarLoadedForRef]);

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
  };
}

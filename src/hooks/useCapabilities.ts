import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { cloudSendWaiting } from "../lib/hosted";
import { detectMcp, withMcpAuth, type DetectedMcpServer } from "../lib/mcp";
import { detectSkills, parseSkillOrigin, type DetectedSkill } from "../lib/skill";
import { subscribeFileRefresh } from "../lib/file-structure";
import type { RemoteWorkspace } from "../lib/permission";
import * as api from "../lib/tauri";

type Update<T> = Dispatch<SetStateAction<T>>;

/** MCP servers and skills for the open project. A cloud project reads them from the server. */
export function useCapabilities({
  workspace,
  remoteWorkspace,
  remoteKnown,
  linkReady,
  setMcpServers,
  setSkills,
}: {
  workspace: string;
  remoteWorkspace: RemoteWorkspace | null;
  remoteKnown: boolean;
  linkReady: boolean;
  setMcpServers: Update<DetectedMcpServer[]>;
  setSkills: Update<DetectedSkill[]>;
}) {
  const [mcpBusy, setMcpBusy] = useState<string | null>(null);
  const [skillBusy, setSkillBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadMcp = () => {
      if (cloudSendWaiting(remoteKnown, remoteWorkspace, linkReady)) return;
      if (remoteWorkspace && workspace) {
        void api
          .workspaceCapabilities(workspace)
          .then(async (remote) => {
            if (!remote) {
              if (!cancelled) {
                setMcpServers([]);
                setSkills([]);
              }
              return;
            }
            const home = new Map<string, string>();
            for (const entry of remote.mcp) {
              const split = entry.indexOf("\n");
              if (split <= 0) continue;
              home.set(entry.slice(0, split), entry.slice(split + 1));
            }
            const rows = await detectMcp({
              readHome: async (path) => home.get(path) ?? null,
              readWorkspace: workspace
                ? async (path) => {
                    try {
                      return await api.readFile(workspace, path);
                    } catch {
                      return null;
                    }
                  }
                : undefined,
            });
            if (cancelled) return;
            setMcpServers(withMcpAuth(rows, remote.auth));
            const grokToml = home.get(".grok/config.toml") ?? null;
            setSkills(
              detectSkills(
                remote.skills.map((file) => ({
                  source: file.path,
                  origin: parseSkillOrigin(file.origin, file.path),
                  contents: file.contents,
                })),
                grokToml,
              ),
            );
          })
          .catch(() => {
            if (!cancelled) {
              setMcpServers([]);
              setSkills([]);
            }
          });
        return;
      }
      void detectMcp({
        readHome: async (path) => {
          try {
            return await api.readUserMcp(path);
          } catch {
            return null;
          }
        },
        readWorkspace: workspace
          ? async (path) => {
              try {
                return await api.readFile(workspace, path);
              } catch {
                return null;
              }
            }
          : undefined,
      }).then(async (rows) => {
        let authed: string[] = [];
        try {
          authed = await api.mcpAuthNames();
        } catch {
          authed = [];
        }
        if (!cancelled) setMcpServers(withMcpAuth(rows, authed));
      });
    };
    loadMcp();
    const stopRefresh = subscribeFileRefresh(loadMcp);
    if (remoteWorkspace) {
      return () => {
        cancelled = true;
        stopRefresh();
      };
    }
    void (async () => {
      try {
        const files = await api.listSkillFiles(workspace || null);
        let grokToml: string | null = null;
        try {
          grokToml = await api.readUserMcp(".grok/config.toml");
        } catch {
          grokToml = null;
        }
        const inputs = [];
        for (const file of files) {
          try {
            const contents = file.home
              ? await api.readUserSkill(file.read_path)
              : workspace
                ? await api.readFile(workspace, file.read_path)
                : null;
            if (contents == null) continue;
            inputs.push({
              source: file.path,
              origin: parseSkillOrigin(file.origin, file.path),
              contents,
            });
          } catch {
            /* skip unreadable skill files */
          }
        }
        if (!cancelled) setSkills(detectSkills(inputs, grokToml));
      } catch {
        if (!cancelled) setSkills([]);
      }
    })();
    return () => {
      cancelled = true;
      stopRefresh();
    };
  }, [workspace, remoteWorkspace, remoteKnown, linkReady, setMcpServers, setSkills]);

  return { mcpBusy, setMcpBusy, skillBusy, setSkillBusy };
}

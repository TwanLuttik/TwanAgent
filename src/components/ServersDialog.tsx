import { useEffect, useState } from "react";
import { Button } from "./Button";
import * as api from "../lib/tauri";
import type { AgentServer, HostPrompt, LanHost, RemoteProject, ServerInstallStatus, ServerProject, ServerProviderKeys, ServerStorage } from "../lib/tauri";
import { detectMcp, withMcpAuth, type DetectedMcpServer } from "../lib/mcp";
import { useApp } from "../state/app-state";
import { ConnectForm, InstallStep, KeysStep, PROVIDERS, type LocalKeys, type ProviderId } from "./servers/ConnectSteps";
import { ServerDetail, ServerRow, type CopyProgress, type InstallView } from "./servers/ServerDetail";

type Step = "list" | "detail" | "connect" | "trust" | "install" | "keys";

const NO_LOCAL_KEYS: LocalKeys = { xai: null, anthropic: null, minimax: null };

function providerLabel(id: ProviderId): string {
  return PROVIDERS.find((provider) => provider.id === id)?.label ?? id;
}

/** "Grok", "Grok and Claude", or "Grok, Claude, and MiniMax". */
function joinLabels(ids: ProviderId[]): string {
  const labels = ids.map(providerLabel);
  if (labels.length <= 1) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

function keySyncNotice(copied: ProviderId[], keys: ServerProviderKeys): string {
  const replaced = copied.filter((id) => keys.replaced?.[id]);
  const fresh = copied.filter((id) => !keys.replaced?.[id]);
  const parts: string[] = [];
  if (fresh.length === 1) parts.push(`Synced the ${providerLabel(fresh[0])} key to the server.`);
  else if (fresh.length > 1) parts.push(`Synced the ${joinLabels(fresh)} keys to the server.`);
  if (replaced.length === 1) parts.push(`Replaced the ${providerLabel(replaced[0])} key already on the server.`);
  else if (replaced.length > 1) parts.push(`Replaced the ${joinLabels(replaced)} keys already on the server.`);
  return parts.join(" ");
}

/** TwanAgent servers. A row appears only after the server program is installed and a token is saved. */
export function ServersDialog({
  onClose,
  onOpenProject,
}: {
  onClose: () => void;
  /** Local mount path returned after the remote folder is registered. */
  onOpenProject: (path: string, name: string) => void;
}) {
  const { setFlash } = useApp();
  const [step, setStep] = useState<Step>("list");
  const [saved, setSaved] = useState<AgentServer[]>([]);
  const [projects, setProjects] = useState<RemoteProject[]>([]);
  const [liveProjects, setLiveProjects] = useState<Record<string, ServerProject[]>>({});
  const [projectsLoading, setProjectsLoading] = useState<Record<string, boolean>>({});
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [storageById, setStorageById] = useState<Record<string, ServerStorage>>({});
  const [gitById, setGitById] = useState<Record<string, boolean | "checking">>({});
  const [keysById, setKeysById] = useState<Record<string, ServerProviderKeys>>({});
  const [copyProviders, setCopyProviders] = useState<ProviderId[]>([]);
  const [localKeys, setLocalKeys] = useState<LocalKeys>(NO_LOCAL_KEYS);
  const [serverName, setServerName] = useState("");
  const [user, setUser] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<HostPrompt | null>(null);
  const [pendingMachine, setPendingMachine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<LanHost[]>([]);
  const [scanning, setScanning] = useState(false);
  const [installs, setInstalls] = useState<Record<string, InstallView>>({});
  const [copyById, setCopyById] = useState<Record<string, CopyProgress>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listReady, setListReady] = useState(false);
  const [probe, setProbe] = useState<ServerInstallStatus | "checking" | null>(null);
  const [syncMcp, setSyncMcp] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [localMcp, setLocalMcp] = useState<DetectedMcpServer[]>([]);

  function reload() {
    // The saved list is local. Show it before any host is asked whether it is up.
    void api
      .listAgentServers()
      .then((rows) => {
        setListReady(true);
        setSaved(rows);
        setSelectedId((current) => (current && rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null));
        // Each host answers on its own. Waiting in a line held the whole screen.
        for (const row of rows) {
          void checkInstall(row.id).then((status) => {
            if (status?.online) loadProjects(row.id);
          });
        }
      })
      .catch((err) => {
        setListReady(true);
        setError(String(err));
      });
    void api.listRemoteProjects().then(setProjects).catch(() => setProjects([]));
  }

  function loadProjects(id: string) {
    setProjectsLoading((prev) => ({ ...prev, [id]: true }));
    void api
      .serverProjects(id)
      .then((rows) => setLiveProjects((prev) => ({ ...prev, [id]: rows })))
      .catch(() => setLiveProjects((prev) => ({ ...prev, [id]: prev[id] ?? [] })))
      .finally(() => setProjectsLoading((prev) => ({ ...prev, [id]: false })));
  }

  function loadStorage(id: string) {
    loadProjects(id);
    setGitById((prev) => ({ ...prev, [id]: "checking" }));
    void api
      .serverGit(id)
      .then((row) => setGitById((prev) => ({ ...prev, [id]: row.installed })))
      .catch(() => setGitById((prev) => ({ ...prev, [id]: false })));
    void api
      .serverStorage(id)
      .then((row) => setStorageById((prev) => ({ ...prev, [id]: row })))
      .catch(() => undefined);
    void api
      .serverProviderKeys(id)
      .then((row) => {
        setKeysById((prev) => ({ ...prev, [id]: row }));
        setCopyProviders(PROVIDERS.filter((provider) => row[provider.id]).map((provider) => provider.id));
      })
      .catch(() => undefined);
  }

  function toggleProvider(id: ProviderId) {
    setCopyProviders((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  async function checkInstall(id: string): Promise<api.ServerInstallStatus | null> {
    setInstalls((prev) => ({ ...prev, [id]: "checking" }));
    setError(null);
    try {
      const status = await api.agentServerStatus(id);
      setInstalls((prev) => ({ ...prev, [id]: status }));
      return status;
    } catch (err) {
      setInstalls((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setError(String(err));
      return null;
    }
  }

  async function installBinary(row: AgentServer) {
    setInstalls((prev) => ({ ...prev, [row.id]: "copying" }));
    setCopyById((prev) => ({ ...prev, [row.id]: { phase: "reading", sent: 0, total: 0 } }));
    setError(null);
    try {
      const status = await api.installAgentBinary(row.id);
      setInstalls((prev) => ({ ...prev, [row.id]: status }));
    } catch (err) {
      setError(String(err));
      void checkInstall(row.id);
    }
  }

  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      if (step === "list") onClose();
      else setStep("list");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, step]);

  useEffect(() => {
    let stop: (() => void) | undefined;
    void api.onInstallProgress((event) => {
      setCopyById((prev) => ({ ...prev, [event.id]: { phase: event.phase, sent: event.sent, total: event.total } }));
    }).then((unlisten) => {
      stop = unlisten;
    });
    return () => stop?.();
  }, []);

  useEffect(() => {
    reload();
    void Promise.all([api.keyStatus(), api.anthropicKeyStatus(), api.minimaxKeyStatus()])
      .then(([xai, anthropic, minimax]) => setLocalKeys({ xai, anthropic, minimax }))
      .catch(() => undefined);
    void api
      .sshDefaults()
      .then((defaults) => {
        setUser(defaults.user);
        setKeyPath(defaults.key_path ?? null);
      })
      .catch(() => undefined);
    void detectMcp({
      readHome: async (path) => {
        try {
          return await api.readUserMcp(path);
        } catch {
          return null;
        }
      },
    })
      .then(async (rows) => {
        let authed: string[] = [];
        try {
          authed = await api.mcpAuthNames();
        } catch {
          authed = [];
        }
        setLocalMcp(withMcpAuth(rows, authed));
      })
      .catch(() => setLocalMcp([]));
  }, []);

  useEffect(() => {
    if (step !== "connect") return;
    let gone = false;
    setScanning(true);
    let unlisten: (() => void) | undefined;
    void api.onSshFound((row) => {
      if (gone) return;
      setFound((rows) => (rows.some((item) => item.host === row.host) ? rows : [...rows, row]));
    }).then((stop) => {
      if (gone) stop();
      else unlisten = stop;
    });
    void api
      .discoverSsh()
      .then((rows) => {
        if (gone) return;
        setFound((current) => {
          const seen = new Set(current.map((row) => row.host));
          return [...current, ...rows.filter((row) => !seen.has(row.host))];
        });
      })
      .catch(() => undefined)
      .finally(() => {
        if (!gone) setScanning(false);
      });
    return () => {
      gone = true;
      unlisten?.();
    };
  }, [step]);

  function chooseFound(row: LanHost) {
    setHost(row.host);
    setPort(String(row.port || 22));
    setError(null);
  }

  function loginFields() {
    const address = host.trim();
    const login = user.trim();
    const parsedPort = Number(port);
    return { address, login, parsedPort };
  }

  async function connect() {
    const { address, login, parsedPort } = loginFields();
    if (!address || !login || !Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) return;
    setBusy(true);
    setError(null);
    setProbe("checking");
    try {
      const machine = await api.saveMachine({
        name: address,
        user: login,
        host: address,
        port: parsedPort,
        auth: password.trim() ? "password" : keyPath ? "private_key" : "agent",
        keyPath: password.trim() ? undefined : keyPath || undefined,
        secret: password.trim() || undefined,
      });
      setPendingMachine(machine.id);
      const tested = await api.testMachine(machine.id);
      if (tested.host_prompt) {
        setPrompt(tested.host_prompt);
        setStep("trust");
        return;
      }
      if (!tested.ok) {
        setError(tested.message);
        setProbe(null);
        return;
      }
      await lookForProgram();
    } catch (err) {
      setError(String(err));
      setProbe(null);
    } finally {
      setBusy(false);
    }
  }

  async function lookForProgram() {
    const { address, parsedPort } = loginFields();
    setProbe("checking");
    setStep("install");
    try {
      const status = await api.probeAgentServer(address, parsedPort);
      setProbe(status);
    } catch (err) {
      setProbe(null);
      setError(String(err));
    }
  }

  async function installProgram() {
    const { address, login, parsedPort } = loginFields();
    setBusy(true);
    setError(null);
    try {
      const server = await rememberServer(address, login, parsedPort);
      const status = await api.installAgentBinary(server.id);
      setProbe(status);
      setInstalls((prev) => ({ ...prev, [server.id]: status }));
      if (status.installed) setStep("keys");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function rememberServer(address = host.trim(), login = user.trim(), parsedPort = Number(port)) {
    const server = await api.installAgentServer({
      name: serverName.trim(),
      user: login,
      host: address,
      port: parsedPort,
      auth: password.trim() ? "password" : keyPath ? "private_key" : "agent",
      keyPath: password.trim() ? undefined : keyPath || undefined,
      secret: password.trim() || undefined,
    });
    setSaved((rows) => [server, ...rows.filter((row) => row.id !== server.id)]);
    setSelectedId(server.id);
    return server;
  }

  async function finishKeys(copy: boolean) {
    const { address, login, parsedPort } = loginFields();
    setBusy(true);
    setError(null);
    try {
      const server = selectedId
        ? saved.find((row) => row.id === selectedId) ?? (await rememberServer(address, login, parsedPort))
        : await rememberServer(address, login, parsedPort);
      if (copy && copyProviders.length) {
        const keys = await api.copyServerProviderKeys(server.id, copyProviders);
        setKeysById((prev) => ({ ...prev, [server.id]: keys }));
        setFlash({ kind: "ok", text: keySyncNotice(copyProviders, keys) });
      }
      if (syncMcp) await api.syncServerCapabilities(server.id, mcpName || undefined);
      setHost("");
      setPassword("");
      setStep("detail");
      void checkInstall(server.id);
      loadStorage(server.id);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function trust() {
    if (!prompt || !pendingMachine) return;
    setBusy(true);
    setError(null);
    try {
      await api.acceptHost(prompt.machine_id, prompt.fingerprint, prompt.key_type);
      setPrompt(null);
      await lookForProgram();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function pairServer(row: AgentServer) {
    setBusy(true);
    setError(null);
    try {
      await api.pairAgentServer(row.id);
      setSaved((rows) => rows.map((item) => (item.id === row.id ? { ...item, paired: true } : item)));
      if (copyProviders.length) {
        const keys = await api.copyServerProviderKeys(row.id, copyProviders);
        setKeysById((prev) => ({ ...prev, [row.id]: keys }));
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function forget(row: AgentServer, mode: "keep" | "wipe" | "rotate") {
    setBusy(true);
    setError(null);
    try {
      await api.removeAgentServer(row.id, mode);
      setSaved((rows) => rows.filter((item) => item.id !== row.id));
      setSelectedId(null);
      setStep("list");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  const selected = saved.find((row) => row.id === selectedId) ?? null;
  const title =
    step === "trust"
      ? "Trust this server"
      : step === "connect"
        ? "Connect"
        : step === "install"
          ? "Server program"
          : step === "keys"
            ? "Provider keys"
            : "Servers";
  const intro =
    step === "trust"
      ? "First time connecting. Check the fingerprint."
      : step === "connect"
        ? "Pick a machine on this network, or type its address."
        : step === "install"
          ? "Connected. This checks whether the TwanAgent program is already on that machine."
          : step === "keys"
            ? "Copy a key so that provider can run on this server. Skip any you do not want there."
            : "A server runs the TwanAgent program. Open one to see its version and the projects that live there.";

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-canvas">
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="grid max-w-[640px] gap-4">
          {step === "detail" && selected ? null : (
            <div>
              <h2 id="servers-title" className="m-0 text-[15px] font-semibold">
                {title}
              </h2>
              <p className="mt-1 mb-0 text-[12px] leading-relaxed text-muted">{intro}</p>
            </div>
          )}
          {step === "list" ? (
            <div className="grid gap-2">
              {!listReady ? null : saved.length === 0 ? (
                <p className="m-0 rounded-xl border border-dashed border-line px-3 py-8 text-center text-[13px] text-muted">
                  No TwanAgent servers yet.
                </p>
              ) : (
                saved.map((row) => (
                  <ServerRow
                    key={row.id}
                    row={row}
                    status={installs[row.id]}
                    projects={(liveProjects[row.id] ?? projects.filter((project) => project.machine_id === row.machine_id)).length}
                    onOpen={() => {
                      setSelectedId(row.id);
                      setError(null);
                      loadStorage(row.id);
                      setStep("detail");
                    }}
                  />
                ))
              )}
              <div className="flex justify-end pt-1">
                <Button variant="primary" onClick={() => setStep("connect")}>
                  Add server
                </Button>
              </div>
            </div>
          ) : null}
          {step === "detail" && selected ? (
            <ServerDetail
              row={selected}
              status={installs[selected.id]}
              projects={liveProjects[selected.id] ?? []}
              projectsLoading={projectsLoading[selected.id] ?? false}
              copy={copyById[selected.id] ?? null}
              openingPath={openingPath}
              onOpenProject={(project) => {
                const machineId = selected.machine_id?.trim() ?? "";
                if (openingPath) return;
                if (!machineId) {
                  setError("This server is not linked to a machine yet.");
                  return;
                }
                setOpeningPath(project.remote_path);
                setError(null);
                void api
                  .createRemoteProject(project.name, machineId, project.remote_path)
                  .then((path) => {
                    if (!path) throw new Error("The server did not return a project to open.");
                    onOpenProject(path, project.name);
                    onClose();
                  })
                  .catch((err) => {
                    setError(String(err));
                    setOpeningPath(null);
                  });
              }}
              storage={storageById[selected.id] ?? null}
              git={gitById[selected.id] ?? "checking"}
              onInstallGit={() => {
                setBusy(true);
                setError(null);
                void api
                  .installServerGit(selected.id)
                  .then((row) => setGitById((prev) => ({ ...prev, [selected.id]: row.installed })))
                  .catch((err) => setError(String(err)))
                  .finally(() => setBusy(false));
              }}
              keys={keysById[selected.id] ?? null}
              copyProviders={copyProviders}
              localKeys={localKeys}
              busy={busy}
              onBack={() => setStep("list")}
              onInstall={() => void installBinary(selected)}
              onPair={() => void pairServer(selected)}
              onRemove={() => void forget(selected, "keep")}
              onWipe={() => void forget(selected, "wipe")}
              onRotate={() => void forget(selected, "rotate")}
              onRecheck={() => {
                void checkInstall(selected.id).then((status) => {
                  if (status?.online) loadStorage(selected.id);
                });
              }}
              onToggleProvider={toggleProvider}
              mcpName={mcpName}
              localMcp={localMcp}
              onMcpName={setMcpName}
              mountPaths={projects
                .filter((project) => selected.machine_id && project.machine_id === selected.machine_id)
                .map((project) => project.mount_path)}
              onRename={async (name) => {
                try {
                  const row = await api.renameAgentServer(selected.id, name);
                  setSaved((rows) => rows.map((item) => (item.id === row.id ? row : item)));
                  setError(null);
                } catch (err) {
                  setError(String(err));
                  throw err;
                }
              }}
              onSyncCapabilities={() => {
                setBusy(true);
                setError(null);
                void api
                  .syncServerCapabilities(selected.id, mcpName || undefined)
                  .then(() => setError(null))
                  .catch((err) => setError(String(err)))
                  .finally(() => setBusy(false));
              }}
              onCopyKeys={(id) => {
                setBusy(true);
                setError(null);
                void api
                  .copyServerProviderKeys(selected.id, [id])
                  .then((keys) => {
                    setCopyProviders(PROVIDERS.filter((provider) => keys[provider.id]).map((provider) => provider.id));
                    setKeysById((prev) => ({ ...prev, [selected.id]: keys }));
                    setFlash({ kind: "ok", text: keySyncNotice([id], keys) });
                  })
                  .catch((err) => setError(String(err)))
                  .finally(() => setBusy(false));
              }}
            />
          ) : null}
          {step === "connect" && (
            <ConnectForm
              found={found}
              scanning={scanning}
              name={serverName}
              host={host}
              user={user}
              port={port}
              password={password}
              keyPath={keyPath}
              busy={busy}
              onName={setServerName}
              onHost={setHost}
              onUser={setUser}
              onPort={setPort}
              onPassword={setPassword}
              onChoose={chooseFound}
              onBack={() => setStep("list")}
              onSubmit={() => void connect()}
            />
          )}
          {step === "install" && (
            <InstallStep
              host={host.trim()}
              user={user.trim()}
              probe={probe}
              busy={busy}
              onBack={() => setStep("connect")}
              onInstall={() => void installProgram()}
              onContinue={() => setStep("keys")}
            />
          )}
          {step === "keys" && (
            <KeysStep
              copyProviders={copyProviders}
              localKeys={localKeys}
              busy={busy}
              onToggle={toggleProvider}
              syncMcp={syncMcp}
              onSyncMcp={setSyncMcp}
              mcpName={mcpName}
              mcpServers={localMcp}
              onMcp={setMcpName}
              onBack={() => setStep("install")}
              onSkip={() => void finishKeys(false)}
              onCopy={() => void finishKeys(true)}
            />
          )}
          {step === "trust" && prompt && (
            <div className="grid gap-3">
              <div className="rounded-xl bg-inset px-3 py-3">
                <div className="text-[12px] text-muted">{prompt.changed ? "This key changed" : "Server fingerprint"}</div>
                <div className="mt-1 break-all font-mono text-[12px]">{prompt.fingerprint}</div>
              </div>
              <div className="flex justify-end gap-2">
                <Button onClick={() => setStep("connect")} disabled={busy}>
                  Back
                </Button>
                <Button variant="primary" disabled={busy} onClick={() => void trust()}>
                  {busy ? "Connecting…" : "Trust and connect"}
                </Button>
              </div>
            </div>
          )}
          {error && <p className="m-0 text-[12px] text-err">{error}</p>}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { Button } from "./Button";
import { Symbol } from "./Symbol";
import * as api from "../lib/tauri";
import type { AgentServer, HostPrompt, KeyStatus, LanHost, RemoteProject, ServerInstallStatus, ServerProviderKeys, ServerStorage } from "../lib/tauri";
import { detectMcp, withMcpAuth, type DetectedMcpServer } from "../lib/mcp";
import { formatBytes } from "../lib/usage";

type Step = "list" | "detail" | "connect" | "trust" | "install" | "keys";
type ProviderId = "xai" | "anthropic" | "minimax";

const PROVIDERS: { id: ProviderId; label: string; logo: string; mark: string }[] = [
  { id: "xai", label: "Grok", logo: "logo.grok", mark: "bg-[#1a1a1a] text-white" },
  { id: "anthropic", label: "Claude", logo: "logo.claude", mark: "bg-[#d97757] text-[#faf9f5]" },
  { id: "minimax", label: "MiniMax", logo: "logo.minimax", mark: "bg-wash text-ink" },
];

type LocalKeys = Record<ProviderId, KeyStatus | null>;

const NO_LOCAL_KEYS: LocalKeys = { xai: null, anthropic: null, minimax: null };

type InstallView = ServerInstallStatus | "checking" | "copying";

function versionLabel(status: ServerInstallStatus): string {
  const version = status.version.replace(/^twanagent-server\s+/, "").trim();
  if (!version || version === "unknown") return "Installed";
  return version;
}

function reachOf(status: InstallView | undefined): { label: string; online: boolean | null } {
  if (!status || status === "checking" || status === "copying") return { label: "Checking", online: null };
  return status.online ? { label: "Up", online: true } : { label: "Down", online: false };
}

function StatusDot({ online, title }: { online: boolean | null; title: string }) {
  return (
    <span
      className={`size-2 shrink-0 rounded-full ${online == null ? "bg-muted" : online ? "bg-ok" : "bg-err"}`}
      title={title}
    />
  );
}

function ServerRow({
  row,
  status,
  projects,
  onOpen,
}: {
  row: AgentServer;
  status: InstallView | undefined;
  projects: number;
  onOpen: () => void;
}) {
  const { label, online } = reachOf(status);
  const known = status && typeof status !== "string" ? status : null;
  const address = `${row.user}@${row.host}${row.port === 22 ? "" : `:${row.port}`}`;
  const program = !known
    ? "Checking the server program"
    : !known.online
      ? "SSH did not answer"
      : known.installed
        ? known.update
          ? `${versionLabel(known)} · update`
          : versionLabel(known)
        : "Not installed";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-ink/20 bg-panel px-3 py-3 text-left hover:border-ink/40"
    >
      <span className="flex size-9 items-center justify-center rounded-full bg-inset text-accent">
        <Symbol name="server.rack" className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-ink">{row.name}</span>
          <StatusDot online={online} title={label} />
          <span className={`text-[11px] ${online ? "text-ok" : online == null ? "text-muted" : "text-err"}`}>{label}</span>
        </span>
        <span className="mt-0.5 block truncate text-[12px] text-muted">{address}</span>
      </span>
      <span className="flex items-center gap-3 text-[12px] text-muted">
        <span className="hidden sm:block">{program}</span>
        <span>{projects === 1 ? "1 project" : `${projects} projects`}</span>
        <Symbol name="chevron.right" className="size-3.5" />
      </span>
    </button>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">{label}</span>
      <span className={`truncate text-[13px] text-ink ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

function ServerDetail({
  row,
  status,
  projects,
  storage,
  git,
  keys,
  copyProviders,
  localKeys,
  busy,
  onBack,
  onInstall,
  onPair,
  onRemove,
  onRecheck,
  onToggleProvider,
  onCopyKeys,
  onInstallGit,
  onSyncCapabilities,
  mcpName,
  localMcp,
  onMcpName,
}: {
  row: AgentServer;
  status: InstallView | undefined;
  projects: RemoteProject[];
  storage: ServerStorage | null;
  git: boolean | "checking";
  keys: ServerProviderKeys | null;
  copyProviders: ProviderId[];
  localKeys: LocalKeys;
  busy: boolean;
  onBack: () => void;
  onInstall: () => void;
  onPair: () => void;
  onRemove: () => void;
  onRecheck: () => void;
  onToggleProvider: (id: ProviderId) => void;
  onCopyKeys: (id: ProviderId) => void;
  onInstallGit: () => void;
  onSyncCapabilities: () => void;
  mcpName: string;
  localMcp: DetectedMcpServer[];
  onMcpName: (name: string) => void;
}) {
  const { label, online } = reachOf(status);
  const copying = status === "copying";
  const known = status && typeof status !== "string" ? status : null;
  const installed = Boolean(known?.installed);
  const needsToken = Boolean(known && online && installed && !row.paired);
  const address = `${row.user}@${row.host}${row.port === 22 ? "" : `:${row.port}`}`;
  const version = !known ? "Checking…" : !known.online ? "Unreachable" : installed ? versionLabel(known as ServerInstallStatus) : "Not installed";
  const update = Boolean(known?.online && installed && known.update);
  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={onBack} className="flex items-center gap-1 text-[12px] text-muted hover:text-ink">
          <Symbol name="chevron.left" className="size-3.5" />
          Servers
        </button>
        <button type="button" className="text-[12px] text-muted hover:text-err" disabled={busy} onClick={onRemove}>
          Remove
        </button>
      </div>
      <div className="flex items-start gap-3">
        <span className="flex size-10 items-center justify-center rounded-full bg-inset text-accent">
          <Symbol name="server.rack" className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 className="m-0 truncate text-[15px] font-semibold text-ink">{row.name}</h2>
          <p className="mt-0.5 mb-0 flex items-center gap-1.5 text-[12px] text-muted">
            <StatusDot online={online} title={label} />
            {label} · {address}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 rounded-xl bg-inset/70 px-3 py-3">
        <Fact label="Version" value={update ? `${version} · update ready` : version} />
        <Fact label="Pairing" value={row.paired ? "Paired" : needsToken ? "Needs a token" : "Not paired"} />
        <Fact label="Program" value={known?.path || "~/.twanagent/bin/twanagent-server"} mono />
        <Fact label="Added" value={row.installed_at ? row.installed_at.slice(0, 10) : "—"} />
        <Fact
          label="SQLite"
          value={
            storage
              ? `${formatBytes(storage.bytes)} · ${formatBytes(storage.conversation_bytes)} in conversations`
              : "Checking…"
          }
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button disabled={busy || copying} onClick={onRecheck}>
          {copying ? "Installing…" : status === "checking" ? "Checking…" : "Check again"}
        </Button>
        {known && online && !installed ? (
          <Button variant="primary" disabled={busy || copying} onClick={onInstall}>
            Install
          </Button>
        ) : null}
        {update ? (
          <Button variant="primary" disabled={busy || copying} onClick={onInstall}>
            {copying ? "Updating…" : "Update"}
          </Button>
        ) : null}
        {needsToken ? (
          <Button variant="primary" disabled={busy} onClick={onPair}>
            Pair
          </Button>
        ) : null}
      </div>
      <GitSection git={git} online={Boolean(known?.online)} busy={busy} onInstall={onInstallGit} />
      <ProviderKeys
        keys={keys}
        localKeys={localKeys}
        selected={copyProviders}
        onToggle={onToggleProvider}
        onSync={known?.online ? onCopyKeys : undefined}
        busy={busy}
      />
      {known?.online ? (
        <div className="grid gap-2">
          <CapabilitySync
            checked
            disabled={busy}
            mcpName={mcpName}
            mcpServers={localMcp}
            onChange={() => undefined}
            onMcp={onMcpName}
          />
          <div className="flex justify-end">
            <Button disabled={busy} onClick={onSyncCapabilities}>
              {busy ? "Syncing…" : "Sync MCP and skills"}
            </Button>
          </div>
        </div>
      ) : null}
      <div className="grid gap-1.5">
        <div className="text-[11px] font-semibold tracking-wide text-muted uppercase">Projects</div>
        {projects.length === 0 ? (
          <p className="m-0 rounded-xl border border-dashed border-ink/10 px-3 py-4 text-[12px] text-muted">
            No projects on this server yet. Create one from the folder picker.
          </p>
        ) : (
          projects.map((project) => (
            <div key={project.id} className="flex items-center gap-2 rounded-xl border border-ink/10 bg-panel px-3 py-2.5">
              <Symbol name="folder.fill" className="size-3.5 shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-ink">{project.name}</span>
                <span className="block truncate font-mono text-[11px] text-muted">{project.remote_path}</span>
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** TwanAgent servers. A row appears only after the server program is installed and a token is saved. */
export function ServersDialog({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>("list");
  const [saved, setSaved] = useState<AgentServer[]>([]);
  const [projects, setProjects] = useState<RemoteProject[]>([]);
  const [storageById, setStorageById] = useState<Record<string, ServerStorage>>({});
  const [gitById, setGitById] = useState<Record<string, boolean | "checking">>({});
  const [keysById, setKeysById] = useState<Record<string, ServerProviderKeys>>({});
  const [copyProviders, setCopyProviders] = useState<ProviderId[]>([]);
  const [localKeys, setLocalKeys] = useState<LocalKeys>(NO_LOCAL_KEYS);
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [probe, setProbe] = useState<ServerInstallStatus | "checking" | null>(null);
  const [syncMcp, setSyncMcp] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [localMcp, setLocalMcp] = useState<DetectedMcpServer[]>([]);

  function reload() {
    setLoading(true);
    void api
      .listAgentServers()
      .then((rows) => {
        setSaved(rows);
        setSelectedId((current) => (current && rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null));
        for (const row of rows) void checkInstall(row.id);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
    void api.listRemoteProjects().then(setProjects).catch(() => setProjects([]));
  }

  function loadStorage(id: string) {
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

  async function checkInstall(id: string) {
    setInstalls((prev) => ({ ...prev, [id]: "checking" }));
    try {
      const status = await api.agentServerStatus(id);
      setInstalls((prev) => ({ ...prev, [id]: status }));
    } catch (err) {
      setInstalls((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setError(String(err));
    }
  }

  async function installBinary(row: AgentServer) {
    setInstalls((prev) => ({ ...prev, [row.id]: "copying" }));
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
      name: address,
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

  async function forget(row: AgentServer) {
    setBusy(true);
    setError(null);
    try {
      await api.removeAgentServer(row.id);
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
          {step === "list" && loading ? (
            <div className="flex items-center justify-center py-16" role="status" aria-label="Loading servers">
              <span className="size-5 animate-spin rounded-full border-2 border-ink/25 border-t-ink" />
            </div>
          ) : null}
          {step === "list" && !loading ? (
            <div className="grid gap-2">
              {saved.length === 0 ? (
                <p className="m-0 rounded-xl border border-dashed border-line px-3 py-8 text-center text-[13px] text-muted">
                  No TwanAgent servers yet.
                </p>
              ) : (
                saved.map((row) => (
                  <ServerRow
                    key={row.id}
                    row={row}
                    status={installs[row.id]}
                    projects={projects.filter((project) => project.machine_id === row.machine_id).length}
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
              projects={projects.filter((project) => project.machine_id === selected.machine_id)}
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
              onRemove={() => void forget(selected)}
              onRecheck={() => void checkInstall(selected.id)}
              onToggleProvider={toggleProvider}
              mcpName={mcpName}
              localMcp={localMcp}
              onMcpName={setMcpName}
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
                const next = copyProviders.includes(id) ? copyProviders : [...copyProviders, id];
                void api
                  .copyServerProviderKeys(selected.id, next)
                  .then((keys) => {
                    setCopyProviders(PROVIDERS.filter((provider) => keys[provider.id]).map((provider) => provider.id));
                    setKeysById((prev) => ({ ...prev, [selected.id]: keys }));
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
              host={host}
              user={user}
              port={port}
              password={password}
              keyPath={keyPath}
              busy={busy}
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

/** Named machines first, then bare addresses. A named VM is the one you meant to pick. */
function networkOrder(rows: LanHost[]): LanHost[] {
  return [...rows].sort((a, b) => {
    const namedA = a.label !== a.host ? 0 : 1;
    const namedB = b.label !== b.host ? 0 : 1;
    if (namedA !== namedB) return namedA - namedB;
    return a.label.localeCompare(b.label);
  });
}

function machineKind(row: LanHost): { symbol: string; place: string } {
  if (row.host.endsWith("@orb") || row.label.includes("OrbStack")) return { symbol: "desktopcomputer", place: "OrbStack" };
  if (row.label.includes("Tailscale") || row.host.startsWith("100.")) return { symbol: "globe", place: "Tailscale" };
  if (row.label === "Gateway") return { symbol: "wifi", place: "Gateway" };
  return { symbol: "server.rack", place: "Local" };
}

function ConnectForm({
  found,
  scanning,
  host,
  user,
  port,
  password,
  keyPath,
  busy,
  onHost,
  onUser,
  onPort,
  onPassword,
  onChoose,
  onBack,
  onSubmit,
}: {
  found: LanHost[];
  scanning: boolean;
  host: string;
  user: string;
  port: string;
  password: string;
  keyPath: string | null;
  busy: boolean;
  onHost: (value: string) => void;
  onUser: (value: string) => void;
  onPort: (value: string) => void;
  onPassword: (value: string) => void;
  onChoose: (row: LanHost) => void;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const machines = networkOrder(found);
  return (
    <form
      className="grid gap-3"
      onSubmit={(ev) => {
        ev.preventDefault();
        onSubmit();
      }}
    >
      <div className="grid gap-1.5">
        <span className="text-[12px] text-muted">
          {scanning ? "Looking for SSH, OrbStack, and Tailscale…" : "On this network"}
        </span>
        {machines.length === 0 ? (
          <p className="m-0 text-[12px] text-muted">
            {scanning ? "Checking machines that answer on SSH." : "Nothing answered on port 22. Type an address below."}
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {machines.map((row) => {
              const selected = host === row.host;
              const kind = machineKind(row);
              const titled = row.label !== row.host;
              return (
                <button
                  key={row.host}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onChoose(row)}
                  className={`grid min-h-[76px] content-start gap-1 rounded-xl border px-3 py-2.5 text-left ${
                    selected ? "border-accent bg-wash" : "border-line bg-panel hover:border-ink/30 hover:bg-wash"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <Symbol name={kind.symbol} className={`size-3.5 shrink-0 ${selected ? "text-accent" : "text-muted"}`} />
                    <span className="truncate text-[11px] text-muted">{kind.place}</span>
                  </span>
                  <span className="truncate text-[13px] font-medium text-ink">{titled ? row.label.replace(/ · OrbStack$/, "") : row.host}</span>
                  {titled ? <span className="truncate font-mono text-[11px] text-muted">{row.host}</span> : null}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <Field label="Address">
        <input
          autoFocus
          value={host}
          onChange={(ev) => onHost(ev.target.value)}
          placeholder="10.0.0.50"
          className="h-9 rounded-lg border border-line bg-canvas px-3 text-[13px] outline-none focus:border-accent"
        />
      </Field>
      <div className="grid grid-cols-[1fr_88px] gap-2">
        <Field label="User">
          <input
            value={user}
            onChange={(ev) => onUser(ev.target.value)}
            className="h-9 rounded-lg border border-line bg-canvas px-3 text-[13px] outline-none focus:border-accent"
          />
        </Field>
        <Field label="Port">
          <input
            value={port}
            onChange={(ev) => onPort(ev.target.value.replace(/[^\d]/g, "").slice(0, 5))}
            className="h-9 rounded-lg border border-line bg-canvas px-3 text-[13px] outline-none focus:border-accent"
          />
        </Field>
      </div>
      <Field label={keyPath ? "Password, if the key needs one" : "Password"}>
        <input
          type="password"
          value={password}
          onChange={(ev) => onPassword(ev.target.value)}
          placeholder={keyPath ? "Leave empty to use your key" : "Used once to install"}
          className="h-9 rounded-lg border border-line bg-canvas px-3 text-[13px] outline-none focus:border-accent"
        />
      </Field>
      <p className="m-0 text-[12px] text-muted">
        Connects over SSH. The password is not saved as the server token.
      </p>
      <div className="flex justify-between gap-2">
        <Button type="button" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !host.trim() || !user.trim()}>
          {busy ? "Connecting…" : "Connect"}
        </Button>
      </div>
    </form>
  );
}

function InstallStep({
  host,
  user,
  probe,
  busy,
  onBack,
  onInstall,
  onContinue,
}: {
  host: string;
  user: string;
  probe: ServerInstallStatus | "checking" | null;
  busy: boolean;
  onBack: () => void;
  onInstall: () => void;
  onContinue: () => void;
}) {
  const known = probe && probe !== "checking" ? probe : null;
  const checking = !known;
  const installed = Boolean(known?.installed);
  const paired = Boolean(known?.paired);
  const offline = Boolean(known && !known.online);
  const version = known && installed ? versionLabel(known) : "";
  const versionText = version && version !== "Installed" ? ` ${version}` : "";
  const program = installed
    ? `TwanAgent${versionText} is installed on this machine.`
    : "TwanAgent is not installed on this machine.";
  const pairing = !installed && paired
    ? "A pairing token is already on this machine, but the program is missing."
    : paired
      ? "It is already paired. Connecting keeps the token that is on the machine."
      : installed
        ? "It is not paired yet."
        : "";
  return (
    <div className="grid gap-3">
      <div className="rounded-xl border border-line px-3 py-3">
        <div className="text-[13px] font-medium text-ink">{host}</div>
        <div className="mt-0.5 text-[12px] text-muted">{user}@{host}</div>
        <div className="mt-2 text-[12px] text-ink">
          {checking ? "Checking for the TwanAgent program…" : offline ? "This machine stopped answering." : program}
        </div>
        {!checking && !offline && pairing ? <div className="mt-1 text-[12px] text-muted">{pairing}</div> : null}
      </div>
      <div className="flex justify-between gap-2">
        <Button onClick={onBack} disabled={busy}>
          Back
        </Button>
        {installed ? (
          <Button variant="primary" disabled={busy || checking} onClick={onContinue}>
            Continue
          </Button>
        ) : (
          <Button variant="primary" disabled={busy || checking || offline} onClick={onInstall}>
            {busy ? "Installing…" : "Install TwanAgent"}
          </Button>
        )}
      </div>
    </div>
  );
}

function KeysStep({
  copyProviders,
  localKeys,
  busy,
  syncMcp,
  mcpName,
  mcpServers,
  onToggle,
  onSyncMcp,
  onMcp,
  onBack,
  onSkip,
  onCopy,
}: {
  copyProviders: ProviderId[];
  localKeys: LocalKeys;
  busy: boolean;
  syncMcp: boolean;
  mcpName: string;
  mcpServers: DetectedMcpServer[];
  onToggle: (id: ProviderId) => void;
  onSyncMcp: (next: boolean) => void;
  onMcp: (name: string) => void;
  onBack: () => void;
  onSkip: () => void;
  onCopy: () => void;
}) {
  return (
    <div className="grid gap-3">
      <ProviderKeys
        keys={null}
        localKeys={localKeys}
        selected={copyProviders}
        onToggle={onToggle}
        hint="Only a provider with a saved key can be copied. Models without a key stay off for projects on this server."
      />
      <CapabilitySync
        checked={syncMcp}
        disabled={busy}
        mcpName={mcpName}
        mcpServers={mcpServers}
        onChange={onSyncMcp}
        onMcp={onMcp}
      />
      <div className="flex justify-between gap-2">
        <Button onClick={onBack} disabled={busy}>
          Back
        </Button>
        <div className="flex gap-2">
          <Button onClick={onSkip} disabled={busy}>
            Skip
          </Button>
          <Button variant="primary" disabled={busy || copyProviders.length === 0} onClick={onCopy}>
            {busy ? "Copying…" : "Copy keys"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CapabilitySync({
  checked,
  disabled,
  mcpName,
  mcpServers,
  onChange,
  onMcp,
}: {
  checked: boolean;
  disabled?: boolean;
  mcpName: string;
  mcpServers: DetectedMcpServer[];
  onChange: (next: boolean) => void;
  onMcp: (name: string) => void;
}) {
  const http = mcpServers.filter((row) => row.transport === "http");
  return (
    <div className={`grid gap-2 rounded-xl border px-3 py-3 ${checked ? "border-accent/70 bg-wash" : "border-ink/10 bg-panel"}`}>
      <button
        type="button"
        aria-pressed={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="grid gap-1 text-left disabled:opacity-50"
      >
        <span className="text-[13px] font-medium text-ink">{checked ? "Sync MCP and skills" : "Skip MCP and skills"}</span>
        <span className="text-[12px] leading-relaxed text-muted">
          Copies the MCP configs and skills from this Mac. Pick an HTTP server to sign in here first. That login is what gets sent.
        </span>
      </button>
      {checked && http.length ? (
        <label className="grid gap-1">
          <span className="text-[12px] text-muted">Sign in on this Mac</span>
          <select
            value={mcpName}
            disabled={disabled}
            onChange={(event) => onMcp(event.target.value)}
            className="h-9 rounded-lg border border-line bg-canvas px-2 text-[13px] outline-none"
          >
            <option value="">Already signed in</option>
            {http.map((row) => (
              <option key={row.name} value={row.name}>
                {row.name}
                {row.authed ? " · signed in" : ""}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

function keyHere(status: KeyStatus | null): boolean {
  return Boolean(status?.saved || status?.env);
}

function providerStatus(onServer: boolean, here: boolean, known: boolean): { text: string; ok: boolean } {
  if (!known) return here ? { text: "Key saved", ok: true } : { text: "No key", ok: false };
  if (onServer) return { text: "On server", ok: true };
  if (here) return { text: "Not copied", ok: false };
  return { text: "No key", ok: false };
}

function GitSection({
  git,
  online,
  busy,
  onInstall,
}: {
  git: boolean | "checking";
  online: boolean;
  busy: boolean;
  onInstall: () => void;
}) {
  const installed = git === true;
  const checking = git === "checking";
  return (
    <div className="grid gap-2">
      <div className="text-[11px] font-semibold tracking-wide text-muted uppercase">Git</div>
      <div className="flex items-center gap-3 rounded-xl border border-ink/10 bg-panel px-3 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-wash text-ink">
          <Symbol name="arrow.triangle.branch" className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-ink">Git</span>
          <span className={`block text-[11px] ${installed ? "text-ok" : "text-muted"}`}>
            {checking ? "Checking…" : installed ? "Installed" : online ? "Not installed" : "Unreachable"}
          </span>
        </span>
        {online && !installed && !checking ? (
          <Button disabled={busy} onClick={onInstall}>
            {busy ? "Installing…" : "Install git"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ProviderKeys({
  keys,
  localKeys,
  selected,
  onToggle,
  onSync,
  busy,
  hint,
}: {
  keys: ServerProviderKeys | null;
  localKeys: LocalKeys;
  selected: ProviderId[];
  onToggle?: (id: ProviderId) => void;
  onSync?: (id: ProviderId) => void;
  busy?: boolean;
  hint?: string;
}) {
  return (
    <div className="grid gap-2">
      <div className="text-[11px] font-semibold tracking-wide text-muted uppercase">Provider keys</div>
      <div className="grid grid-cols-3 gap-2">
        {PROVIDERS.map((provider) => {
          const here = keyHere(localKeys[provider.id]);
          const onServer = Boolean(keys?.[provider.id]);
          const status = providerStatus(onServer, here, keys != null);
          const on = selected.includes(provider.id);
          const canSync = Boolean(onSync) && here && !busy;
          return (
            <div
              key={provider.id}
              className={`relative grid justify-items-center gap-2 rounded-xl border border-ink/10 bg-panel px-2 py-3 text-center ${
                on && !onSync ? "border-accent/70 bg-wash" : ""
              }`}
            >
              {onSync ? (
                <button
                  type="button"
                  aria-label="Sync key to server"
                  disabled={!canSync}
                  onClick={() => onSync(provider.id)}
                  className="group/sync absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-md text-muted hover:bg-wash hover:text-ink disabled:opacity-35"
                >
                  <Symbol name="arrow.2.circlepath" className="size-3.5" />
                  <span
                    role="tooltip"
                    className="pointer-events-none absolute top-full right-0 z-10 mt-1 hidden w-max rounded-md bg-ink px-2 py-1 text-[11px] font-medium text-canvas group-hover/sync:block"
                  >
                    {here ? "Sync key to server" : "No key saved on this Mac"}
                  </span>
                </button>
              ) : (
                <button
                  type="button"
                  aria-pressed={on}
                  disabled={!here && !on}
                  onClick={() => onToggle?.(provider.id)}
                  className={`absolute top-1.5 right-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
                    on ? "bg-accent text-on-accent" : "text-muted hover:bg-wash hover:text-ink"
                  }`}
                >
                  {on ? "Copy" : "Skip"}
                </button>
              )}
              <span className={`flex size-8 items-center justify-center rounded-lg ${provider.mark}`}>
                <Symbol name={provider.logo} colored className="size-[18px]" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium text-ink">{provider.label}</span>
                <span className={`block truncate text-[11px] ${status.ok ? "text-ok" : "text-muted"}`}>
                  {localKeys[provider.id] || keys ? status.text : "Checking…"}
                </span>
              </span>
            </div>
          );
        })}
      </div>
      {hint ? <p className="m-0 text-[12px] text-muted">{hint}</p> : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1">
      <span className="text-[12px] text-muted">{label}</span>
      {children}
    </label>
  );
}

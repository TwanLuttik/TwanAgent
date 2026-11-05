import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "../Button";
import { Symbol } from "../Symbol";
import { formatTokenCount } from "../../lib/context";
import type { DetectedMcpServer } from "../../lib/mcp";
import type { AgentServer, ServerInstallStatus, ServerProject, ServerProviderKeys, ServerStorage } from "../../lib/tauri";
import * as api from "../../lib/tauri";
import { formatBytes, formatUsd, rangeStartMs, serverUsage, type UsageEvent, type UsageRange } from "../../lib/usage";
import { CapabilitySync, GitSection, ProviderKeys, newerVersion, versionLabel, type LocalKeys, type ProviderId } from "./ConnectSteps";

export type InstallView = ServerInstallStatus | "checking" | "copying";

export type CopyProgress = { phase: string; sent: number; total: number };

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

export function ServerRow({
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
  const updateReady = Boolean(known?.online && known.installed && newerVersion(known));
  const program = !known
    ? ""
    : !known.online
      ? "SSH did not answer"
      : known.installed
        ? versionLabel(known)
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
          {online == null ? (
            <span className="size-2 shrink-0 animate-pulse rounded-full bg-muted" title="Checking" />
          ) : (
            <StatusDot online={online} title={label} />
          )}
          <span className={`text-[11px] ${online ? "text-ok" : online == null ? "text-muted" : "text-err"}`}>
            {online == null ? "Checking" : label}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-[12px] text-muted">{address}</span>
      </span>
      <span className="flex items-center gap-3 text-[12px] text-muted">
        {updateReady && known ? (
          <span className="hidden items-center gap-1.5 sm:flex">
            <span>{program}</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-ok/15 px-1.5 py-0.5 font-medium text-ok">
              {newerVersion(known)}
            </span>
          </span>
        ) : program ? (
          <span className="hidden sm:block">{program}</span>
        ) : null}
        <span>{projects === 1 ? "1 project" : `${projects} projects`}</span>
        <Symbol name="chevron.right" className="size-3.5" />
      </span>
    </button>
  );
}

function Fact({ label, value, mono, children }: { label: string; value?: string; mono?: boolean; children?: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">{label}</span>
      {children ?? <span className={`truncate text-[13px] text-ink ${mono ? "font-mono" : ""}`}>{value}</span>}
    </div>
  );
}

function CopyBar({ progress }: { progress: CopyProgress | null }) {
  const total = progress?.total ?? 0;
  const sent = progress?.sent ?? 0;
  const ratio = total > 0 ? Math.min(1, sent / total) : progress?.phase === "installing" ? 1 : 0;
  const label =
    progress?.phase === "installing"
      ? "Installing"
      : progress?.phase === "reading"
        ? "Reading the program"
        : total > 0
          ? `Copying ${formatBytes(sent)} of ${formatBytes(total)}`
          : "Copying";
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between text-[12px] text-muted">
        <span>{label}</span>
        <span>{total > 0 ? `${Math.round(ratio * 100)}%` : ""}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-ink/10" role="progressbar" aria-valuenow={Math.round(ratio * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-accent transition-[width] duration-150" style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
    </div>
  );
}

function VersionFact({ installed, next, copying }: { installed: string; next: string; copying: boolean }) {
  return (
    <Fact label="Version">
      <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-[13px]">
        <span className="truncate text-muted line-through decoration-muted/70">{installed}</span>
        <Symbol name="chevron.right" className="size-3 shrink-0 text-muted" />
        <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-ok/15 px-2 py-0.5 font-medium text-ok">
          <span className="size-1.5 shrink-0 rounded-full bg-ok" />
          <span className="truncate">{copying ? "Installing…" : next}</span>
        </span>
      </span>
    </Fact>
  );
}

export function ServerDetail({
  row,
  status,
  projects,
  projectsLoading,
  copy,
  openingPath,
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
  onWipe,
  onRotate,
  onRecheck,
  onOpenProject,
  onToggleProvider,
  onCopyKeys,
  onInstallGit,
  onSyncCapabilities,
  mcpName,
  localMcp,
  onMcpName,
  mountPaths,
  onRename,
}: {
  row: AgentServer;
  status: InstallView | undefined;
  projects: ServerProject[];
  projectsLoading: boolean;
  copy: CopyProgress | null;
  openingPath: string | null;
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
  onWipe: () => void;
  onRotate: () => void;
  onRecheck: () => void;
  onOpenProject: (project: ServerProject) => void;
  onToggleProvider: (id: ProviderId) => void;
  onCopyKeys: (id: ProviderId) => void;
  onInstallGit: () => void;
  onSyncCapabilities: () => void;
  mcpName: string;
  localMcp: DetectedMcpServer[];
  onMcpName: (name: string) => void;
  /** Local folders whose chats run on this server. Usage is matched against these. */
  mountPaths: string[];
  onRename: (name: string) => Promise<void>;
}) {
  const { label, online } = reachOf(status);
  const copying = status === "copying";
  const known = status && typeof status !== "string" ? status : null;
  const installed = Boolean(known?.installed);
  const needsToken = Boolean(known && online && installed && !row.paired);
  const address = `${row.user}@${row.host}${row.port === 22 ? "" : `:${row.port}`}`;
  const version = !known ? "Checking…" : !known.online ? "Unreachable" : installed ? versionLabel(known as ServerInstallStatus) : "Not installed";
  const nextVersion = known && installed ? newerVersion(known) : "";
  const update = Boolean(known?.online && nextVersion);
  const protocolBehind = Boolean(
    known?.online && installed && known.protocol && known.desktop_protocol && known.protocol < known.desktop_protocol,
  );
  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={onBack} className="flex items-center gap-1 text-[12px] text-muted hover:text-ink">
          <Symbol name="chevron.left" className="size-3.5" />
          Servers
        </button>
        <span className="flex items-center gap-3">
          <button type="button" className="text-[12px] text-muted hover:text-ink" disabled={busy} onClick={onRotate}>
            Rotate token
          </button>
          <button type="button" className="text-[12px] text-muted hover:text-err" disabled={busy} onClick={onWipe}>
            Sign everyone out
          </button>
          <button type="button" className="text-[12px] text-muted hover:text-err" disabled={busy} onClick={onRemove}>
            Remove
          </button>
        </span>
      </div>
      <div className="flex items-start gap-3">
        <span className="flex size-10 items-center justify-center rounded-full bg-inset text-accent">
          <Symbol name="server.rack" className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <ServerName name={row.name} disabled={busy} onRename={onRename} />
          <p className="mt-0.5 mb-0 flex items-center gap-1.5 text-[12px] text-muted">
            <StatusDot online={online} title={label} />
            {label} · {address}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 rounded-xl bg-inset/70 px-3 py-3">
        {update && nextVersion ? (
          <VersionFact installed={version} next={nextVersion} copying={copying} />
        ) : (
          <Fact label="Version" value={version} />
        )}
        <Fact label="Pairing" value={row.paired ? "Paired" : needsToken ? "Needs a token" : "Not paired"} />
        {protocolBehind ? (
          <Fact label="Protocol" value="This server speaks an older protocol. Update it before opening a chat." />
        ) : null}
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
      <ServerUsage serverId={row.id} mountPaths={mountPaths} />
      {copying ? <CopyBar progress={copy} /> : null}
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
        {projectsLoading && projects.length === 0 ? (
          <p className="m-0 rounded-xl border border-dashed border-ink/10 px-3 py-4 text-[12px] text-muted">
            Looking on the server…
          </p>
        ) : projects.length === 0 ? (
          <p className="m-0 rounded-xl border border-dashed border-ink/10 px-3 py-4 text-[12px] text-muted">
            No projects on this server yet. Create one from the folder picker.
          </p>
        ) : (
          projects.map((project) => {
            const opening = openingPath === project.remote_path;
            return (
              <button
                key={project.remote_path}
                type="button"
                disabled={busy || Boolean(openingPath)}
                onClick={() => onOpenProject(project)}
                className="flex items-center gap-2 rounded-xl border border-ink/10 bg-panel px-3 py-2.5 text-left hover:border-ink/30 disabled:opacity-60"
              >
                <Symbol name="folder.fill" className="size-3.5 shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink">{project.name}</span>
                  <span className="block truncate font-mono text-[11px] text-muted">{project.remote_path}</span>
                </span>
                <span className="shrink-0 text-[11px] text-muted">{opening ? "Opening…" : "Open"}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

const USAGE_RANGES: { id: UsageRange; label: string }[] = [
  { id: "24h", label: "24h" },
  { id: 7, label: "7d" },
  { id: 30, label: "30d" },
  { id: 90, label: "90d" },
];

function ServerName({
  name,
  disabled,
  onRename,
}: {
  name: string;
  disabled: boolean;
  onRename: (name: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(name);
  const skip = useRef(false);
  useEffect(() => setDraft(name), [name]);
  function commit() {
    if (skip.current) {
      skip.current = false;
      return;
    }
    const next = draft.trim();
    if (!next || next === name) {
      setDraft(name);
      return;
    }
    void onRename(next).catch(() => setDraft(name));
  }
  return (
    <input
      aria-label="Server name"
      value={draft}
      disabled={disabled}
      maxLength={80}
      onChange={(ev) => setDraft(ev.target.value)}
      onBlur={commit}
      onKeyDown={(ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          ev.currentTarget.blur();
        }
        if (ev.key === "Escape") {
          ev.preventDefault();
          ev.stopPropagation();
          skip.current = true;
          setDraft(name);
          ev.currentTarget.blur();
        }
      }}
      className="m-0 w-full min-w-0 truncate bg-transparent text-[15px] font-semibold text-ink outline-none placeholder:text-muted focus:underline"
    />
  );
}

function ServerUsage({ serverId, mountPaths }: { serverId: string; mountPaths: string[] }) {
  const [range, setRange] = useState<UsageRange>(30);
  const [events, setEvents] = useState<UsageEvent[] | null>(null);
  useEffect(() => {
    let gone = false;
    setEvents(null);
    const since = new Date(rangeStartMs(90)).toISOString();
    void api
      .usageSync()
      .catch(() => 0)
      .then(() => api.usageList(since))
      .then((rows) => {
        if (!gone) setEvents(rows);
      })
      .catch(() => {
        if (!gone) setEvents([]);
      });
    return () => {
      gone = true;
    };
  }, [serverId]);
  const totals = useMemo(
    () => (events ? serverUsage(events, mountPaths, range) : null),
    [events, mountPaths, range],
  );
  const empty = events != null && (totals?.tokens ?? 0) <= 0;
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-semibold tracking-wide text-muted uppercase">Usage</div>
        <div className="flex items-center gap-1" role="group" aria-label="Usage range">
          {USAGE_RANGES.map((item) => {
            const on = item.id === range;
            return (
              <button
                key={item.label}
                type="button"
                aria-pressed={on}
                onClick={() => setRange(item.id)}
                className={`rounded-md px-1.5 py-0.5 text-[11px] ${on ? "bg-wash text-ink" : "text-muted hover:text-ink"}`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 rounded-xl bg-inset/70 px-3 py-3">
        <Fact label="Tokens" value={totals ? formatTokenCount(totals.tokens) : "Checking…"} />
        <Fact label="Estimated spend" value={totals ? formatUsd(totals.usd) : "Checking…"} />
      </div>
      {empty ? (
        <p className="m-0 text-[12px] text-muted">No usage on this server in this range yet.</p>
      ) : null}
    </div>
  );
}

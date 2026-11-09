import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "../Button";
import { Symbol } from "../Symbol";
import { formatTokenCount } from "../../lib/context";
import type { DetectedMcpServer } from "../../lib/mcp";
import type { AgentServer, ServerInstallStatus, ServerProject, ServerProviderKeys, ServerStorage } from "../../lib/tauri";
import * as api from "../../lib/tauri";
import { formatBytes, formatUsd, rangeStartMs, serverUsage, type UsageEvent, type UsageRange } from "../../lib/usage";
import { PROVIDERS, newerVersion, versionLabel, type LocalKeys, type ProviderId } from "./ConnectSteps";

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

function placeOf(host: string): string | null {
  if (host.endsWith("@orb")) return "OrbStack";
  if (host.startsWith("100.")) return "Tailscale";
  return null;
}

function addedOn(iso: string | undefined): string {
  if (!iso) return "Not recorded";
  const day = iso.slice(0, 10);
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return day || "Not recorded";
  return new Date(year, month - 1, date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function savedLocally(keys: LocalKeys, id: ProviderId): boolean {
  const status = keys[id];
  return Boolean(status?.saved || status?.env);
}

function rangePhrase(range: UsageRange): string {
  if (range === "24h") return "the last 24 hours";
  return `the last ${range} days`;
}

/** Keys that exist on this Mac but were never sent, plus a missing git install. */
function setupHint(keys: ServerProviderKeys | null, localKeys: LocalKeys, git: boolean | "checking"): string {
  const parts: string[] = [];
  if (keys) {
    const waiting = PROVIDERS.filter((provider) => savedLocally(localKeys, provider.id) && !keys[provider.id]).map(
      (provider) => provider.label,
    );
    if (waiting.length === 1) parts.push(`${waiting[0]} is on this Mac, not on this server.`);
    else if (waiting.length === 2) parts.push(`${waiting[0]} and ${waiting[1]} are on this Mac, not on this server.`);
    else if (waiting.length > 2) {
      parts.push(`${waiting.slice(0, -1).join(", ")}, and ${waiting[waiting.length - 1]} are on this Mac, not on this server.`);
    }
  }
  if (git === false) parts.push("Git is not installed.");
  return parts.join(" ");
}

function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`divide-y divide-line/50 overflow-hidden rounded-xl border border-line/45 bg-panel ${className}`}>
      {children}
    </div>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-1.5">
      <div className="flex items-center justify-between gap-3 px-0.5">
        <h3 className="m-0 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Chip({ children, tone = "muted" }: { children: ReactNode; tone?: "ok" | "warn" | "muted" }) {
  const color = tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : "text-muted";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full bg-inset px-2 py-0.5 text-[11px] ${color}`}>{children}</span>
  );
}

function Banner({
  tone,
  title,
  text,
  action,
}: {
  tone: "accent" | "warn" | "err";
  title: string;
  text: string;
  action?: ReactNode;
}) {
  const wash = tone === "err" ? "bg-err/10" : tone === "warn" ? "bg-warn/10" : "bg-accent/10";
  return (
    <div className={`flex items-center gap-3 border-t border-line/40 px-3.5 py-2.5 ${wash}`}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink">{title}</div>
        <div className="text-[12px] leading-relaxed text-muted">{text}</div>
      </div>
      {action}
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
  const input = useRef<HTMLInputElement>(null);
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
    <div className="flex min-w-0 items-center gap-1">
      <input
        ref={input}
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
        className="m-0 min-w-0 flex-1 truncate bg-transparent text-[16px] font-semibold tracking-[-0.01em] text-ink outline-none placeholder:text-muted focus:underline"
      />
      <button
        type="button"
        aria-label="Rename server"
        title="Rename"
        disabled={disabled}
        onClick={() => {
          input.current?.focus();
          input.current?.select();
        }}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-wash hover:text-ink disabled:opacity-40"
      >
        <Symbol name="pencil" className="size-3" />
      </button>
    </div>
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
  const named = row.name.trim() !== "" && row.name.trim() !== row.host;
  const who = named ? `${row.user}@${row.host}${row.port === 22 ? "" : `:${row.port}`}` : row.user;
  const version = !known ? "Checking…" : !known.online ? "Unreachable" : installed ? versionLabel(known) : "Not installed";
  const nextVersion = known && installed ? newerVersion(known) : "";
  const update = Boolean(known?.online && nextVersion);
  const protocolBehind = Boolean(
    known?.online && installed && known.protocol && known.desktop_protocol && known.protocol < known.desktop_protocol,
  );
  const place = placeOf(row.host);
  const unreachable = known != null && !known.online;
  const hint = known?.online && installed && !needsToken && !update && !protocolBehind ? setupHint(keys, localKeys, git) : "";
  const recheck = (
    <Button size="sm" className="shrink-0" disabled={busy || copying} onClick={onRecheck}>
      {copying ? "Installing…" : status === "checking" ? "Checking…" : "Check again"}
    </Button>
  );
  const updateButton = (
    <Button size="sm" className="shrink-0" variant="primary" disabled={busy || copying} onClick={onInstall}>
      {copying ? "Updating…" : "Update"}
    </Button>
  );

  let banner: ReactNode = null;
  if (!copying && unreachable) {
    banner = (
      <Banner
        tone="err"
        title="This server did not answer"
        text="Check that the machine is on, then try again."
        action={recheck}
      />
    );
  } else if (!copying && known?.online && !installed) {
    banner = (
      <Banner
        tone="accent"
        title="TwanAgent is not installed here"
        text="Install it to open projects on this machine."
        action={
          <Button size="sm" className="shrink-0" variant="primary" disabled={busy} onClick={onInstall}>
            Install
          </Button>
        }
      />
    );
  } else if (!copying && protocolBehind) {
    banner = (
      <Banner
        tone="warn"
        title="This server is too old to open a chat"
        text="Update it before starting a conversation."
        action={updateButton}
      />
    );
  } else if (!copying && update && nextVersion) {
    banner = (
      <Banner
        tone="accent"
        title={`${nextVersion} is ready`}
        text={`This server is running ${version}.`}
        action={updateButton}
      />
    );
  } else if (!copying && needsToken) {
    banner = (
      <Banner
        tone="warn"
        title="This Mac is not paired"
        text="Pair it before opening a chat on this server."
        action={
          <Button size="sm" className="shrink-0" variant="primary" disabled={busy} onClick={onPair}>
            Pair
          </Button>
        }
      />
    );
  }

  return (
    <div className="grid gap-5">
      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={onBack} className="flex items-center gap-1 text-[12px] text-muted hover:text-ink">
          <Symbol name="chevron.left" className="size-3.5" />
          Servers
        </button>
        {banner && unreachable ? null : recheck}
      </div>

      <div className="overflow-hidden rounded-xl border border-line/45 bg-panel">
        <div className="flex items-start gap-3 px-3.5 py-3.5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-inset text-accent">
            <Symbol name="server.rack" className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <ServerName name={row.name} disabled={busy} onRename={onRename} />
            <p className="mt-0.5 mb-0 flex items-center gap-1.5 text-[12px] text-muted">
              <StatusDot online={online} title={label} />
              <span className={online ? "text-ok" : online == null ? "text-muted" : "text-err"}>{label}</span>
              <span aria-hidden>·</span>
              <span className="truncate">{who}</span>
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5 border-t border-line/40 px-3.5 py-2.5">
          <Chip tone={row.paired ? "ok" : needsToken ? "warn" : "muted"}>{row.paired ? "Paired" : "Not paired"}</Chip>
          <Chip tone={installed ? "muted" : known?.online ? "warn" : "muted"}>{installed ? version : known?.online ? "Not installed" : version}</Chip>
          {place ? <Chip>{place}</Chip> : null}
          <Chip tone={git === true ? "ok" : git === false ? "warn" : "muted"}>
            {git === "checking" ? "Checking git" : git ? "Git installed" : "Git missing"}
          </Chip>
          {storage ? <Chip>{formatBytes(storage.bytes)} stored</Chip> : null}
        </div>
        {copying ? (
          <div className="border-t border-line/40 px-3.5 py-3">
            <CopyBar progress={copy} />
          </div>
        ) : null}
        {banner}
        {hint ? <p className="m-0 border-t border-line/40 px-3.5 py-2.5 text-[12px] leading-relaxed text-muted">{hint}</p> : null}
      </div>

      <ProjectList
        projects={projects}
        loading={projectsLoading}
        openingPath={openingPath}
        busy={busy}
        onOpen={onOpenProject}
      />
      <ServerUsage serverId={row.id} mountPaths={mountPaths} />
      <SetupSection
        keys={keys}
        localKeys={localKeys}
        git={git}
        online={online === true}
        busy={busy}
        mcpName={mcpName}
        localMcp={localMcp}
        onMcpName={onMcpName}
        onCopyKeys={onCopyKeys}
        onInstallGit={onInstallGit}
        onSync={onSyncCapabilities}
      />
      <Details row={row} knownPath={known?.path} storage={storage} />
      <DangerZone busy={busy} unreachable={unreachable} onRotate={onRotate} onWipe={onWipe} onRemove={onRemove} />
    </div>
  );
}

function ProjectList({
  projects,
  loading,
  openingPath,
  busy,
  onOpen,
}: {
  projects: ServerProject[];
  loading: boolean;
  openingPath: string | null;
  busy: boolean;
  onOpen: (project: ServerProject) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? projects.filter(
        (project) => project.name.toLowerCase().includes(needle) || project.remote_path.toLowerCase().includes(needle),
      )
    : projects;
  return (
    <Section
      title="Projects"
      aside={
        <span className="text-[11px] text-muted tabular-nums">
          {loading && projects.length === 0 ? "" : projects.length}
        </span>
      }
    >
      {projects.length > 5 ? (
        <div className="relative">
          <Symbol
            name="magnifyingglass"
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted"
          />
          <input
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
            placeholder="Filter projects"
            aria-label="Filter projects"
            className="h-8 w-full rounded-lg border border-line bg-canvas pr-2 pl-8 text-[13px] text-ink outline-none placeholder:text-muted focus:border-accent"
          />
        </div>
      ) : null}
      <Panel className={shown.length > 6 ? "max-h-80 overflow-auto" : ""}>
        {loading && projects.length === 0 ? (
          <p className="m-0 px-3.5 py-4 text-[12px] text-muted">Looking on the server…</p>
        ) : projects.length === 0 ? (
          <p className="m-0 px-3.5 py-4 text-[12px] leading-relaxed text-muted">
            No projects on this server yet. Add one from the folder picker and choose this server.
          </p>
        ) : shown.length === 0 ? (
          <p className="m-0 px-3.5 py-4 text-[12px] text-muted">No project matches “{query.trim()}”.</p>
        ) : (
          shown.map((project) => {
            const opening = openingPath === project.remote_path;
            return (
              <button
                key={project.remote_path}
                type="button"
                disabled={busy || Boolean(openingPath)}
                onClick={() => onOpen(project)}
                className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-wash disabled:opacity-60"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-inset text-muted">
                  <Symbol name="folder.fill" className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-ink">{project.name}</span>
                  <span className="block truncate font-mono text-[11px] text-muted" title={project.remote_path}>
                    {project.remote_path}
                  </span>
                </span>
                {project.saved ? <span className="shrink-0 text-[11px] text-ok">On this Mac</span> : null}
                <span className="shrink-0 text-[12px] text-muted">{opening ? "Opening…" : "Open"}</span>
              </button>
            );
          })
        )}
      </Panel>
    </Section>
  );
}

const USAGE_RANGES: { id: UsageRange; label: string }[] = [
  { id: "24h", label: "24h" },
  { id: 7, label: "7d" },
  { id: 30, label: "30d" },
  { id: 90, label: "90d" },
];

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
    <Section
      title="Usage"
      aside={
        <div className="flex items-center rounded-lg bg-inset p-0.5" role="group" aria-label="Usage range">
          {USAGE_RANGES.map((item) => {
            const on = item.id === range;
            return (
              <button
                key={item.label}
                type="button"
                aria-pressed={on}
                onClick={() => setRange(item.id)}
                className={`rounded-md px-2 py-0.5 text-[11px] ${on ? "bg-canvas text-ink shadow-sm" : "text-muted hover:text-ink"}`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      }
    >
      <Panel>
        <div className="grid grid-cols-2 divide-x divide-line/50">
          <Stat label="Tokens" value={totals ? formatTokenCount(totals.tokens) : "Checking…"} />
          <Stat label="Estimated spend" value={totals ? formatUsd(totals.usd) : "Checking…"} />
        </div>
        {empty ? (
          <p className="m-0 px-3.5 py-2.5 text-[12px] leading-relaxed text-muted">
            {mountPaths.length === 0
              ? "Open a project on this server and its usage will show up here."
              : `No usage in ${rangePhrase(range)}.`}
          </p>
        ) : null}
      </Panel>
    </Section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3.5 py-3">
      <div className="text-[18px] font-semibold tracking-[-0.02em] text-ink tabular-nums">{value}</div>
      <div className="mt-0.5 text-[12px] text-muted">{label}</div>
    </div>
  );
}

type KeyTone = "ok" | "warn" | "muted";

function keyState(
  onServer: boolean,
  here: boolean,
  serverKnown: boolean,
  localKnown: boolean,
): { text: string; tone: KeyTone; action: "copy" | "replace" | null } {
  if (!serverKnown && !localKnown) return { text: "Checking…", tone: "muted", action: null };
  if (!serverKnown) {
    return here
      ? { text: "Saved on this Mac", tone: "muted", action: null }
      : { text: "No key on this Mac", tone: "muted", action: null };
  }
  if (onServer && here) return { text: "On this server", tone: "ok", action: "replace" };
  if (onServer) return { text: "On this server", tone: "ok", action: null };
  if (here) return { text: "Only on this Mac", tone: "warn", action: "copy" };
  return { text: "No key on this Mac", tone: "muted", action: null };
}

function SetupSection({
  keys,
  localKeys,
  git,
  online,
  busy,
  mcpName,
  localMcp,
  onMcpName,
  onCopyKeys,
  onInstallGit,
  onSync,
}: {
  keys: ServerProviderKeys | null;
  localKeys: LocalKeys;
  git: boolean | "checking";
  online: boolean;
  busy: boolean;
  mcpName: string;
  localMcp: DetectedMcpServer[];
  onMcpName: (name: string) => void;
  onCopyKeys: (id: ProviderId) => void;
  onInstallGit: () => void;
  onSync: () => void;
}) {
  return (
    <Section title="Keys and tools">
      <Panel>
        {PROVIDERS.map((provider) => {
          const here = savedLocally(localKeys, provider.id);
          const state = keyState(Boolean(keys?.[provider.id]), here, keys != null, localKeys[provider.id] != null);
          const action = online ? state.action : null;
          const tone = state.tone === "ok" ? "text-ok" : state.tone === "warn" ? "text-warn" : "text-muted";
          return (
            <div key={provider.id} className="flex items-center gap-3 px-3.5 py-2.5">
              <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${provider.mark}`}>
                <Symbol name={provider.logo} colored className="size-[18px]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-ink">{provider.label}</span>
                <span className={`block truncate text-[12px] ${tone}`}>{state.text}</span>
              </span>
              {action ? (
                <Button
                  size="sm"
                  variant={action === "replace" ? "toolbar" : "default"}
                  className="shrink-0"
                  disabled={busy}
                  title="Send the key saved on this Mac"
                  onClick={() => onCopyKeys(provider.id)}
                >
                  {action === "replace" ? "Replace" : "Copy"}
                </Button>
              ) : null}
            </div>
          );
        })}
        {online ? (
          <ToolsRow busy={busy} mcpName={mcpName} localMcp={localMcp} onMcpName={onMcpName} onSync={onSync} />
        ) : null}
        {online && git === false ? (
          <div className="flex items-center gap-3 px-3.5 py-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-wash text-ink">
              <Symbol name="arrow.triangle.branch" className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-ink">Git</span>
              <span className="block text-[12px] text-muted">Needed to clone and commit on this server.</span>
            </span>
            <Button size="sm" className="shrink-0" disabled={busy} onClick={onInstallGit}>
              {busy ? "Installing…" : "Install git"}
            </Button>
          </div>
        ) : null}
      </Panel>
    </Section>
  );
}

function ToolsRow({
  busy,
  mcpName,
  localMcp,
  onMcpName,
  onSync,
}: {
  busy: boolean;
  mcpName: string;
  localMcp: DetectedMcpServer[];
  onMcpName: (name: string) => void;
  onSync: () => void;
}) {
  const http = localMcp.filter((row) => row.transport === "http");
  return (
    <div className="px-3.5 py-2.5">
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-wash text-ink">
          <Symbol name="rectangle.stack" className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-ink">Tools and skills</span>
          <span className="block text-[12px] leading-relaxed text-muted">
            Sends the MCP servers and skills from this Mac.
          </span>
        </span>
        <Button size="sm" className="shrink-0" disabled={busy} onClick={onSync}>
          {busy ? "Syncing…" : "Sync"}
        </Button>
      </div>
      {http.length ? (
        <label className="mt-2.5 grid gap-1 pl-11">
          <span className="text-[12px] text-muted">Login to send</span>
          <select
            value={mcpName}
            disabled={busy}
            onChange={(event) => onMcpName(event.target.value)}
            className="h-8 rounded-lg border border-line bg-canvas px-2 text-[13px] text-ink outline-none focus:border-accent"
          >
            <option value="">Keep the logins already on this Mac</option>
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

function Details({
  row,
  knownPath,
  storage,
}: {
  row: AgentServer;
  knownPath: string | undefined;
  storage: ServerStorage | null;
}) {
  const [open, setOpen] = useState(false);
  const database = storage
    ? `${formatBytes(storage.bytes)} on disk, ${formatBytes(storage.conversation_bytes)} in conversations`
    : "Checking…";
  return (
    <section className="grid gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 px-0.5 text-[12px] text-muted hover:text-ink"
      >
        <Symbol name={open ? "chevron.down" : "chevron.right"} className="size-3" />
        Details
      </button>
      {open ? (
        <Panel>
          <DetailLine label="Program" value={knownPath || "~/.twanagent/bin/twanagent-server"} mono />
          <DetailLine label="Added" value={addedOn(row.installed_at)} />
          <DetailLine label="Database" value={database} />
        </Panel>
      ) : null}
    </section>
  );
}

function DetailLine({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 px-3.5 py-2">
      <span className="w-16 shrink-0 text-[12px] text-muted">{label}</span>
      <span title={value} className={`min-w-0 flex-1 truncate text-[12px] text-ink ${mono ? "font-mono" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function DangerZone({
  busy,
  unreachable,
  onRotate,
  onWipe,
  onRemove,
}: {
  busy: boolean;
  unreachable: boolean;
  onRotate: () => void;
  onWipe: () => void;
  onRemove: () => void;
}) {
  const [armed, setArmed] = useState<null | "rotate" | "wipe" | "remove">(null);
  return (
    <Section title="Danger zone">
      <Panel>
        <DangerRow
          title="Rotate token"
          text="Signs every other computer out. This Mac stays paired."
          confirm="Rotate"
          armed={armed === "rotate"}
          disabled={busy || unreachable}
          onArm={() => setArmed("rotate")}
          onCancel={() => setArmed(null)}
          onConfirm={() => {
            setArmed(null);
            onRotate();
          }}
        />
        <DangerRow
          title="Sign everyone out"
          text="Deletes the login on the machine and removes this server from this Mac."
          confirm="Sign out"
          armed={armed === "wipe"}
          disabled={busy || unreachable}
          onArm={() => setArmed("wipe")}
          onCancel={() => setArmed(null)}
          onConfirm={() => {
            setArmed(null);
            onWipe();
          }}
        />
        <DangerRow
          title="Remove"
          text="Forgets this server on this Mac. The machine and its login stay."
          confirm="Remove"
          armed={armed === "remove"}
          disabled={busy}
          onArm={() => setArmed("remove")}
          onCancel={() => setArmed(null)}
          onConfirm={() => {
            setArmed(null);
            onRemove();
          }}
        />
      </Panel>
    </Section>
  );
}

function DangerRow({
  title,
  text,
  confirm,
  armed,
  disabled,
  onArm,
  onCancel,
  onConfirm,
}: {
  title: string;
  text: string;
  confirm: string;
  armed: boolean;
  disabled: boolean;
  onArm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink">{title}</div>
        <div className="text-[12px] leading-relaxed text-muted">{armed ? "This takes effect immediately." : text}</div>
      </div>
      {armed ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" disabled={disabled} onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="danger" disabled={disabled} onClick={onConfirm}>
            {confirm}
          </Button>
        </span>
      ) : (
        <Button size="sm" className="shrink-0" variant="danger" disabled={disabled} onClick={onArm}>
          {confirm}
        </Button>
      )}
    </div>
  );
}

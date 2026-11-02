import type { ReactNode } from "react";
import { Button } from "../Button";
import { Symbol } from "../Symbol";
import type { DetectedMcpServer } from "../../lib/mcp";
import type { KeyStatus, LanHost, ServerInstallStatus, ServerProviderKeys } from "../../lib/tauri";

export type ProviderId = "xai" | "anthropic" | "minimax";

export const PROVIDERS: { id: ProviderId; label: string; logo: string; mark: string }[] = [
  { id: "xai", label: "Grok", logo: "logo.grok", mark: "bg-[#1a1a1a] text-white" },
  { id: "anthropic", label: "Claude", logo: "logo.claude", mark: "bg-[#d97757] text-[#faf9f5]" },
  { id: "minimax", label: "MiniMax", logo: "logo.minimax", mark: "bg-wash text-ink" },
];

export type LocalKeys = Record<ProviderId, KeyStatus | null>;

function versionText(raw: string): string {
  return raw.replace(/^twanagent-server\s+/, "").replace(/\0/g, "").trim();
}

export function versionLabel(status: ServerInstallStatus): string {
  const version = versionText(status.version);
  if (!version || version === "unknown") return "Installed, version unreadable";
  return version;
}

/** A real newer build, not the same version shown twice because of a trailing null. */
export function newerVersion(status: ServerInstallStatus): string {
  if (!status.update) return "";
  const next = versionText(status.available || "");
  const current = versionText(status.version);
  if (!next || next === current) return "";
  return next;
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

export function ConnectForm({
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

export function InstallStep({
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

export function KeysStep({
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

export function CapabilitySync({
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

export function GitSection({
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

export function ProviderKeys({
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

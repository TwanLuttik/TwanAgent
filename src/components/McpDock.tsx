import { mcpPillSummary, type DetectedMcpServer } from "../lib/mcp";
import { Button } from "./Button";
import { DockShell } from "./DockShell";

export function McpDock({
  servers,
  busyName,
  onToggle,
  onEdit,
  onReauth,
}: {
  servers: DetectedMcpServer[];
  busyName?: string | null;
  onToggle: (server: DetectedMcpServer, enabled: boolean) => void;
  onEdit: (server: DetectedMcpServer) => void;
  onReauth: (server: DetectedMcpServer) => void;
}) {
  if (servers.length === 0) return null;
  const onCount = servers.filter((row) => row.enabled).length;
  return (
    <DockShell
      icon="cable.connector"
      summary={mcpPillSummary(servers)}
      meta={`${onCount}/${servers.length} on`}
      hint="Toggle what Grok can use. Edit opens the config here. Sign in opens the browser."
    >
      <div className="space-y-1">
        {servers.map((server) => {
          const busy = busyName === server.name;
          return (
            <div
              key={server.sources.join("|") + server.name}
              className="flex items-center gap-2.5 rounded-xl px-1.5 py-1.5 hover:bg-wash"
            >
              <EnableSwitch
                on={server.enabled}
                disabled={busy}
                label={`Enable ${server.name}`}
                onClick={() => onToggle(server, !server.enabled)}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] leading-5 font-medium text-ink">{server.name}</div>
                <div className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 whitespace-nowrap text-muted/75">
                  <span className="shrink-0">{server.transport === "http" ? "HTTP" : "Local"}</span>
                  {server.transport === "http" ? <AuthStatus authed={server.authed} /> : null}
                  <span className="min-w-0 truncate">{server.sources.join(" · ")}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {server.transport === "http" && !server.authed ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => onReauth(server)}
                    title="Sign in with OAuth"
                  >
                    Sign in
                  </Button>
                ) : null}
                {server.transport === "http" && server.authed ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => onReauth(server)}
                    title="Clear saved login and sign in again"
                  >
                    Re-auth
                  </Button>
                ) : null}
                <Button size="sm" disabled={busy} onClick={() => onEdit(server)} title="Edit config">
                  Edit
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </DockShell>
  );
}

function AuthStatus({ authed }: { authed: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-medium ${
        authed ? "bg-ok/12 text-ok" : "bg-warn/15 text-warn"
      }`}
    >
      <span className={`size-1.5 rounded-full ${authed ? "bg-ok" : "bg-warn"}`} aria-hidden />
      {authed ? "Signed in" : "Not signed in"}
    </span>
  );
}

function EnableSwitch({
  on,
  disabled,
  label,
  onClick,
}: {
  on: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors disabled:opacity-45 ${
        on ? "bg-accent" : "bg-inset"
      }`}
    >
      <span
        className={`absolute top-[2px] size-[14px] rounded-full bg-white shadow-sm transition-[left] ${
          on ? "left-[14px]" : "left-[2px]"
        }`}
      />
    </button>
  );
}

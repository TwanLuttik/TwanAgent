import type { ReactNode } from "react";
import { Button } from "../../components/Button";
import { Symbol } from "../../components/Symbol";
import { maskEmail } from "../../lib/mask";
import * as api from "../../lib/tauri";

export type ProviderCardId = "xai" | "anthropic" | "minimax";

export type ProviderCard = {
  id: ProviderCardId;
  cli: "grokCli" | "claudeCli" | "minimaxCli";
  title: string;
  text: string;
  logo: string;
  markClass: string;
  keyLabel: string;
  keyName: string;
  envName: string;
  placeholder: string;
  save: (key: string) => Promise<{ saved: boolean; env: boolean }>;
  clear: () => Promise<{ saved: boolean; env: boolean }>;
};

/** One card per provider. A new provider is another row here, not another copy of the form. */
export const PROVIDER_CARDS: ProviderCard[] = [
  {
    id: "xai",
    cli: "grokCli",
    title: "Grok",
    text: "xAI models. The CLI login is used when no API key is saved.",
    logo: "logo.grok",
    markClass: "bg-[#1a1a1a] text-white",
    keyLabel: "xAI API key",
    keyName: "xAI",
    envName: "XAI_API_KEY",
    placeholder: "xai-…",
    save: api.setKey,
    clear: api.clearKey,
  },
  {
    id: "anthropic",
    cli: "claudeCli",
    title: "Claude",
    text: "Anthropic models. The CLI login is used when no API key is saved.",
    logo: "logo.claude",
    markClass: "bg-[#d97757] text-[#faf9f5]",
    keyLabel: "Anthropic API key",
    keyName: "Anthropic",
    envName: "ANTHROPIC_API_KEY",
    placeholder: "sk-ant-…",
    save: api.setAnthropicKey,
    clear: api.clearAnthropicKey,
  },
  {
    id: "minimax",
    cli: "minimaxCli",
    title: "MiniMax",
    text: "MiniMax models. The mmx login is used when no API key is saved.",
    logo: "logo.minimax",
    markClass: "bg-wash",
    keyLabel: "MiniMax API key",
    keyName: "MiniMax",
    envName: "MINIMAX_API_KEY",
    placeholder: "sk-…",
    save: api.setMinimaxKey,
    clear: api.clearMinimaxKey,
  },
];

type CliRow = {
  installed: boolean;
  path: string;
  version: string | null;
  logged_in: boolean;
  email: string | null;
  update?: string;
};

function cliCanUpdate(cli: CliRow | null): boolean {
  return Boolean(cli?.installed && cli.update && cli.update !== cli.version);
}

function providerStatusLine(cli: CliRow | null, key: { saved: boolean; env: boolean } | null): string {
  if (!cli && !key) return "Checking…";
  if (cli?.logged_in) {
    return cli.email ? "Authenticated" : "Authenticated · CLI";
  }
  if (key?.saved) return "Authenticated · saved key";
  if (key?.env) return "Authenticated · environment";
  if (cli && !cli.installed) return "CLI not found";
  return "Not signed in";
}

export function ProvidersPane({
  cards,
  selectedId,
  onSelect,
  statusFor,
  cliFor,
  draftFor,
  onDraft,
  savingId,
  updatingId,
  revealed,
  onToggleReveal,
  onUpdate,
  onUpdateAll,
  onClear,
  onSave,
}: {
  cards: ProviderCard[];
  selectedId: ProviderCardId;
  onSelect: (id: ProviderCardId) => void;
  statusFor: (card: ProviderCard) => { saved: boolean; env: boolean } | null;
  cliFor: (card: ProviderCard) => CliRow | null;
  draftFor: (card: ProviderCard) => string;
  onDraft: (card: ProviderCard, value: string) => void;
  savingId: ProviderCardId | null;
  updatingId: ProviderCardId | "all" | null;
  revealed: boolean;
  onToggleReveal: () => void;
  onUpdate: (card: ProviderCard) => void;
  onUpdateAll: () => void;
  onClear: (card: ProviderCard) => void;
  onSave: (card: ProviderCard) => void;
}) {
  const selected = cards.find((card) => card.id === selectedId) ?? cards[0];
  const due = cards.filter((card) => cliCanUpdate(cliFor(card))).length;
  const updatingAll = updatingId === "all";
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="m-0 text-[15px] font-semibold">Providers</h2>
          <p className="mt-1 mb-0 text-[12px] leading-relaxed text-muted">
            A saved key is used first, then the signed-in CLI.
          </p>
        </div>
        <button
          type="button"
          disabled={due === 0 || updatingId != null}
          title={due === 0 ? "Every CLI is current" : `Update ${due} ${due === 1 ? "CLI" : "CLIs"}`}
          onClick={onUpdateAll}
          className="shrink-0 text-[12px] text-muted hover:text-ink disabled:cursor-default disabled:opacity-40 disabled:hover:text-muted"
        >
          {updatingAll ? "Updating…" : "Update all"}
        </button>
      </div>
      <div className="grid gap-x-4 gap-y-4 md:grid-cols-[minmax(168px,190px)_minmax(0,1fr)]">
        <div className="grid content-start gap-1 px-1">
          {cards.map((card) => {
            const cli = cliFor(card);
            const status = statusFor(card);
            const on = card.id === selected.id;
            const version = cli?.installed ? cli.version : null;
            return (
              <button
                key={card.id}
                type="button"
                aria-pressed={on}
                onClick={() => onSelect(card.id)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${
                  on ? "bg-wash-strong" : "hover:bg-wash"
                }`}
              >
                <span className={`flex size-6 shrink-0 items-center justify-center rounded-md ${card.markClass}`}>
                  <Symbol name={card.logo} colored className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate text-[13px] font-medium text-ink">{card.title}</span>
                    {version ? <span className="shrink-0 font-mono text-[10px] text-muted">{version}</span> : null}
                    {cliCanUpdate(cli) ? (
                      <Symbol name="arrow.up" className="size-2.5 shrink-0 self-center text-ok" />
                    ) : null}
                  </span>
                  <span className="block truncate text-[11px] text-muted">
                    {providerStatusLine(cli, status)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {selected ? (
          <ProviderDetail
            card={selected}
            cli={cliFor(selected)}
            status={statusFor(selected)}
            draft={draftFor(selected)}
            onDraft={(value) => onDraft(selected, value)}
            saving={savingId === selected.id}
            updating={updatingId === selected.id || updatingAll}
            revealed={revealed}
            onToggleReveal={onToggleReveal}
            onUpdate={() => onUpdate(selected)}
            onClear={() => onClear(selected)}
            onSave={() => onSave(selected)}
          />
        ) : null}
      </div>
    </div>
  );
}

function ProviderDetail({
  card,
  cli,
  status,
  draft,
  onDraft,
  saving,
  updating,
  revealed,
  onToggleReveal,
  onUpdate,
  onClear,
  onSave,
}: {
  card: ProviderCard;
  cli: CliRow | null;
  status: { saved: boolean; env: boolean } | null;
  draft: string;
  onDraft: (value: string) => void;
  saving: boolean;
  updating: boolean;
  revealed: boolean;
  onToggleReveal: () => void;
  onUpdate: () => void;
  onClear: () => void;
  onSave: () => void;
}) {
  const canUpdate = cliCanUpdate(cli);
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2">
        <span className={`flex size-6 shrink-0 items-center justify-center rounded-md ${card.markClass}`}>
          <Symbol name={card.logo} colored className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-[13px] font-semibold text-ink">{card.title}</h3>
          <p className="m-0 truncate text-[11px] text-muted">{providerStatusLine(cli, status)}</p>
        </div>
        {canUpdate ? (
          <button
            type="button"
            disabled={updating}
            title={`Install ${cli?.update}`}
            onClick={onUpdate}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-ok/15 px-2 py-0.5 text-[11px] font-medium text-ok hover:bg-ok/25 disabled:opacity-60"
          >
            <Symbol name="arrow.up" className={`size-2.5 ${updating ? "animate-pulse" : ""}`} />
            {updating ? "Updating…" : cli?.update}
          </button>
        ) : null}
      </div>
      <div className="grid gap-2.5">
        <Fact
          label="CLI"
          value={cli ? (cli.installed ? cli.version || "Installed" : "Not found") : "Checking…"}
          tone={cli?.installed ? "ok" : cli ? "err" : "muted"}
        />
        <Fact
          label="Path"
          value={cli?.installed && cli.path ? cli.path : "Not found"}
          mono
          title={cli?.path}
        />
        <Fact
          label="Login"
          value={
            !cli
              ? "Checking…"
              : cli.logged_in
                ? cli.email
                  ? maskEmail(cli.email, revealed)
                  : "Signed in"
                : "Not signed in"
          }
          tone={cli?.logged_in ? "ok" : cli ? "err" : "muted"}
          action={
            cli?.email ? (
              <button
                type="button"
                aria-label={revealed ? "Hide email" : "Show email"}
                onClick={onToggleReveal}
                className="flex size-5 items-center justify-center rounded text-muted hover:bg-wash hover:text-ink"
              >
                <Symbol name={revealed ? "eye.slash" : "eye"} className="size-3.5" />
              </button>
            ) : null
          }
        />
      </div>
      <KeyField
        label={card.keyLabel}
        value={draft}
        onChange={onDraft}
        placeholder={status?.saved ? "Key saved — paste to replace" : card.placeholder}
        status={status}
        envName={card.envName}
        saving={saving}
        onClear={onClear}
        onSave={onSave}
      />
    </div>
  );
}

/** A value the app reads. Not an input, so it has no field chrome. */
function Fact({
  label,
  value,
  mono,
  title,
  tone = "ink",
  action,
}: {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
  tone?: "ok" | "err" | "muted" | "ink";
  action?: ReactNode;
}) {
  const color = tone === "ok" ? "text-ok" : tone === "err" ? "text-err" : tone === "muted" ? "text-muted" : "text-ink";
  return (
    <div className="grid grid-cols-[52px_minmax(0,1fr)] items-center gap-3">
      <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">{label}</span>
      <span className="flex min-w-0 items-center gap-1">
        <span title={title ?? value} className={`min-w-0 truncate text-[12px] ${mono ? "font-mono" : ""} ${color}`}>
          {value}
        </span>
        {action}
      </span>
    </div>
  );
}

function KeyField({
  label,
  value,
  onChange,
  placeholder,
  status,
  envName,
  saving,
  onSave,
  onClear,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  status: { saved: boolean; env: boolean } | null;
  envName: string;
  saving: boolean;
  onSave: () => void;
  onClear: () => void;
}) {
  const note = status?.saved
    ? "Using the saved key."
    : status?.env
      ? `Using ${envName} from the environment.`
      : "No key saved here.";
  const tone = status?.saved || status?.env ? "text-ok" : "text-muted";
  return (
    <div className="grid gap-2">
      <label className="grid gap-1">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">
          <Symbol name="key" className="size-3" />
          {label}
        </span>
        <input
          type="password"
          value={value}
          autoComplete="off"
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 rounded-md border border-line bg-canvas px-2.5 text-[13px] outline-none focus:border-accent"
        />
      </label>
      <div className="flex items-center justify-between gap-2">
        <p className={`m-0 flex items-center gap-1.5 text-[12px] ${tone}`}>
          <Symbol name={status?.saved || status?.env ? "lock.fill" : "lock"} className="size-3" />
          {note}
        </p>
        <div className="flex shrink-0 gap-2">
          {status?.saved ? (
            <Button disabled={saving} onClick={onClear}>
              Clear
            </Button>
          ) : null}
          <Button variant="primary" disabled={saving || !value.trim()} onClick={onSave}>
            {saving ? "Saving…" : "Save key"}
          </Button>
        </div>
      </div>
    </div>
  );
}

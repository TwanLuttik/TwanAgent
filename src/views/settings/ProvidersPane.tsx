import { Button } from "../../components/Button";
import { Symbol } from "../../components/Symbol";
import { maskEmail } from "../../lib/mask";
import * as api from "../../lib/tauri";
import { Block, fieldClass, Group, Line, Page } from "./SettingsChrome";

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
    <Page
      title="Providers"
      text="A saved key is used first, then the signed-in CLI."
      action={
        <Button
          size="sm"
          disabled={due === 0 || updatingId != null}
          title={due === 0 ? "Every CLI is current" : `Update ${due} ${due === 1 ? "CLI" : "CLIs"}`}
          onClick={onUpdateAll}
        >
          {updatingAll ? "Updating…" : "Update all"}
        </Button>
      }
    >
      <div className="grid grid-cols-3 gap-2">
        {cards.map((card) => {
          const cli = cliFor(card);
          const status = statusFor(card);
          const on = card.id === selected.id;
          return (
            <button
              key={card.id}
              type="button"
              aria-pressed={on}
              onClick={() => onSelect(card.id)}
              className={`flex min-w-0 items-center gap-2 rounded-xl border px-2.5 py-2 text-left ${
                on ? "border-accent bg-wash" : "border-line/60 bg-panel hover:bg-wash"
              }`}
            >
              <span className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${card.markClass}`}>
                <Symbol name={card.logo} colored className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1">
                  <span className="truncate text-[13px] font-medium text-ink">{card.title}</span>
                  {cliCanUpdate(cli) ? <Symbol name="arrow.up" className="size-2.5 shrink-0 text-ok" /> : null}
                </span>
                <span className="block truncate text-[11px] text-muted">{providerStatusLine(cli, status)}</span>
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
    </Page>
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
  const login = !cli
    ? "Checking…"
    : cli.logged_in
      ? cli.email
        ? maskEmail(cli.email, revealed)
        : "Signed in"
      : "Not signed in";
  return (
    <>
      <Group
        title="Connection"
        text={card.text}
        action={
          canUpdate ? (
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
          ) : null
        }
      >
        <Line
          label="CLI"
          value={cli ? (cli.installed ? cli.version || "Installed" : "Not found") : "Checking…"}
          tone={cli?.installed ? "ok" : cli ? "err" : "muted"}
        />
        <Line
          label="Path"
          value={cli?.installed && cli.path ? cli.path : "Not found"}
          mono
          tone={cli?.installed ? undefined : "muted"}
          title={cli?.path}
        />
        <Line
          label="Login"
          value={login}
          tone={cli?.logged_in ? "ok" : cli ? "err" : "muted"}
          title={cli?.email ?? login}
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
      </Group>
      <Group title="API key" text={card.keyLabel}>
        <Block>
          <KeyField
            value={draft}
            onChange={onDraft}
            placeholder={status?.saved ? "Key saved — paste to replace" : card.placeholder}
            status={status}
            envName={card.envName}
            saving={saving}
            onClear={onClear}
            onSave={onSave}
          />
        </Block>
      </Group>
    </>
  );
}

function KeyField({
  value,
  onChange,
  placeholder,
  status,
  envName,
  saving,
  onSave,
  onClear,
}: {
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
      <input
        type="password"
        value={value}
        autoComplete="off"
        aria-label="API key"
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={fieldClass}
      />
      <div className="flex items-center justify-between gap-2">
        <p className={`m-0 flex items-center gap-1.5 text-[12px] ${tone}`}>
          <Symbol name={status?.saved || status?.env ? "lock.fill" : "lock"} className="size-3" />
          {note}
        </p>
        <div className="flex shrink-0 gap-2">
          {status?.saved ? (
            <Button size="sm" disabled={saving} onClick={onClear}>
              Clear
            </Button>
          ) : null}
          <Button size="sm" variant="primary" disabled={saving || !value.trim()} onClick={onSave}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { contextWindowLabel } from "../../lib/context";
import { groupModelFamilies, modelFamilyName, sharedModelCapabilities } from "../../lib/model-family";
import { providerProfile, type ProviderId } from "../../lib/provider";
import type { Model } from "../../lib/tauri";
import { Symbol } from "../Symbol";
import { MODEL_MENU_EASE } from "./menuEase";

const MODEL_PROVIDERS: { id: ProviderId; label: string; icon: string }[] = [
  { id: "xai", label: "Grok", icon: "logo.grok" },
  { id: "anthropic", label: "Claude", icon: "logo.claude" },
  { id: "minimax", label: "MiniMax", icon: "logo.minimax" },
];

// Same order as the provider rail, so a click scrolls downward through the list.
const PROVIDER_ORDER: ProviderId[] = ["xai", "anthropic", "minimax"];

export function orderModels(models: Model[]): Model[] {
  return [...models].sort((a, b) => {
    const left = PROVIDER_ORDER.indexOf(modelProvider(a));
    const right = PROVIDER_ORDER.indexOf(modelProvider(b));
    return (left < 0 ? PROVIDER_ORDER.length : left) - (right < 0 ? PROVIDER_ORDER.length : right);
  });
}

function filterModels(models: Model[], query: string): Model[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return models;
  return models.filter((model) => {
    const family = modelFamilyName(model.name).family.toLowerCase();
    return (
      model.name.toLowerCase().includes(needle) ||
      model.id.toLowerCase().includes(needle) ||
      family.includes(needle)
    );
  });
}

function modelLocked(model: Model, providers: string[] | null): boolean {
  if (!providers) return false;
  return !providers.includes(modelProvider(model));
}

function modelProvider(model: Model): ProviderId {
  if (model.provider === "anthropic" || model.provider === "xai" || model.provider === "minimax") return model.provider;
  return providerProfile(model.id).id;
}

function providerIconClass(id: ProviderId, on: boolean): string {
  if (!on) return "text-muted hover:bg-wash hover:text-ink";
  if (id === "anthropic") return "bg-wash-strong text-[#d97757]";
  if (id === "minimax") return "bg-wash-strong text-[#e21680]";
  return "bg-wash-strong text-ink";
}

function isProviderId(value: string | undefined): value is ProviderId {
  return value === "xai" || value === "anthropic" || value === "minimax";
}

function providerSections(models: Model[]) {
  const buckets = new Map<ProviderId, Model[]>();
  for (const model of models) {
    const provider = modelProvider(model);
    const rows = buckets.get(provider);
    if (rows) rows.push(model);
    else buckets.set(provider, [model]);
  }
  const seen = new Set<ProviderId>();
  const sections: { provider: ProviderId; families: ReturnType<typeof groupModelFamilies<Model>> }[] = [];
  const push = (provider: ProviderId) => {
    const rows = buckets.get(provider);
    if (!rows?.length || seen.has(provider)) return;
    seen.add(provider);
    sections.push({ provider, families: groupModelFamilies(rows) });
  };
  for (const provider of PROVIDER_ORDER) push(provider);
  for (const provider of buckets.keys()) push(provider);
  return sections;
}

function scrollModelListTo(list: HTMLElement, target: HTMLElement, behavior: ScrollBehavior = "auto") {
  const top = Math.max(0, list.scrollTop + target.getBoundingClientRect().top - list.getBoundingClientRect().top);
  const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  list.scrollTo({ top, behavior: reduce ? "auto" : behavior });
}

/** Keep a family's heading with its first row. Later versions scroll to the row itself. */
function modelListAnchor(row: HTMLElement): HTMLElement {
  const family = row.closest<HTMLElement>("[data-family]");
  if (!family) return row;
  return family.querySelector("button") === row ? family : row;
}

function providerAtListTop(list: HTMLElement): ProviderId | null {
  const rows = list.querySelectorAll<HTMLElement>("[data-provider-section]");
  if (!rows.length) return null;
  const edge = list.getBoundingClientRect().top + 8;
  let current: ProviderId | null = null;
  for (const row of rows) {
    const provider = row.dataset.providerSection;
    if (!isProviderId(provider)) continue;
    if (row.getBoundingClientRect().top <= edge) current = provider;
    else if (!current) return provider;
    else break;
  }
  return current;
}

function ModelProviderRail({
  providers,
  lockedProviders,
  selectedProvider,
  listRef,
  listToken,
  onJump,
}: {
  providers: { id: ProviderId; label: string; icon: string }[];
  lockedProviders: string[] | null;
  selectedProvider: ProviderId | null;
  listRef: RefObject<HTMLDivElement | null>;
  listToken: string;
  onJump: (id: ProviderId) => boolean;
}) {
  const [active, setActive] = useState<ProviderId | null>(selectedProvider);
  const [providerTip, setProviderTip] = useState<{ label: string; top: number; left: number } | null>(null);
  const holdScroll = useRef(false);
  const finishScroll = useRef<(() => void) | null>(null);
  const scrollTimer = useRef(0);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const read = () => {
      if (holdScroll.current) return;
      const next = providerAtListTop(list);
      setActive((current) => (current === next ? current : next));
    };
    const release = () => {
      holdScroll.current = false;
      window.clearTimeout(scrollTimer.current);
      if (finishScroll.current) list.removeEventListener("scrollend", finishScroll.current);
      finishScroll.current = null;
    };
    read();
    list.addEventListener("scroll", read, { passive: true });
    list.addEventListener("wheel", release, { passive: true });
    list.addEventListener("touchmove", release, { passive: true });
    return () => {
      release();
      list.removeEventListener("scroll", read);
      list.removeEventListener("wheel", release);
      list.removeEventListener("touchmove", release);
    };
  }, [listRef, listToken]);

  return (
    <div className="flex w-9 max-w-9 min-w-9 shrink-0 flex-col gap-0.5 overflow-hidden border-r border-line/20 bg-panel/40 p-1" role="group" aria-label="Model providers">
      {providers.map((row) => {
        const on = active === row.id;
        const locked = lockedProviders != null && !lockedProviders.includes(row.id);
        return (
          <button
            key={row.id}
            type="button"
            aria-pressed={on}
            aria-label={locked ? `${row.label}, no key on this server` : row.label}
            title={locked ? "This server does not have this provider key" : undefined}
            onClick={() => {
              const list = listRef.current;
              if (!list) return;
              // Hold the scroll spy before the smooth scroll starts, or the first
              // scroll event snaps the highlight back to the section that is leaving.
              holdScroll.current = true;
              if (!onJump(row.id)) {
                holdScroll.current = false;
                return;
              }
              setActive(row.id);
              window.clearTimeout(scrollTimer.current);
              if (finishScroll.current) list.removeEventListener("scrollend", finishScroll.current);
              const finish = () => {
                if (finishScroll.current !== finish) return;
                finishScroll.current = null;
                holdScroll.current = false;
                window.clearTimeout(scrollTimer.current);
                list.removeEventListener("scrollend", finish);
                const next = providerAtListTop(list);
                setActive((current) => (current === next ? current : next));
              };
              finishScroll.current = finish;
              list.addEventListener("scrollend", finish);
              scrollTimer.current = window.setTimeout(finish, 1000);
            }}
            onMouseEnter={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              setProviderTip({ label: row.label, top: box.top + box.height / 2, left: box.right + 8 });
            }}
            onMouseLeave={() => setProviderTip(null)}
            data-colored={on || undefined}
            className={`group/minimax flex h-7 w-full shrink-0 items-center justify-center rounded-md transition-colors duration-150 ${
              locked && !on ? "cursor-pointer text-muted/35 hover:bg-wash" : `cursor-pointer ${providerIconClass(row.id, on)}`
            }`}
          >
            <Symbol name={row.icon} className="size-3.5" />
          </button>
        );
      })}
      {createPortal(
        <AnimatePresence>
          {providerTip ? (
            <motion.span
              key={providerTip.label}
              role="tooltip"
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -4 }}
              transition={{ duration: 0.16, ease: MODEL_MENU_EASE }}
              style={{ top: providerTip.top, left: providerTip.left }}
              className="pointer-events-none fixed z-50 -translate-y-1/2 rounded-md border border-line bg-canvas px-2 py-1 text-[12px] font-medium text-ink shadow-card"
            >
              {providerTip.label}
            </motion.span>
          ) : null}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}

export function ModelSelect({
  models,
  value,
  onChange,
  lockedProviders = null,
}: {
  models: Model[];
  value: string;
  onChange: (id: string) => void;
  lockedProviders?: string[] | null;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const [menuAbove, setMenuAbove] = useState(true);
  const selected = models.find((row) => row.id === value);
  const providers = MODEL_PROVIDERS.filter((row) => models.some((model) => modelProvider(model) === row.id));
  const needle = query.trim();
  const shown = filterModels(models, needle);
  const sections = providerSections(shown);
  const listToken = shown.map((row) => row.id).join("\n");
  const selectedProvider = selected ? modelProvider(selected) : null;

  useLayoutEffect(() => {
    if (!open) return;
    const frame = button.current?.getBoundingClientRect();
    if (!frame) return;
    setMenuAbove(frame.top - 320 - 6 >= 8);
  }, [open]);

  // Open on the selected row. The rail only scrolls; it does not filter the list.
  useLayoutEffect(() => {
    const justOpened = open && !wasOpen.current;
    wasOpen.current = open;
    if (!justOpened) return;
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(`[data-model-id="${CSS.escape(value)}"]`);
    if (!row) return;
    scrollModelListTo(list, modelListAnchor(row));
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    function onDoc(ev: MouseEvent) {
      if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false);
    }
    function onKey(ev: globalThis.KeyboardEvent) {
      if (ev.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    const focusSearch = window.setTimeout(() => search.current?.focus(), 0);
    return () => {
      window.clearTimeout(focusSearch);
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        ref={button}
        type="button"
        title="Model"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => {
            if (!current) setQuery("");
            return !current;
          });
        }}
        className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] hover:bg-wash ${
          open ? "bg-wash text-ink" : "text-muted hover:text-ink"
        }`}
      >
        {selected ? <ModelIcon model={selected} className="size-3" /> : null}
        <span className="max-w-[132px] truncate">{selected?.name ?? "Model"}</span>
        <Symbol name="chevron.down" className="size-2.5 opacity-70" />
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: menuAbove ? 6 : -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: menuAbove ? 6 : -6 }}
            transition={{ duration: 0.16, ease: MODEL_MENU_EASE }}
            className={`no-scrollbar absolute left-0 z-30 flex h-80 w-[420px] overflow-hidden rounded-lg border border-line/25 bg-canvas shadow-card ${
              menuAbove ? "bottom-full mb-1 origin-bottom" : "top-full mt-1 origin-top"
            }`}
          >
            <ModelProviderRail
              providers={providers}
              lockedProviders={lockedProviders}
              selectedProvider={selectedProvider}
              listRef={listRef}
              listToken={listToken}
              onJump={(provider) => {
                const list = listRef.current;
                if (!list) return false;
                const selectedRow =
                  provider === selectedProvider
                    ? list.querySelector<HTMLElement>(`[data-model-id="${CSS.escape(value)}"]`)
                    : null;
                const target = selectedRow
                  ? modelListAnchor(selectedRow)
                  : list.querySelector<HTMLElement>(`[data-provider-section="${provider}"]`);
                if (!target) return false;
                scrollModelListTo(list, target, "smooth");
                return true;
              }}
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center gap-2 border-b border-line/20 px-2.5">
                <Symbol name="magnifyingglass" className="size-3.5 shrink-0 text-muted" />
                <input
                  ref={search}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    const first = shown.find((row) => !modelLocked(row, lockedProviders));
                    if (!first) return;
                    onChange(first.id);
                    setOpen(false);
                  }}
                  placeholder="Search models"
                  aria-label="Search models"
                  className="h-9 min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-muted"
                />
              </div>
              <div ref={listRef} className="model-menu-list min-h-0 flex-1 overflow-x-hidden overflow-y-scroll py-1 [overflow-anchor:none]">
              {sections.length ? (
                sections.map((section) => (
                  <div key={section.provider} data-provider-section={section.provider}>
                    {section.families.map((family) => {
                      const versions = family.models.length > 1;
                      const shared = sharedModelCapabilities(family.models);
                      return (
                        <div key={family.key} data-family={family.key} role="group" aria-label={family.label} className="py-0.5">
                          {versions ? (
                            <div className="flex items-center gap-2 px-2.5 pt-1.5 pb-0.5 text-[11px] font-medium text-muted">
                              <span className="min-w-0 flex-1 truncate">{family.label}</span>
                              {shared ? <CapabilityIcons ids={shared} /> : null}
                            </div>
                          ) : null}
                          {family.models.map((row) => {
                            const current = row.id === value;
                            const locked = modelLocked(row, lockedProviders);
                            const context = contextWindowLabel(row.context_window ?? 0);
                            const label = versions ? modelFamilyName(row.name).version || row.name : row.name;
                            return (
                              <button
                                key={row.id}
                                type="button"
                                role="menuitemradio"
                                data-model-id={row.id}
                                data-provider={section.provider}
                                aria-checked={current}
                                aria-disabled={locked}
                                aria-label={row.name}
                                disabled={locked}
                                title={locked ? "This server does not have this provider key" : undefined}
                                onClick={() => {
                                  if (locked) return;
                                  onChange(row.id);
                                  setOpen(false);
                                }}
                                className={`flex h-7 w-full items-center gap-2 text-left text-[12px] transition-colors duration-150 ${
                                  versions ? "pr-2.5 pl-6" : "px-2.5"
                                } ${
                                  locked
                                    ? "cursor-not-allowed text-muted/45"
                                    : `cursor-pointer hover:bg-wash ${current ? "font-medium text-ink" : "text-ink/80"}`
                                }`}
                              >
                                <ModelIcon model={row} className="size-3.5" />
                                <span className="min-w-0 flex-1 truncate">{label}</span>
                                {context ? (
                                  <span className="shrink-0 text-[11px] font-normal text-muted tabular-nums" title={`${context} context window`}>
                                    {context} ctx
                                  </span>
                                ) : null}
                                <CapabilityIcons ids={row.capabilities} faded={Boolean(shared)} />
                                <Symbol
                                  name="checkmark"
                                  className={`size-3 shrink-0 text-accent transition-opacity duration-150 ${current ? "opacity-100" : "opacity-0"}`}
                                />
                              </button>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                ))
              ) : (
                <p className="px-2.5 py-2 text-[12px] text-muted">
                  {needle ? "No matching models" : "No models"}
                </p>
              )}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

const CAPABILITIES: { id: string; icon: string; label: string; detail: string; className: string }[] = [
  { id: "vision", icon: "photo", label: "Images", detail: "Accepts image input.", className: "text-ok" },
  { id: "pdf", icon: "doc", label: "PDFs", detail: "Reads PDF documents.", className: "text-[#d97757]" },
  { id: "thinking", icon: "brain", label: "Thinking", detail: "Can think before it answers.", className: "text-accent" },
  { id: "effort", icon: "sparkles", label: "Effort", detail: "Effort steers how thoroughly it works.", className: "text-warn" },
];

function CapabilityIcons({ ids, faded = false }: { ids?: string[] | null; faded?: boolean }) {
  const known = new Set(ids ?? []);
  const shown = CAPABILITIES.filter((row) => known.has(row.id));
  const [tip, setTip] = useState<{ label: string; detail: string; className: string; icon: string; top: number; left: number } | null>(null);
  if (!shown.length) return null;
  return (
    <span className={`flex shrink-0 items-center gap-1 ${faded ? "opacity-40" : ""}`}>
      {shown.map((row) => (
        <span
          key={row.id}
          aria-label={row.label}
          className={row.className}
          onMouseEnter={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            setTip({
              label: row.label,
              detail: row.detail,
              className: row.className,
              icon: row.icon,
              top: box.top - 8,
              left: Math.min(Math.max(8, box.left - 40), window.innerWidth - 188),
            });
          }}
          onMouseLeave={() => setTip(null)}
        >
          <Symbol name={row.icon} className="size-3" />
        </span>
      ))}
      {createPortal(
        <AnimatePresence>
          {tip ? (
            <motion.span
              key={`${tip.label}-${tip.left}-${tip.top}`}
              role="tooltip"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.16, ease: MODEL_MENU_EASE }}
              style={{ top: tip.top, left: tip.left }}
              className="pointer-events-none fixed z-50 w-[180px] -translate-y-full rounded-lg border border-line bg-canvas px-2.5 py-2 text-left shadow-card"
            >
              <span className="flex items-center gap-1.5">
                <Symbol name={tip.icon} className={`size-3.5 ${tip.className}`} />
                <span className="text-[12px] font-medium text-ink">{tip.label}</span>
              </span>
              <span className="mt-0.5 block text-[11px] leading-snug font-normal text-muted">{tip.detail}</span>
            </motion.span>
          ) : null}
        </AnimatePresence>,
        document.body,
      )}
    </span>
  );
}

function ModelIcon({ model, className }: { model: Model; className?: string }) {
  const id = modelProvider(model);
  const symbol = id === "anthropic" ? "logo.claude" : id === "minimax" ? "logo.minimax" : "logo.grok";
  const color = id === "anthropic" ? "text-[#d97757]" : id === "minimax" ? "text-[#e21680]" : "text-current";
  return <Symbol name={symbol} colored className={`${className ?? "size-3.5"} shrink-0 ${color}`} />;
}

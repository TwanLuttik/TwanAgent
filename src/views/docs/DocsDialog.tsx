import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "motion/react";
import { Button } from "../../components/Button";
import { Symbol } from "../../components/Symbol";
import { useApp } from "../../state/app-state";
import { useMain } from "../main/context";
import { Group, Page } from "../settings/SettingsChrome";

const EASE = [0.22, 1, 0.36, 1] as const;

type DocTab = "server";

const DOC_TABS: { id: DocTab; label: string; hint: string; icon: string; group: string }[] = [
  { id: "server", label: "Server", hint: "Build a version and check it", icon: "server.rack", group: "Guides" },
];

/**
 * Docs stays mounted after the first open, same as Settings. Closing only
 * plays the transition, so the page is still there the next time.
 */
export function DocsDialog() {
  const { closeDocs, folderOpen, showDocs } = useMain();
  const [alive, setAlive] = useState(showDocs);
  const [tab, setTab] = useState<DocTab>("server");
  const panelRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  if (showDocs && !alive) setAlive(true);
  useEffect(() => {
    if (!showDocs) return;
    panelRef.current?.focus();
  }, [showDocs, alive]);
  useEffect(() => {
    if (!showDocs) return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      closeDocs();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showDocs, closeDocs]);
  if (!alive) return null;

  const close = folderOpen || !showDocs ? undefined : closeDocs;
  const duration = reduceMotion ? 0 : 0.2;

  return createPortal(
    <motion.div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45"
      initial={{ opacity: 0 }}
      animate={{ opacity: showDocs ? 1 : 0 }}
      transition={{ duration, ease: EASE }}
      style={{ pointerEvents: showDocs ? "auto" : "none" }}
      inert={!showDocs}
      onMouseDown={() => close?.()}
    >
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal={showDocs}
        aria-hidden={!showDocs}
        aria-label="Docs"
        tabIndex={-1}
        className="relative flex h-[70%] w-[70%] min-h-0 min-w-0 overflow-hidden rounded-xl border border-line bg-canvas shadow-card outline-none"
        initial={reduceMotion ? false : { y: 10, scale: 0.98 }}
        animate={showDocs ? { y: 0, scale: 1 } : { y: 8, scale: 0.98 }}
        transition={{ duration, ease: EASE }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <DocsNav tab={tab} onTab={setTab} />
        <button
          type="button"
          aria-label="Close docs"
          title="Close"
          onClick={() => close?.()}
          className="absolute top-2 right-2 z-10 flex size-7 items-center justify-center rounded-[6px] text-muted hover:bg-wash hover:text-ink"
        >
          <Symbol name="xmark" className="size-3.5" />
        </button>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-auto py-6 pr-12 pl-8">
            <div className="grid w-full max-w-[960px] gap-5">
              {tab === "server" ? <ServerDoc /> : null}
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}

function DocsNav({ tab, onTab }: { tab: DocTab; onTab: (id: DocTab) => void }) {
  return (
    <nav className="flex w-52 shrink-0 flex-col overflow-auto border-r border-line/55 bg-sidebar px-2 py-3" aria-label="Docs">
      {DOC_TABS.map((opt, index) => {
        const on = tab === opt.id;
        const groupStart = index === 0 || DOC_TABS[index - 1]?.group !== opt.group;
        return (
          <div key={opt.id} className={groupStart && index > 0 ? "mt-2" : undefined}>
            {groupStart ? (
              <div className="px-2 pt-1.5 pb-1 text-[10px] font-semibold tracking-[0.08em] text-muted uppercase">
                {opt.group}
              </div>
            ) : null}
            <button
              type="button"
              aria-current={on ? "page" : undefined}
              title={opt.hint}
              onClick={() => onTab(opt.id)}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] ${
                on ? "bg-wash-strong text-ink" : "text-ink/85 hover:bg-wash"
              }`}
            >
              <Symbol name={opt.icon} className={`size-4 shrink-0 ${on ? "text-ink" : "text-muted"}`} />
              <span className="min-w-0 truncate">{opt.label}</span>
            </button>
          </div>
        );
      })}
    </nav>
  );
}

function ServerDoc() {
  return (
    <Page
      title="Server"
      text="The program on a server is separate from this app. Build a new one here, then send it from the Servers screen."
    >
      <Group title="Build a version" text="Open Terminal in the TwanAgent folder and run the command that matches the machine.">
        <Command
          label="This Mac"
          text="Use this when the server is a Mac."
          command="scripts/build-server.sh"
        />
        <Command
          label="Linux"
          text="Use this when the server is Linux. Most machines you add from this Mac use this."
          command="scripts/build-server.sh linux"
        />
        <Command
          label="Linux, Intel or AMD"
          text="Use this when that Linux machine has an Intel or AMD chip. A Mac build will not run on it."
          command="scripts/build-server.sh linux-x64"
        />
        <p className="m-0 px-3.5 py-2.5 text-[12px] leading-relaxed text-muted">
          The first Linux build may ask you to install a helper. Run the command Terminal prints, then try again.
        </p>
      </Group>
      <Group title="Check a version" text="This prints the version that machine is running.">
        <Command
          label="On the server"
          text="Sign in to the machine and run this."
          command="~/.twanagent/bin/twanagent-server --version"
        />
        <Command
          label="From this Mac"
          text="Run this from this Mac. Replace you@the-server with the login you already use."
          command="ssh you@the-server ~/.twanagent/bin/twanagent-server --version"
        />
      </Group>
      <Group title="Send it">
        <p className="m-0 px-3.5 py-3 text-[13px] leading-relaxed text-ink">
          When the build finishes, open Servers, choose the machine, and press Update. That copies the program you just built. If that version is already on the server, Update has nothing new to send.
        </p>
      </Group>
    </Page>
  );
}

function Command({ label, text, command }: { label: string; text: string; command: string }) {
  const { setFlash } = useApp();
  const [copied, setCopied] = useState(false);
  return (
    <div className="px-3.5 py-3">
      <div className="text-[13px] font-medium text-ink">{label}</div>
      <p className="mt-0.5 mb-2 text-[12px] leading-relaxed text-muted">{text}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-inset px-2.5 py-1.5 font-mono text-[12px] text-ink">
          {command}
        </code>
        <Button
          size="sm"
          className="shrink-0"
          onClick={() => {
            void navigator.clipboard.writeText(command).then(
              () => {
                setCopied(true);
                setFlash({ kind: "ok", text: "Copied." });
                window.setTimeout(() => setCopied(false), 1500);
              },
              () => setFlash({ kind: "err", text: "Could not copy that. Select the command and copy it." }),
            );
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

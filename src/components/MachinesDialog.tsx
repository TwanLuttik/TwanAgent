import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Button } from "./Button";
import { Symbol } from "./Symbol";
import * as api from "../lib/tauri";
import type { HostPrompt, LanHost, Machine } from "../lib/tauri";

type Step = "scan" | "connect" | "trust" | "project";

export function MachinesDialog({
  onClose,
  onOpenProject,
}: {
  onClose: () => void;
  onOpenProject: (path: string) => void;
}) {
  const [step, setStep] = useState<Step>("scan");
  const [saved, setSaved] = useState<Machine[]>([]);
  const [hosts, setHosts] = useState<LanHost[]>([]);
  const [scanning, setScanning] = useState(true);
  const [picked, setPicked] = useState<LanHost | null>(null);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState<string | null>(null);
  const [machine, setMachine] = useState<Machine | null>(null);
  const [prompt, setPrompt] = useState<HostPrompt | null>(null);
  const [projectName, setProjectName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState("");

  useEffect(() => {
    let gone = false;
    void api
      .listMachines()
      .then((rows) => {
        if (!gone) setSaved(rows);
      })
      .catch(() => undefined);
    void api
      .sshDefaults()
      .then((defaults) => {
        if (gone) return;
        setUser(defaults.user);
        setKeyPath(defaults.key_path ?? null);
      })
      .catch(() => undefined);
    let unlisten: (() => void) | undefined;
    void api.onSshFound((host) => {
      if (gone) return;
      setHosts((rows) => (rows.some((row) => row.host === host.host) ? rows : [...rows, host]));
    }).then((stop) => {
      if (gone) stop();
      else unlisten = stop;
    });
    void api
      .discoverSsh()
      .then((rows) => {
        if (gone) return;
        setHosts((current) => {
          const seen = new Set(current.map((row) => row.host));
          return [...current, ...rows.filter((row) => !seen.has(row.host))];
        });
        setScanning(false);
      })
      .catch((e) => {
        if (!gone) {
          setError(String(e));
          setScanning(false);
        }
      });
    return () => {
      gone = true;
      unlisten?.();
    };
  }, []);

  function useSaved(row: Machine) {
    setMachine(row);
    setError(null);
    setProjectName("");
    setStep("project");
  }

  async function forget(row: Machine) {
    setBusy(true);
    setError(null);
    try {
      await api.deleteMachine(row.id);
      setSaved((rows) => rows.filter((item) => item.id !== row.id));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function choose(host: LanHost) {
    setPicked(host);
    setError(null);
    setStep("connect");
  }

  async function connect() {
    if (!picked || !user.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveMachine({
        name: picked.label,
        user: user.trim(),
        host: picked.host,
        port: picked.port,
        auth: password.trim() ? "password" : keyPath ? "private_key" : "agent",
        keyPath: password.trim() ? undefined : keyPath || undefined,
        secret: password.trim() || undefined,
      });
      setMachine(saved);
      setSaved((rows) => [saved, ...rows.filter((row) => row.id !== saved.id)]);
      const tested = await api.testMachine(saved.id);
      if (tested.host_prompt) {
        setPrompt(tested.host_prompt);
        setStep("trust");
      } else if (tested.ok) {
        setStep("project");
      } else {
        setError(tested.message);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function trust() {
    if (!prompt || !machine) return;
    setBusy(true);
    setError(null);
    try {
      await api.acceptHost(prompt.machine_id, prompt.fingerprint, prompt.key_type);
      setStep("project");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openProject() {
    if (!machine || !projectName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const home = await api.remoteHome(machine.id);
      const folder = projectName.trim().replace(/^\/+|\/+$/g, "");
      const path = await api.createRemoteProject(folder, machine.id, `${home.replace(/\/$/, "")}/${folder}`);
      onOpenProject(path);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 px-4 pt-[14vh]"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget && !busy) onClose();
      }}
    >
      <motion.div
        role="dialog"
        aria-labelledby="machines-title"
        className="w-full max-w-[460px] overflow-hidden rounded-2xl border border-line bg-canvas shadow-card"
        initial={{ opacity: 0, y: 10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.18 }}
      >
        <div className="flex items-center justify-between px-4 pt-4">
          <div>
            <h2 id="machines-title" className="m-0 text-[16px] font-semibold">
              {step === "scan" ? "Servers" : step === "connect" ? "Sign in" : step === "trust" ? "Trust this server" : "New project"}
            </h2>
            <p className="mt-1 mb-0 text-[12px] text-muted">
              {step === "scan"
                ? "Saved locations stay here. Pick one to start a project."
                : step === "connect"
                  ? picked?.host
                  : step === "trust"
                    ? "First time connecting. Check the fingerprint."
                    : `${machine?.user}@${machine?.host}`}
            </p>
          </div>
          <button type="button" className="text-muted hover:text-ink" onClick={onClose} aria-label="Close">
            <Symbol name="xmark" className="size-4" />
          </button>
        </div>
        <Radar step={step} count={hosts.length} />
        <div className="px-4 pb-4">
          <AnimatePresence mode="wait">
            {step === "scan" && (
              <motion.div key="scan" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                {saved.length > 0 && (
                  <div className="mb-3 grid gap-1.5">
                    <div className="text-[11px] font-semibold tracking-wide text-muted uppercase">Saved locations</div>
                    {saved.map((row) => (
                      <div key={row.id} className="flex items-center gap-2 rounded-xl border border-line px-3 py-2">
                        <button type="button" onClick={() => useSaved(row)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                          <span className="flex size-9 items-center justify-center rounded-full bg-inset text-accent">
                            <Symbol name="desktopcomputer.fill" className="size-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium">{row.name}</span>
                            <span className="block truncate text-[12px] text-muted">
                              {row.user}@{row.host}
                            </span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="rounded-md px-2 py-1 text-[12px] text-accent hover:bg-wash"
                          disabled={busy}
                          onClick={() => useSaved(row)}
                        >
                          New project
                        </button>
                        <button
                          type="button"
                          className="text-[12px] text-muted hover:text-err"
                          disabled={busy}
                          onClick={() => void forget(row)}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {hosts.length === 0 ? (
                  <p className="m-0 py-6 text-center text-[13px] text-muted">
                    {scanning ? "Checking your SSH hosts and this network…" : "No SSH servers answered. Type an address below."}
                  </p>
                ) : (
                  <div className="grid gap-1.5">
                    {hosts.map((host, index) => (
                      <motion.button
                        key={host.host}
                        type="button"
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.05 }}
                        onClick={() => choose(host)}
                        className="flex items-center gap-3 rounded-xl border border-line px-3 py-2.5 text-left hover:bg-wash"
                      >
                        <span className="relative flex size-9 items-center justify-center rounded-full bg-inset text-accent">
                          <Symbol name="desktopcomputer" className="size-4" />
                          <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-ok" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-medium">{host.label}</span>
                          <span className="block text-[12px] text-muted">
                            {host.host === host.label ? "On this network" : host.host}
                          </span>
                        </span>
                        <Symbol name="chevron.right" className="size-4 text-muted" />
                      </motion.button>
                    ))}
                  </div>
                )}
                <form
                  className="mt-3 flex gap-2"
                  onSubmit={(ev) => {
                    ev.preventDefault();
                    const host = manual.trim();
                    if (host) choose({ host, port: 22, label: host });
                  }}
                >
                  <input
                    value={manual}
                    onChange={(e) => setManual(e.target.value)}
                    placeholder="Or type an address"
                    className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 text-[13px] outline-none focus:border-accent"
                  />
                  <Button type="submit" disabled={!manual.trim()}>
                    Use
                  </Button>
                </form>
              </motion.div>
            )}
            {step === "connect" && (
              <motion.form
                key="connect"
                className="grid gap-3"
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                onSubmit={(ev) => {
                  ev.preventDefault();
                  void connect();
                }}
              >
                <label className="grid gap-1">
                  <span className="text-[12px] text-muted">User</span>
                  <input
                    value={user}
                    onChange={(e) => setUser(e.target.value)}
                    className="h-9 rounded-lg border border-line px-3 text-[13px] outline-none focus:border-accent"
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-[12px] text-muted">
                    {keyPath ? "Password, if the key needs one" : "Password"}
                  </span>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={keyPath ? "Leave empty to use your key" : "Stored in the keychain"}
                    className="h-9 rounded-lg border border-line px-3 text-[13px] outline-none focus:border-accent"
                  />
                </label>
                <div className="flex justify-between gap-2">
                  <Button type="button" onClick={() => setStep("scan")} disabled={busy}>
                    Back
                  </Button>
                  <Button type="submit" variant="primary" disabled={busy || !user.trim()}>
                    {busy ? "Connecting…" : "Connect"}
                  </Button>
                </div>
              </motion.form>
            )}
            {step === "trust" && prompt && (
              <motion.div
                key="trust"
                className="grid gap-3"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
              >
                <div className="rounded-xl bg-inset px-3 py-3">
                  <div className="text-[12px] text-muted">{prompt.changed ? "This key changed" : "Server fingerprint"}</div>
                  <div className="mt-1 break-all font-mono text-[12px]">{prompt.fingerprint}</div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button onClick={() => setStep("connect")} disabled={busy}>
                    Back
                  </Button>
                  <Button variant="primary" disabled={busy} onClick={() => void trust()}>
                    {busy ? "Saving…" : "Trust and continue"}
                  </Button>
                </div>
              </motion.div>
            )}
            {step === "project" && (
              <motion.form
                key="project"
                className="grid gap-3"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                onSubmit={(ev) => {
                  ev.preventDefault();
                  void openProject();
                }}
              >
                <label className="grid gap-1">
                  <span className="text-[12px] text-muted">Project name on {machine?.name}</span>
                  <input
                    autoFocus
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    placeholder="billing"
                    className="h-9 rounded-lg border border-line px-3 text-[13px] outline-none focus:border-accent"
                  />
                </label>
                <p className="m-0 text-[12px] text-muted">Created in the home folder on this server.</p>
                <div className="flex justify-between gap-2">
                  <Button type="button" onClick={() => setStep("scan")} disabled={busy}>
                    Back
                  </Button>
                  <Button type="submit" variant="primary" disabled={busy || !projectName.trim()}>
                    {busy ? "Creating…" : "Create project"}
                  </Button>
                </div>
              </motion.form>
            )}
          </AnimatePresence>
          {error && <p className="mt-3 mb-0 text-[12px] text-err">{error}</p>}
        </div>
      </motion.div>
    </div>
  );
}

function Radar({ step, count }: { step: Step; count: number }) {
  return (
    <div className="relative mx-auto my-4 h-16 w-16" aria-hidden>
      <motion.span
        className="absolute inset-0 rounded-full border border-accent/30"
        animate={step === "scan" ? { scale: [0.7, 1.25], opacity: [0.7, 0] } : { scale: 1, opacity: 0.35 }}
        transition={{ duration: 1.6, repeat: step === "scan" ? Infinity : 0 }}
      />
      <motion.span
        className="absolute inset-2 rounded-full border border-accent/50"
        animate={step === "scan" ? { scale: [0.8, 1.15], opacity: [0.8, 0.1] } : { opacity: 0.5 }}
        transition={{ duration: 1.6, repeat: step === "scan" ? Infinity : 0, delay: 0.3 }}
      />
      <motion.span
        className="absolute inset-[22px] rounded-full bg-accent"
        animate={step === "project" ? { scale: [1, 1.15, 1] } : { scale: 1 }}
        transition={{ duration: 0.6 }}
      />
      {count > 0 && step === "scan" && (
        <span className="absolute -right-1 top-0 rounded-full bg-ok px-1.5 text-[10px] font-medium text-white">
          {count}
        </span>
      )}
    </div>
  );
}

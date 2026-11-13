import { useEffect, useRef, useState, type RefObject } from "react";
import { orderedVoiceTrace } from "../../lib/mic-capture";
import type { MicDevice } from "../../lib/speech";
import type { Effort } from "../../lib/tauri";
import { Symbol } from "../Symbol";
import { PopChoice, PopMenu } from "./PopMenu";

/** Bars drawn beside the mic. The capture buffer is longer than this. */
const WAVE_BARS = 7;

/** Live microphone levels, a short meter beside the mic button. */
export function VoiceWave({
  trace,
  written,
}: {
  trace: RefObject<Float32Array | null>;
  written: RefObject<number>;
}) {
  const [levels, setLevels] = useState<number[]>(() => shownVoiceLevels(trace.current ?? [], written.current));
  useEffect(() => {
    const tick = () => setLevels(shownVoiceLevels(trace.current ?? [], written.current));
    tick();
    const timer = window.setInterval(tick, 50);
    return () => window.clearInterval(timer);
  }, [trace, written]);
  return (
    <div className="flex h-7 w-11 items-center justify-end gap-[3px] pr-0.5" aria-hidden>
      {levels.map((level, index) => (
        <span
          key={index}
          className="w-[3px] shrink-0 rounded-full bg-accent transition-[height,opacity] duration-150 ease-out motion-reduce:transition-none"
          style={{
            height: `${Math.max(3, Math.round(3 + level * 11))}px`,
            opacity: level > 0.05 ? 0.45 + level * 0.55 : 0.32,
          }}
        />
      ))}
    </div>
  );
}

function shownVoiceLevels(trace: ArrayLike<number>, written: number): number[] {
  const levels = orderedVoiceTrace(trace, written);
  if (levels.length <= WAVE_BARS) return levels;
  return levels.slice(levels.length - WAVE_BARS);
}

export function MicSelect({
  open,
  devices,
  value,
  anchor,
  onPick,
  onClose,
}: {
  open: boolean;
  devices: MicDevice[];
  value: string;
  anchor: RefObject<HTMLButtonElement | null>;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <PopMenu open={open} anchor={anchor} label="Microphone" align="end" width={240} onClose={onClose}>
      <PopChoice
        label="System default"
        icon="mic"
        selected={value === ""}
        onPick={() => onPick("")}
      />
      {devices.map((device) => (
        <PopChoice
          key={device.id}
          label={device.label}
          icon="mic"
          selected={device.id === value}
          onPick={() => onPick(device.id)}
        />
      ))}
    </PopMenu>
  );
}

export function ChipSelect({
  label,
  title,
  items,
  value,
  onChange,
}: {
  label: string;
  title: string;
  items: Effort[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const wide = items.some((item) => item.detail);

  return (
    <div className="relative">
      <button
        ref={button}
        type="button"
        title={title}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={`flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-[11px] transition-colors duration-150 ease-out hover:bg-wash motion-reduce:transition-none ${
          open ? "bg-wash text-ink" : "text-muted hover:text-ink"
        }`}
      >
        <Symbol name={chipButtonIcon(title, value)} className="size-3" />
        <span className="max-w-[132px] truncate">{label}</span>
        <Symbol name="chevron.down" className="size-2.5 opacity-70" />
      </button>
      <PopMenu open={open} anchor={button} label={title} width={wide ? 280 : 200} onClose={() => setOpen(false)}>
        {items.map((item) => (
          <PopChoice
            key={item.id}
            label={item.label}
            detail={item.detail}
            icon={chipIcon(title, item.id)}
            selected={item.id === value}
            onPick={() => {
              onChange(item.id);
              setOpen(false);
            }}
          />
        ))}
      </PopMenu>
    </div>
  );
}

export function PlanToggle({
  mode,
  busy,
  onToggle,
}: {
  mode: "off" | "pending" | "on";
  busy: boolean;
  onToggle: () => void;
}) {
  const on = mode !== "off";
  const title =
    mode === "on"
      ? busy
        ? "Plan mode is on. Click to leave it after this turn."
        : "Plan mode is on. Click to turn it off."
      : mode === "pending"
        ? "The next message will be planned. Click to cancel."
        : "Plan the next message before Grok edits anything.";
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onToggle}
      className={`flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-[11px] transition-colors duration-150 ease-out hover:bg-wash motion-reduce:transition-none ${
        on ? "bg-accent/15 text-accent" : "text-muted hover:text-ink"
      }`}
    >
      <Symbol name="doc.fill" className="size-3" />
      <span>Plan</span>
    </button>
  );
}

function chipButtonIcon(title: string, id: string): string {
  if (title === "Speed") return "speedometer";
  if (title === "Thinking") return "brain";
  if (title === "Context size") return "text.lines";
  return chipIcon(title, id) ?? "text.lines";
}

function chipIcon(title: string, id: string): string | undefined {
  if (title === "Thinking") return effortIcon(id);
  if (title === "Permissions") return permissionIcon(id);
  return undefined;
}

function effortIcon(id: string): string {
  if (id === "low") return "leaf";
  if (id === "medium") return "gauge.medium";
  if (id === "high" || id === "xhigh") return "bolt";
  if (id === "max") return "sparkles";
  return "brain";
}

function permissionIcon(id: string): string {
  if (id === "approve-all") return "bolt";
  if (id === "read-only") return "eye";
  return "lock";
}

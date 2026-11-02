import { useRef, useState, type RefObject } from "react";
import { voiceBars, type MicDevice } from "../../lib/speech";
import type { Effort } from "../../lib/tauri";
import { Symbol } from "../Symbol";
import { PopChoice, PopMenu } from "./PopMenu";

export function VoiceMeter({ level }: { level: number }) {
  const bars = voiceBars(level);
  return (
    <span className="mr-1 flex h-4 items-center gap-[2px]" aria-hidden title="Microphone level">
      {bars.map((height, index) => (
        <span
          key={index}
          className={`w-[2px] rounded-full ${level > 0.08 ? "bg-err" : "bg-muted/50"}`}
          style={{ height: `${Math.round(height * 14)}px` }}
        />
      ))}
    </span>
  );
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
        className={`flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[11px] hover:bg-wash ${
          open ? "bg-wash text-ink" : "text-muted hover:text-ink"
        }`}
      >
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
      className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] hover:bg-wash ${
        on ? "bg-accent/15 text-accent" : "text-muted hover:text-ink"
      }`}
    >
      <Symbol name="doc.fill" className="size-3" />
      <span>Plan</span>
    </button>
  );
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

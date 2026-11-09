import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Symbol } from "../Symbol";
import { MODEL_MENU_EASE } from "./menuEase";

export function PopMenu({
  open,
  anchor,
  label,
  align = "start",
  width,
  placement = "auto",
  onClose,
  children,
}: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  label: string;
  align?: "start" | "end";
  width: number;
  /** `below` stays under the anchor even when the window is short. */
  placement?: "auto" | "below";
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; top: number; above: boolean } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const node = anchor.current;
      const menu = panel.current;
      if (!node || !menu) return;
      const frame = node.getBoundingClientRect();
      const height = menu.getBoundingClientRect().height;
      const left = align === "end" ? frame.right - width : frame.left;
      const clamped = Math.min(Math.max(8, left), window.innerWidth - width - 8);
      const gap = 6;
      const above = placement === "below" ? false : frame.top - height - gap >= 8;
      setBox({
        left: clamped,
        top: above ? frame.top - gap - height : frame.bottom + gap,
        above,
      });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor, align, width, placement, children]);

  useEffect(() => {
    if (!open) return;
    function onDoc(ev: MouseEvent) {
      const target = ev.target as Node;
      if (anchor.current?.contains(target) || panel.current?.contains(target)) return;
      onClose();
    }
    function onKey(ev: globalThis.KeyboardEvent) {
      if (ev.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, anchor, onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          ref={panel}
          role="menu"
          aria-label={label}
          initial={{ opacity: 0, y: box?.above === false ? -6 : 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: box?.above === false ? -6 : 6 }}
          transition={{ duration: 0.16, ease: MODEL_MENU_EASE }}
          style={{ left: box?.left ?? -9999, top: box?.top ?? 0, width, visibility: box ? "visible" : "hidden" }}
          className={`fixed z-50 overflow-hidden rounded-lg border border-line/25 bg-canvas shadow-card ${
            box?.above === false ? "origin-top" : "origin-bottom"
          }`}
          onMouseDown={(ev) => ev.stopPropagation()}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

export function PopChoice({
  label,
  detail,
  icon,
  selected,
  onPick,
}: {
  label: string;
  detail?: string;
  icon?: string;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onPick}
      className={`flex w-full cursor-pointer items-center gap-2 px-2.5 text-left transition-colors duration-150 hover:bg-wash ${
        detail ? "py-1.5" : "h-7"
      } ${selected ? "font-medium text-ink" : "text-ink/80"}`}
    >
      {icon ? <Symbol name={icon} className="size-3.5 shrink-0 text-muted" /> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px]">{label}</span>
        {detail ? <span className="mt-0.5 block text-[11px] leading-snug font-normal text-muted">{detail}</span> : null}
      </span>
      <Symbol
        name="checkmark"
        className={`size-3 shrink-0 text-accent transition-opacity duration-150 ${selected ? "opacity-100" : "opacity-0"}`}
      />
    </button>
  );
}

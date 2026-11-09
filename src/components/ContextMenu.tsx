import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MODEL_MENU_EASE } from "./composer/menuEase";
import { menuMotionOrigin, placeMenu } from "../lib/menu-place";
import { Symbol } from "./Symbol";

const MENU_EASE = `cubic-bezier(${MODEL_MENU_EASE.join(", ")})`;
const MENU_MS = 160;

type MenuPos = {
  left: number;
  top: number;
  originX: "left" | "right";
  originY: "top" | "bottom";
};

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function shiftY(originY: MenuPos["originY"]) {
  return originY === "bottom" ? 6 : -6;
}

export function AnchoredMenu({
  x,
  y,
  label,
  onMouseEnter,
  onMouseLeave,
  children,
}: {
  x: number;
  y: number;
  label?: string;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const alive = useRef(false);
  const [pos, setPos] = useState<MenuPos | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    const placed = placeMenu(x, y, box.width, box.height, { width: window.innerWidth, height: window.innerHeight });
    const origin = menuMotionOrigin(x, y, placed, box.width, box.height);
    setPos((current) => {
      if (
        current &&
        current.left === placed.left &&
        current.top === placed.top &&
        current.originX === origin.originX &&
        current.originY === origin.originY
      ) {
        return current;
      }
      return { ...placed, ...origin };
    });
  }, [x, y, children]);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !pos || reducedMotion()) return;
    alive.current = true;
    const fromY = shiftY(pos.originY);
    const anim = node.animate(
      [
        { opacity: 0, transform: `translateY(${fromY}px) scale(0.96)` },
        { opacity: 1, transform: "translateY(0px) scale(1)" },
      ],
      { duration: MENU_MS, easing: MENU_EASE, fill: "backwards" },
    );
    return () => {
      // Parents unmount the menu immediately. Snapshot first, then keep a clone
      // only if this effect does not run again (a real close, not a move or Strict Mode).
      alive.current = false;
      const computed = getComputedStyle(node);
      const opacity = Number(computed.opacity) || 0;
      const transform = computed.transform !== "none" ? computed.transform : "translateY(0px) scale(1)";
      const exitY = shiftY(node.style.transformOrigin.includes("bottom") ? "bottom" : "top");
      anim.cancel();
      const clone = node.cloneNode(true) as HTMLDivElement;
      clone.style.pointerEvents = "none";
      clone.style.visibility = "hidden";
      clone.setAttribute("aria-hidden", "true");
      clone.removeAttribute("role");
      document.body.appendChild(clone);
      queueMicrotask(() => {
        if (alive.current) {
          clone.remove();
          return;
        }
        clone.style.visibility = "visible";
        const exit = clone.animate(
          [
            { opacity, transform },
            { opacity: 0, transform: `translateY(${exitY}px) scale(0.96)` },
          ],
          { duration: MENU_MS, easing: MENU_EASE, fill: "both" },
        );
        const remove = () => clone.remove();
        exit.onfinish = remove;
        exit.oncancel = remove;
      });
    };
  }, [pos]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className="cloud-card fixed z-50 min-w-[168px] overflow-hidden rounded-xl bg-canvas/60 p-1 backdrop-blur-xl"
      style={{
        left: pos?.left ?? x,
        top: pos?.top ?? y,
        visibility: pos ? "visible" : "hidden",
        transformOrigin: pos ? `${pos.originX} ${pos.originY}` : "top left",
      }}
      onMouseDown={(ev) => ev.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
    </div>,
    document.body,
  );
}

const ITEM =
  "flex w-full items-center rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-wash disabled:cursor-default disabled:opacity-40";

export function MenuSeparator() {
  return <div role="separator" className="mx-1.5 my-1 h-px bg-line/50" />;
}

export function MenuItem({
  danger,
  disabled,
  onClick,
  children,
}: {
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`${ITEM} ${danger ? "text-err" : "text-ink/80"}`}
    >
      {children}
    </button>
  );
}

/** Nested menu that opens to the side of a parent row. Hover or click to keep it open. */
export function MenuSubmenu({ label, children }: { label: string; children: ReactNode }) {
  const itemRef = useRef<HTMLButtonElement>(null);
  const closeAt = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  function cancelClose() {
    if (closeAt.current == null) return;
    window.clearTimeout(closeAt.current);
    closeAt.current = null;
  }

  function armClose() {
    cancelClose();
    closeAt.current = window.setTimeout(() => setOpen(false), 100);
  }

  function show() {
    cancelClose();
    const box = itemRef.current?.getBoundingClientRect();
    if (!box) return;
    setPos({ x: box.right - 4, y: box.top - 4 });
    setOpen(true);
  }

  useEffect(() => () => cancelClose(), []);

  return (
    <div onMouseEnter={show} onMouseLeave={armClose}>
      <button
        ref={itemRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(ev) => {
          ev.preventDefault();
          show();
        }}
        onKeyDown={(ev) => {
          if (ev.key === "ArrowRight" || ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            show();
          }
          if (ev.key === "ArrowLeft") {
            ev.preventDefault();
            setOpen(false);
          }
        }}
        className={`${ITEM} justify-between gap-3 ${open ? "bg-wash text-ink" : "text-ink/80"}`}
      >
        {label}
        <Symbol name="chevron.right" className="size-3 shrink-0 text-muted" />
      </button>
      {open && pos ? (
        <AnchoredMenu x={pos.x} y={pos.y} label={label} onMouseEnter={show} onMouseLeave={armClose}>
          {children}
        </AnchoredMenu>
      ) : null}
    </div>
  );
}

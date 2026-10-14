import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { placeMenu } from "../lib/menu-place";

export function AnchoredMenu({
  x,
  y,
  label,
  children,
}: {
  x: number;
  y: number;
  label?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    setPos(placeMenu(x, y, box.width, box.height, { width: window.innerWidth, height: window.innerHeight }));
  }, [x, y, children]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className="fixed z-50 min-w-[168px] overflow-hidden rounded-lg border border-line/25 bg-canvas shadow-card"
      style={{
        left: pos?.left ?? x,
        top: pos?.top ?? y,
        visibility: pos ? "visible" : "hidden",
      }}
      onMouseDown={(ev) => ev.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

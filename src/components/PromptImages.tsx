import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatImage } from "../lib/core";
import { isFileAttachment } from "../lib/image";
import { FileIcon } from "./FileIcon";
import { Symbol } from "./Symbol";

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

export function PromptImages({
  images,
  onRemove,
}: {
  images: ChatImage[];
  onRemove?: (id: string) => void;
}) {
  const [open, setOpen] = useState<ChatImage | null>(null);
  if (!images.length) return null;
  return (
    <div className={`flex flex-wrap ${onRemove ? "gap-2.5 pt-1 pr-1" : "gap-1.5"}`}>
      {images.map((img) => (
        <div key={img.id} className="relative">
          {isFileAttachment(img) ? (
            <div
              title={img.name || "File"}
              className="flex h-14 max-w-56 items-center gap-2 overflow-hidden rounded-md border border-line/50 bg-wash px-2.5"
            >
              <FileIcon name={img.name || "file"} className="size-7" />
              <span className="min-w-0 truncate text-[12px] text-ink">{img.name || "File"}</span>
            </div>
          ) : (
            <ImageThumb image={img} onOpen={() => setOpen(img)} />
          )}
          {onRemove ? (
            <button
              type="button"
              aria-label={`Remove ${img.name || (isFileAttachment(img) ? "file" : "image")}`}
              title="Remove"
              onClick={() => onRemove(img.id)}
              className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-line/70 bg-canvas text-ink shadow-[0_1px_3px_rgba(0,0,0,0.16)] hover:bg-wash"
            >
              <Symbol name="xmark" className="size-2.5" />
            </button>
          ) : null}
        </div>
      ))}
      {open ? <ImageLightbox image={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function ImageThumb({ image, onOpen }: { image: ChatImage; onOpen: () => void }) {
  const src = image.previewUrl || (image.path ? convertFileSrc(image.path) : "");
  if (!src) {
    return (
      <div
        aria-label={image.name || "Image"}
        className="h-14 w-14 animate-pulse rounded-md border border-line/50 bg-wash"
      />
    );
  }
  return (
    <button
      type="button"
      aria-label={`Enlarge ${image.name || "image"}`}
      title={image.name || "Enlarge"}
      onClick={onOpen}
      className="block overflow-hidden rounded-md border border-line/50"
    >
      <img src={src} alt={image.name || "Image"} className="h-14 w-14 object-cover" />
    </button>
  );
}

function ImageLightbox({ image, onClose }: { image: ChatImage; onClose: () => void }) {
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "+" || event.key === "=") setZoom((value) => clampZoom(value * 1.25));
      else if (event.key === "-" || event.key === "_") setZoom((value) => clampZoom(value / 1.25));
      else if (event.key === "0") {
        setZoom(MIN_ZOOM);
        setPan({ x: 0, y: 0 });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function zoomBy(factor: number) {
    setZoom((value) => {
      const next = clampZoom(value * factor);
      if (next === MIN_ZOOM) setPan({ x: 0, y: 0 });
      return next;
    });
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={image.name || "Image"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="absolute top-3 right-3 z-10 flex items-center gap-1">
        <LightboxButton label="Zoom out" name="minus" disabled={zoom <= MIN_ZOOM} onClick={() => zoomBy(1 / 1.25)} />
        <button
          type="button"
          onClick={() => {
            setZoom(MIN_ZOOM);
            setPan({ x: 0, y: 0 });
          }}
          className="h-8 min-w-14 rounded-md bg-white/10 px-2 text-[12px] tabular-nums text-white hover:bg-white/20"
          title="Actual size"
        >
          {Math.round(zoom * 100)}%
        </button>
        <LightboxButton label="Zoom in" name="plus" disabled={zoom >= MAX_ZOOM} onClick={() => zoomBy(1.25)} />
        <LightboxButton label="Close" name="xmark" onClick={onClose} />
      </div>
      {image.name ? (
        <div className="pointer-events-none absolute top-3 left-4 z-10 max-w-[50vw] truncate text-[13px] text-white/80">
          {image.name}
        </div>
      ) : null}
      <img
        src={image.previewUrl || convertFileSrc(image.path)}
        alt={image.name || "Image"}
        draggable={false}
        onWheel={(event) => {
          event.preventDefault();
          zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1);
        }}
        onDoubleClick={() => {
          if (zoom > MIN_ZOOM) {
            setZoom(MIN_ZOOM);
            setPan({ x: 0, y: 0 });
          } else {
            setZoom(2);
          }
        }}
        onPointerDown={(event) => {
          if (zoom <= MIN_ZOOM) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start) return;
          setPan({ x: start.panX + event.clientX - start.x, y: start.panY + event.clientY - start.y });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        className={`max-h-[88vh] max-w-[92vw] select-none object-contain shadow-card ${
          zoom > MIN_ZOOM ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"
        }`}
      />
    </div>,
    document.body,
  );
}

function LightboxButton({
  label,
  name,
  onClick,
  disabled,
}: {
  label: string;
  name: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-8 items-center justify-center rounded-md bg-white/10 text-white hover:bg-white/20 disabled:opacity-40"
    >
      <Symbol name={name} className="size-3.5" />
    </button>
  );
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

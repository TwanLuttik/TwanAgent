import { convertFileSrc } from "@tauri-apps/api/core";
import type { ChatImage } from "../lib/dev";
import { Symbol } from "./Symbol";

export function PromptImages({
  images,
  onRemove,
}: {
  images: ChatImage[];
  onRemove?: (id: string) => void;
}) {
  if (!images.length) return null;
  return (
    <div className={`flex flex-wrap ${onRemove ? "gap-2.5 pt-1 pr-1" : "gap-1.5"}`}>
      {images.map((img) => (
        <div key={img.id} className="relative">
          <img
            src={convertFileSrc(img.path)}
            alt={img.name || "Image"}
            title={img.name}
            className="h-14 w-14 rounded-md border border-line/50 object-cover"
          />
          {onRemove ? (
            <button
              type="button"
              aria-label={`Remove ${img.name || "image"}`}
              title="Remove"
              onClick={() => onRemove(img.id)}
              className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-line/70 bg-canvas text-ink shadow-[0_1px_3px_rgba(0,0,0,0.16)] hover:bg-wash"
            >
              <Symbol name="xmark" className="size-2.5" />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

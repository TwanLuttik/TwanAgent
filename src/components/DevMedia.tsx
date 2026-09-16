import { convertFileSrc } from "@tauri-apps/api/core";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { formatPlayerTime, type MediaKind } from "../lib/dev-editor";
import * as api from "../lib/tauri";
import { Symbol } from "./Symbol";

export type MediaMeta = { label: string };

export function DevMedia({
  workspace,
  path,
  kind,
  tick,
  onMeta,
}: {
  workspace: string;
  path: string;
  kind: MediaKind;
  tick: number;
  onMeta?: (meta: MediaMeta | null) => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onMetaRef = useRef(onMeta);
  onMetaRef.current = onMeta;

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setError(null);
    onMetaRef.current?.(null);
    void api
      .devResolveFile(workspace, path)
      .then((abs) => {
        if (cancelled) return;
        const url = convertFileSrc(abs);
        setSrc(tick ? `${url}${url.includes("?") ? "&" : "?"}t=${tick}` : url);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [workspace, path, tick]);

  if (error) {
    return <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-[13px] text-err">{error}</div>;
  }
  if (!src) {
    return <div className="min-h-0 flex-1 px-4 py-3 text-[12px] text-muted">Opening…</div>;
  }
  if (kind === "image") {
    return <ImagePreview src={src} path={path} onMeta={onMeta} />;
  }
  return <VideoPlayer src={src} onMeta={onMeta} />;
}

function ImagePreview({
  src,
  path,
  onMeta,
}: {
  src: string;
  path: string;
  onMeta?: (meta: MediaMeta | null) => void;
}) {
  const [failed, setFailed] = useState(false);

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-inset p-4">
      {failed ? (
        <div className="text-[13px] text-err">Couldn’t load this image.</div>
      ) : (
        <img
          src={src}
          alt={path}
          className="media-check max-h-full max-w-full object-contain shadow-[0_0_0_1px_var(--color-line)]"
          onLoad={(ev) => {
            const img = ev.currentTarget;
            onMeta?.({ label: `${img.naturalWidth} × ${img.naturalHeight}` });
          }}
          onError={() => {
            setFailed(true);
            onMeta?.(null);
          }}
        />
      )}
    </div>
  );
}

function VideoPlayer({
  src,
  onMeta,
}: {
  src: string;
  onMeta?: (meta: MediaMeta | null) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [showControls, setShowControls] = useState(true);

  const bumpControls = useCallback(() => {
    setShowControls(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    const video = videoRef.current;
    if (video && !video.paused) {
      hideTimer.current = window.setTimeout(() => setShowControls(false), 1800);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, []);

  useEffect(() => {
    const onFs = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  }

  function seekTo(next: number) {
    const video = videoRef.current;
    if (!video || !Number.isFinite(next)) return;
    const max = Number.isFinite(video.duration) ? video.duration : duration;
    video.currentTime = Math.min(Math.max(next, 0), max || 0);
  }

  function setVol(next: number) {
    const video = videoRef.current;
    if (!video) return;
    const vol = Math.min(Math.max(next, 0), 1);
    video.volume = vol;
    video.muted = vol === 0;
  }

  function toggleMute() {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 0.6;
  }

  async function toggleFullscreen() {
    const wrap = wrapRef.current;
    if (!wrap) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await wrap.requestFullscreen();
  }

  function onKey(ev: ReactKeyboardEvent<HTMLDivElement>) {
    const video = videoRef.current;
    if (!video) return;
    if (ev.key === " " || ev.key === "k") {
      ev.preventDefault();
      togglePlay();
    } else if (ev.key === "ArrowLeft") {
      ev.preventDefault();
      seekTo(video.currentTime - 5);
    } else if (ev.key === "ArrowRight") {
      ev.preventDefault();
      seekTo(video.currentTime + 5);
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setVol(video.volume + 0.1);
    } else if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setVol(video.volume - 0.1);
    } else if (ev.key === "m") {
      ev.preventDefault();
      toggleMute();
    } else if (ev.key === "f") {
      ev.preventDefault();
      void toggleFullscreen();
    }
  }

  const pct = duration > 0 ? (current / duration) * 100 : 0;

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-inset p-3">
      {failed ? (
        <div className="text-[13px] text-err">This video can’t be played.</div>
      ) : (
        <div
          ref={wrapRef}
          tabIndex={0}
          className={`group/player relative max-h-full max-w-full outline-none ${
            fullscreen ? "flex h-full w-full items-center justify-center bg-black" : ""
          }`}
          onPointerDown={() => wrapRef.current?.focus()}
          onMouseMove={bumpControls}
          onMouseLeave={() => {
            if (playing) setShowControls(false);
          }}
          onKeyDown={onKey}
        >
          <video
            key={src}
            ref={videoRef}
            src={src}
            className="block h-auto max-h-full w-auto max-w-full cursor-pointer bg-black object-contain"
            playsInline
            preload="metadata"
            onClick={togglePlay}
            onPlay={() => {
              setPlaying(true);
              bumpControls();
            }}
            onPause={() => {
              setPlaying(false);
              setShowControls(true);
            }}
            onTimeUpdate={(ev) => setCurrent(ev.currentTarget.currentTime)}
            onDurationChange={(ev) => {
              const next = ev.currentTarget.duration;
              if (Number.isFinite(next)) {
                setDuration(next);
                onMeta?.({ label: formatPlayerTime(next) });
              }
            }}
            onLoadedMetadata={(ev) => {
              const next = ev.currentTarget.duration;
              if (Number.isFinite(next)) {
                setDuration(next);
                onMeta?.({ label: formatPlayerTime(next) });
              }
            }}
            onVolumeChange={(ev) => {
              setVolume(ev.currentTarget.volume);
              setMuted(ev.currentTarget.muted);
            }}
            onEnded={() => setPlaying(false)}
            onError={() => {
              setFailed(true);
              onMeta?.(null);
            }}
          />
          <div
            className={`pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/35 to-transparent px-2.5 pb-2 pt-10 transition-opacity ${
              showControls || !playing ? "opacity-100" : "opacity-0"
            }`}
          >
            <div className="pointer-events-auto flex items-center gap-2 text-white">
              <IconButton
                label={playing ? "Pause" : "Play"}
                onClick={togglePlay}
                name={playing ? "pause.fill" : "play.fill"}
              />
              <span className="shrink-0 tabular-nums text-[11px] text-white/80">
                {formatPlayerTime(current)} / {formatPlayerTime(duration)}
              </span>
              <Scrub
                value={pct}
                onChange={(next) => {
                  if (duration > 0) seekTo((next / 100) * duration);
                }}
              />
              <IconButton
                label={muted || volume === 0 ? "Unmute" : "Mute"}
                onClick={toggleMute}
                name={muted || volume === 0 ? "speaker.slash" : "speaker"}
              />
              <Scrub
                value={(muted ? 0 : volume) * 100}
                onChange={(next) => setVol(next / 100)}
                className="max-w-[4.5rem]"
              />
              <IconButton
                label={fullscreen ? "Exit full screen" : "Full screen"}
                onClick={() => void toggleFullscreen()}
                name={fullscreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right"}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function IconButton({
  label,
  name,
  onClick,
}: {
  label: string;
  name: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-[6px] text-white hover:bg-white/15"
    >
      <Symbol name={name} className="size-3.5" />
    </button>
  );
}

function Scrub({
  value,
  onChange,
  className = "",
}: {
  value: number;
  onChange: (next: number) => void;
  className?: string;
}) {
  function at(ev: ReactPointerEvent<HTMLDivElement>) {
    const box = ev.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return 0;
    return Math.min(Math.max(((ev.clientX - box.left) / box.width) * 100, 0), 100);
  }

  function start(ev: ReactPointerEvent<HTMLDivElement>) {
    ev.preventDefault();
    ev.currentTarget.setPointerCapture(ev.pointerId);
    onChange(at(ev));
  }

  return (
    <div
      className={`group/scrub relative h-4 min-w-8 flex-1 cursor-pointer ${className}`}
      onPointerDown={start}
      onPointerMove={(ev) => {
        if (ev.currentTarget.hasPointerCapture(ev.pointerId)) onChange(at(ev));
      }}
    >
      <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-white/25">
        <div className="h-full rounded-full bg-accent" style={{ width: `${value}%` }} />
      </div>
      <div
        className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white opacity-0 group-hover/scrub:opacity-100 group-active/scrub:opacity-100"
        style={{ left: `${value}%` }}
      />
    </div>
  );
}

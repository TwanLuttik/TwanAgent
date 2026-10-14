import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

export function isMacOS(): boolean {
  return /Mac/i.test(navigator.userAgent) && !/iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function isWindows(): boolean {
  return /Windows/i.test(navigator.userAgent);
}

/** Titlebar height. Matches the collapsed sidebar so the header does not grow when it closes. */
export function headerBarClass(): string {
  return "h-11";
}

export function WindowButtons() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let gone = false;
    void win.isMaximized().then((v) => {
      if (!gone) setMaximized(v);
    });
    const un = win.onResized(() => {
      void win.isMaximized().then((v) => {
        if (!gone) setMaximized(v);
      });
    });
    return () => {
      gone = true;
      void un.then((fn) => fn());
    };
  }, []);

  if (isMacOS()) return <MacLights maximized={maximized} />;
  return <MetroButtons maximized={maximized} />;
}

function MacLights({ maximized }: { maximized: boolean }) {
  return (
    <div className="group/lights flex h-full items-center gap-[8px] px-[13px]" data-tauri-drag-region="false">
      <MacDot
        label="Close"
        fill="#ff5f57"
        stroke="#e0443e"
        glyph="#4d0000"
        onClick={() => void getCurrentWindow().close()}
      >
        <path d="M3.2 3.2l5.6 5.6M8.8 3.2L3.2 8.8" />
      </MacDot>
      <MacDot
        label="Minimize"
        fill="#febc2e"
        stroke="#d69e1f"
        glyph="#995700"
        onClick={() => void getCurrentWindow().minimize()}
      >
        <path d="M2.6 6h6.8" />
      </MacDot>
      <MacDot
        label={maximized ? "Restore" : "Full Screen"}
        fill="#28c840"
        stroke="#1aad2b"
        glyph="#006500"
        onClick={() => void getCurrentWindow().toggleMaximize()}
      >
        {maximized ? (
          <path d="M3.4 6.6h2.8V3.8M8.6 5.4H5.8v2.8" />
        ) : (
          <path d="M4.6 3.4h4v4M7.4 8.6h-4v-4" />
        )}
      </MacDot>
    </div>
  );
}

function MacDot({
  label,
  fill,
  stroke,
  glyph,
  onClick,
  children,
}: {
  label: string;
  fill: string;
  stroke: string;
  glyph: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-3 items-center justify-center rounded-full"
      style={{ background: fill, boxShadow: `inset 0 0 0 0.5px ${stroke}` }}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        className="opacity-0 group-hover/lights:opacity-100"
        aria-hidden
      >
        <g fill="none" stroke={glyph} strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round">
          {children}
        </g>
      </svg>
    </button>
  );
}

function MetroButtons({ maximized }: { maximized: boolean }) {
  return (
    <div className="flex items-stretch" data-tauri-drag-region="false">
      <WinBtn label="Minimize" onClick={() => void getCurrentWindow().minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M1 5h8" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </WinBtn>
      <WinBtn label={maximized ? "Restore" : "Maximize"} onClick={() => void getCurrentWindow().toggleMaximize()}>
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M3 3h6v6H3zM1 5V1h6" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <rect x="1.2" y="1.2" width="7.6" height="7.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        )}
      </WinBtn>
      <WinBtn label="Close" hover="hover:bg-[#e81123] hover:text-white" onClick={() => void getCurrentWindow().close()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M1 1l8 8M9 1L1 9" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </WinBtn>
    </div>
  );
}

function WinBtn({
  label,
  hover = "hover:bg-wash-strong",
  onClick,
  children,
}: {
  label: string;
  hover?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex h-8 w-11 items-center justify-center text-ink ${hover}`}
    >
      {children}
    </button>
  );
}

import type { ReactNode } from "react";

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const thick = {
  ...stroke,
  strokeWidth: 2.5,
};

const ICONS: Record<string, ReactNode> = {
  externaldrive: (
    <>
      <rect x="2.6" y="7.4" width="18.8" height="8.4" rx="2.1" {...stroke} />
      <circle cx="6.4" cy="11.6" r="0.95" fill="currentColor" />
      <path d="M7 15.8v1.6M17 15.8v1.6" {...stroke} />
    </>
  ),
  "externaldrive.fill": (
    <>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M4.7 7.4h14.6A2.1 2.1 0 0 1 21.4 9.5v4.2a2.1 2.1 0 0 1-2.1 2.1H4.7A2.1 2.1 0 0 1 2.6 13.7V9.5A2.1 2.1 0 0 1 4.7 7.4Zm1.7 5.15a1.05 1.05 0 1 0 0-2.1 1.05 1.05 0 0 0 0 2.1Z"
      />
      <path d="M7 15.8v1.6M17 15.8v1.6" {...stroke} />
    </>
  ),
  "rectangle.stack": (
    <>
      <rect x="5.2" y="4.2" width="14.2" height="9.6" rx="1.8" {...stroke} />
      <rect x="3.4" y="8.4" width="14.2" height="9.6" rx="1.8" {...stroke} />
    </>
  ),
  "rectangle.stack.fill": (
    <>
      <rect x="5.2" y="4.2" width="14.2" height="9.6" rx="1.8" fill="currentColor" opacity="0.4" />
      <rect x="3.4" y="8.4" width="14.2" height="9.6" rx="1.8" fill="currentColor" />
    </>
  ),
  folder: (
    <path
      d="M3.3 8.6A2.1 2.1 0 0 1 5.4 6.5h3.1l1.55 1.75h8.65A2.1 2.1 0 0 1 20.8 10.35v7.15a2.1 2.1 0 0 1-2.1 2.1H5.4A2.1 2.1 0 0 1 3.3 17.5Z"
      {...stroke}
    />
  ),
  "folder.fill": (
    <path
      d="M3.3 8.6A2.1 2.1 0 0 1 5.4 6.5h3.1l1.55 1.75h8.65A2.1 2.1 0 0 1 20.8 10.35v7.15a2.1 2.1 0 0 1-2.1 2.1H5.4A2.1 2.1 0 0 1 3.3 17.5Z"
      fill="currentColor"
    />
  ),
  doc: (
    <>
      <path d="M7.8 3.4h5.4L19.6 9.8V19.6A1.6 1.6 0 0 1 18 21.2H7.8A1.6 1.6 0 0 1 6.2 19.6V5A1.6 1.6 0 0 1 7.8 3.4Z" {...stroke} />
      <path d="M13.2 3.4V9.4H19.6" {...stroke} />
    </>
  ),
  "doc.fill": (
    <path
      d="M7.4 3.4h5.6v6.2H20V19.6A1.7 1.7 0 0 1 18.3 21.3H7.4A1.7 1.7 0 0 1 5.7 19.6V5.1A1.7 1.7 0 0 1 7.4 3.4Z"
      fill="currentColor"
    />
  ),
  link: (
    <path
      d="M9.2 14.8 7.6 16.4a3.2 3.2 0 1 1-4.5-4.5l3.2-3.2a3.2 3.2 0 0 1 4.5 0M14.8 9.2l1.6-1.6a3.2 3.2 0 1 1 4.5 4.5l-3.2 3.2a3.2 3.2 0 0 1-4.5 0M9.8 14.2l4.4-4.4"
      {...stroke}
    />
  ),
  desktopcomputer: (
    <>
      <rect x="2.8" y="3.6" width="18.4" height="12.2" rx="2" {...stroke} />
      <path d="M9 20.4h6M12 15.8v4.6" {...stroke} />
    </>
  ),
  "desktopcomputer.fill": (
    <>
      <rect x="2.8" y="3.6" width="18.4" height="12.2" rx="2" fill="currentColor" />
      <path d="M9 20.4h6M12 15.8v4.6" {...stroke} />
    </>
  ),
  "list.bullet": (
    <>
      <path d="M9 7h11M9 12h11M9 17h11" {...stroke} />
      <circle cx="5.2" cy="7" r="1.05" fill="currentColor" />
      <circle cx="5.2" cy="12" r="1.05" fill="currentColor" />
      <circle cx="5.2" cy="17" r="1.05" fill="currentColor" />
    </>
  ),
  "list.tree": (
    <>
      <path d="M5 5.6v8.8" {...stroke} />
      <path d="M5 10h4.4M5 14.4h4.4" {...stroke} />
      <path d="M11.6 6.4h7.8M11.6 10h7.8M11.6 14.4h7.8M11.6 18.8h7.8" {...stroke} />
      <path d="M5 5.6h4.4" {...stroke} />
    </>
  ),
  "square.grid.2x2": (
    <>
      <rect x="3.6" y="3.6" width="7.1" height="7.1" rx="1.4" {...stroke} />
      <rect x="13.3" y="3.6" width="7.1" height="7.1" rx="1.4" {...stroke} />
      <rect x="3.6" y="13.3" width="7.1" height="7.1" rx="1.4" {...stroke} />
      <rect x="13.3" y="13.3" width="7.1" height="7.1" rx="1.4" {...stroke} />
    </>
  ),
  "square.grid.2x2.fill": (
    <>
      <rect x="3.6" y="3.6" width="7.1" height="7.1" rx="1.4" fill="currentColor" />
      <rect x="13.3" y="3.6" width="7.1" height="7.1" rx="1.4" fill="currentColor" />
      <rect x="3.6" y="13.3" width="7.1" height="7.1" rx="1.4" fill="currentColor" />
      <rect x="13.3" y="13.3" width="7.1" height="7.1" rx="1.4" fill="currentColor" />
    </>
  ),
  "chevron.left": <path d="M14.5 5.5 8.5 12l6 6.5" {...stroke} />,
  "chevron.right": <path d="M9.5 5.5 15.5 12l-6 6.5" {...stroke} />,
  "chevron.forward": <path d="M10 6l6 6-6 6" {...stroke} />,
  "chevron.up": <path d="M5.5 14.5 12 8.5l6.5 6" {...stroke} />,
  "chevron.down": <path d="M5.5 9.5 12 15.5l6.5-6" {...stroke} />,
  magnifyingglass: (
    <>
      <circle cx="11" cy="11" r="6.2" {...stroke} />
      <path d="m15.8 15.8 4.2 4.2" {...stroke} />
    </>
  ),
  tag: <path d="M4 4.8h6.4L20 14.4l-5.6 5.6L4.8 10.4V4.8Z M7.4 8.2h.01" {...stroke} />,
  "tag.fill": <path d="M4 4.8h6.4L20 14.4l-5.6 5.6L4.8 10.4V4.8Z" fill="currentColor" />,
  plus: <path d="M12 5v14M5 12h14" {...thick} />,
  ellipsis: (
    <>
      <circle cx="6" cy="12" r="1.7" fill="currentColor" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" />
      <circle cx="18" cy="12" r="1.7" fill="currentColor" />
    </>
  ),
  "square.and.arrow.down": (
    <>
      <path d="M12 3.4v10.2M8 10.2 12 14.2l4-4" {...thick} />
      <path
        d="M5.2 14.2v3.6A2 2 0 0 0 7.2 19.8h9.6a2 2 0 0 0 2-2v-3.6"
        {...thick}
      />
    </>
  ),
  "square.and.arrow.up": (
    <>
      <path d="M12 14.2V4M8 8l4-4 4 4" {...thick} />
      <path
        d="M5.2 14.2v3.6A2 2 0 0 0 7.2 19.8h9.6a2 2 0 0 0 2-2v-3.6"
        {...thick}
      />
    </>
  ),
  "doc.badge.plus": (
    <>
      <path d="M7.4 3.6h5.2L18.6 9.6V14" {...thick} />
      <path d="M12.6 3.6V9.4H18.6" {...thick} />
      <path d="M7.4 3.6A1.6 1.6 0 0 0 5.8 5.2V19a1.6 1.6 0 0 0 1.6 1.6H12" {...thick} />
      <path d="M16.6 15.2v6.2M13.5 18.3h6.2" {...thick} />
    </>
  ),
  eject: (
    <>
      <path d="M12 4.6 5.4 13.8h13.2Z" fill="currentColor" />
      <rect x="5.2" y="16.4" width="13.6" height="2.6" rx="0.8" fill="currentColor" />
    </>
  ),
  "eject.fill": (
    <>
      <path d="M12 4.6 5.4 13.8h13.2Z" fill="currentColor" />
      <rect x="5.2" y="16.4" width="13.6" height="2.6" rx="0.8" fill="currentColor" />
    </>
  ),
  play: <path d="M8.5 6.5v11l9-5.5Z" {...stroke} />,
  "play.fill": <path d="M8.5 6.5v11l9-5.5Z" fill="currentColor" />,
  pause: (
    <>
      <rect x="6.5" y="5.5" width="3.4" height="13" rx="0.8" {...stroke} />
      <rect x="14.1" y="5.5" width="3.4" height="13" rx="0.8" {...stroke} />
    </>
  ),
  "pause.fill": (
    <>
      <rect x="6.5" y="5.5" width="3.4" height="13" rx="0.8" fill="currentColor" />
      <rect x="14.1" y="5.5" width="3.4" height="13" rx="0.8" fill="currentColor" />
    </>
  ),
  "arrow.up.left.and.arrow.down.right": (
    <>
      <path d="M8.2 4.6H4.6V8.2" {...stroke} />
      <path d="M4.6 4.6 10 10" {...stroke} />
      <path d="M15.8 19.4h3.6V15.8" {...stroke} />
      <path d="M19.4 19.4 14 14" {...stroke} />
    </>
  ),
  "arrow.down.right.and.arrow.up.left": (
    <>
      <path d="M9.6 4.6V8.2H6" {...stroke} />
      <path d="M4.6 4.6 10 10" {...stroke} />
      <path d="M14.4 19.4V15.8H18" {...stroke} />
      <path d="M19.4 19.4 14 14" {...stroke} />
    </>
  ),
  speaker: (
    <>
      <path d="M4.8 9.2h3.2L12.4 6v12L8 14.8H4.8Z" fill="currentColor" />
      <path d="M15.2 9.2a4.2 4.2 0 0 1 0 5.6" {...stroke} />
    </>
  ),
  "speaker.slash": (
    <>
      <path d="M4.8 9.2h3.2L12.4 6v12L8 14.8H4.8Z" fill="currentColor" />
      <path d="M16 8.2 20.4 15.8" {...thick} />
    </>
  ),
  trash: (
    <>
      <path d="M4.8 7.2h14.4" {...thick} />
      <path d="M9 7.2V5.2h6v2" {...thick} />
      <path d="M8 7.4 8.8 19.2h6.4L16 7.4" {...thick} />
    </>
  ),
  "trash.fill": (
    <>
      <path d="M8.8 4.2h6.4c.5 0 .9.4.9.9v1.1H7.9V5.1c0-.5.4-.9.9-.9Z" fill="currentColor" />
      <path d="M4.6 7h14.8v1.6H4.6Z" fill="currentColor" />
      <path d="M7.1 8.8h9.8l-.75 10.3a1.5 1.5 0 0 1-1.5 1.4H9.35a1.5 1.5 0 0 1-1.5-1.4L7.1 8.8Z" fill="currentColor" />
    </>
  ),
  "arrow.down.to.line": <path d="M12 4v11M7.5 11.5 12 16l4.5-4.5M6 20h12" {...stroke} />,
  checkmark: <path d="M5.5 12.5 10 17l8.5-9.5" {...stroke} />,
  "checkmark.thick": <path d="M5.2 12.4 10 17.3 18.8 7.8" {...thick} />,
  "checkmark.circle.fill": (
    <>
      <circle cx="12" cy="12" r="12" fill="currentColor" />
      <path
        d="M7.6 12.2 10.5 15.1 16.4 8.8"
        fill="none"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  "exclamationmark.triangle": (
    <>
      <path
        d="M12 4.2 20.35 19.1a.95.95 0 0 1-.82 1.4H4.47a.95.95 0 0 1-.82-1.4L12 4.2Z"
        {...stroke}
        strokeWidth="1.7"
      />
      <path d="M12 10.1v4.2" {...stroke} strokeWidth="1.7" />
      <circle cx="12" cy="16.85" r="0.7" fill="currentColor" />
    </>
  ),
  "exclamationmark.triangle.thick": (
    <>
      <path
        d="M12 4.2 20.35 19.1a.95.95 0 0 1-.82 1.4H4.47a.95.95 0 0 1-.82-1.4L12 4.2Z"
        {...thick}
      />
      <path d="M12 10v4.3" {...thick} />
      <circle cx="12" cy="16.9" r="0.85" fill="currentColor" />
    </>
  ),
  "exclamationmark.triangle.fill": (
    <>
      <path
        d="M12 4.1 20.5 19.15A.95.95 0 0 1 19.67 20.6H4.33A.95.95 0 0 1 3.5 19.15L12 4.1Z"
        fill="currentColor"
      />
      <path
        d="M12 10v4.15"
        fill="none"
        stroke="var(--color-canvas)"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <circle cx="12" cy="16.9" r="0.72" fill="var(--color-canvas)" />
    </>
  ),
  "arrow.2.circlepath": (
    <>
      <path d="M16.4 7.1A6.5 6.5 0 0 0 6.2 9.4" {...stroke} />
      <path d="M6.2 5.6v3.8H10" {...stroke} />
      <path d="M7.6 16.9A6.5 6.5 0 0 0 17.8 14.6" {...stroke} />
      <path d="M17.8 18.4v-3.8H14" {...stroke} />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.1" {...stroke} />
      <path d="M12 7.6v4.7l3.3 2" {...stroke} />
    </>
  ),
  "clock.fill": (
    <>
      <circle cx="12" cy="12" r="8.1" fill="currentColor" />
      <path
        d="M12 7.6v4.7l3.3 2"
        fill="none"
        stroke="var(--color-canvas)"
        strokeWidth="2.15"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  xmark: <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" {...stroke} />,
  "arrow.up.forward": (
    <>
      <path d="M10 5.5H7.4A2 2 0 0 0 5.4 7.5v9.2A2 2 0 0 0 7.4 18.7h9.2a2 2 0 0 0 2-2V14" {...stroke} />
      <path d="M13.2 5.4h5.4V10.8M18.6 5.4 11 13" {...stroke} />
    </>
  ),
  "doc.on.doc": (
    <>
      <rect x="8.4" y="6.6" width="10.2" height="12.8" rx="1.6" {...stroke} />
      <path d="M5.4 16.2V6.8A1.8 1.8 0 0 1 7.2 5h7.2" {...stroke} />
    </>
  ),
  photo: (
    <>
      <rect x="3.4" y="5.4" width="17.2" height="13.2" rx="2" {...stroke} />
      <circle cx="8.4" cy="10" r="1.5" {...stroke} />
      <path d="m3.8 16.4 4.6-4.2 3.2 2.8 3.6-4.1 5.2 5.5" {...stroke} />
    </>
  ),
  film: (
    <>
      <rect x="3.6" y="4.6" width="16.8" height="14.8" rx="1.8" {...stroke} />
      <path d="M8.6 4.6v14.8M15.4 4.6v14.8M3.6 8.4h5M3.6 12h5M3.6 15.6h5M15.4 8.4h5M15.4 12h5M15.4 15.6h5" {...stroke} />
    </>
  ),
  music: (
    <>
      <path d="M9.2 18.6a2.4 2.4 0 1 1-2.4-2.4" {...stroke} />
      <path d="M9.2 16.2V6.4l9.2-1.8v9.8" {...stroke} />
      <path d="M18.4 16.8a2.4 2.4 0 1 1-2.4-2.4" {...stroke} />
    </>
  ),
  archivebox: (
    <>
      <path d="M4.2 7.2h15.6l-1.1 11.2a1.8 1.8 0 0 1-1.8 1.6H7.1a1.8 1.8 0 0 1-1.8-1.6L4.2 7.2Z" {...stroke} />
      <path d="M3.6 4.4h16.8v2.8H3.6Z" {...stroke} />
      <path d="M9.4 11.6h5.2" {...stroke} />
    </>
  ),
  lock: (
    <>
      <rect x="5.6" y="10.6" width="12.8" height="9.2" rx="1.8" {...stroke} />
      <path d="M8.2 10.6V8a3.8 3.8 0 0 1 7.6 0v2.6" {...stroke} />
    </>
  ),
  "lock.fill": (
    <>
      <rect x="5.6" y="10.6" width="12.8" height="9.2" rx="1.8" fill="currentColor" />
      <path d="M8.2 10.6V8a3.8 3.8 0 0 1 7.6 0v2.6" {...stroke} />
    </>
  ),
  person: (
    <>
      <circle cx="12" cy="8.2" r="2.6" {...stroke} />
      <path d="M6.2 18.4c.5-3.1 2.7-4.8 5.8-4.8s5.3 1.7 5.8 4.8" {...stroke} />
    </>
  ),
  "person.fill": (
    <>
      <circle cx="12" cy="8.2" r="2.7" fill="currentColor" />
      <path d="M6.1 18.6c.5-3.2 2.8-5 5.9-5s5.4 1.8 5.9 5" fill="currentColor" />
    </>
  ),
  "person.2": (
    <>
      <circle cx="9" cy="8.4" r="2.4" {...stroke} />
      <path d="M4.4 17.4c.4-2.6 2.2-4 4.6-4s4.2 1.4 4.6 4" {...stroke} />
      <circle cx="16.2" cy="8.8" r="2.1" {...stroke} />
      <path d="M15.2 13.6c2 .3 3.5 1.6 3.9 3.8" {...stroke} />
    </>
  ),
  "arrow.up": <path d="M12 19V6.2M7.2 10.6 12 5.8l4.8 4.8" {...thick} />,
  stop: <rect x="6.4" y="6.4" width="11.2" height="11.2" rx="2.2" {...stroke} />,
  "stop.fill": <rect x="6.4" y="6.4" width="11.2" height="11.2" rx="2.2" fill="currentColor" />,
  "arrow.up.circle.fill": (
    <>
      <circle cx="12" cy="12" r="8.4" fill="currentColor" />
      <path d="M12 16.2V8.4M8.6 11.4 12 8l3.4 3.4" stroke="#fff" strokeWidth={2.15} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </>
  ),
  brain: (
    <>
      <path
        d="M9.2 5.6a2.4 2.4 0 0 1 2.8 0 2.4 2.4 0 0 1 3.4 2.2c1.3.3 2.2 1.5 2.2 2.9 0 .7-.3 1.4-.7 1.9.4.5.7 1.2.7 1.9 0 1.5-1.1 2.7-2.6 2.9v.8a1.4 1.4 0 0 1-1.4 1.4h-5.2A1.4 1.4 0 0 1 7 17.2v-.8A3 3 0 0 1 4.6 13.6c0-.7.3-1.4.7-1.9A2.9 2.9 0 0 1 4.6 10c0-1.4.9-2.6 2.2-2.9A2.4 2.4 0 0 1 9.2 5.6Z"
        {...stroke}
      />
      <path d="M12 8.2v9" {...stroke} />
    </>
  ),
  "bubble.left": (
    <path
      d="M5.2 6.2h13.6A2.2 2.2 0 0 1 21 8.4v6.4a2.2 2.2 0 0 1-2.2 2.2H11l-3.8 3v-3H5.2A2.2 2.2 0 0 1 3 14.8V8.4A2.2 2.2 0 0 1 5.2 6.2Z"
      {...stroke}
    />
  ),
  "bubble.left.fill": (
    <path
      d="M5.2 6.2h13.6A2.2 2.2 0 0 1 21 8.4v6.4a2.2 2.2 0 0 1-2.2 2.2H11l-3.8 3v-3H5.2A2.2 2.2 0 0 1 3 14.8V8.4A2.2 2.2 0 0 1 5.2 6.2Z"
      fill="currentColor"
    />
  ),
  "arrow.triangle.branch": (
    <>
      <circle cx="7.2" cy="6.4" r="2.1" {...stroke} />
      <circle cx="7.2" cy="17.6" r="2.1" {...stroke} />
      <circle cx="16.8" cy="12" r="2.1" {...stroke} />
      <path d="M7.2 8.5v6.6M9.2 7.6c3.2.4 5.4 2 5.6 4.4" {...stroke} />
    </>
  ),
  terminal: (
    <>
      <rect x="3.4" y="4.4" width="17.2" height="15.2" rx="2.2" {...stroke} />
      <path d="M7.2 9.2 10.2 12 7.2 14.8M12.4 15.2h4.4" {...stroke} />
    </>
  ),
  "terminal.fill": (
    <>
      <rect x="3.4" y="4.4" width="17.2" height="15.2" rx="2.2" fill="currentColor" />
      <path d="M7.2 9.2 10.2 12 7.2 14.8M12.4 15.2h4.4" stroke="#fff" strokeWidth={2.15} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </>
  ),
  pencil: (
    <path
      d="M14.6 5.2 18.8 9.4 9.2 19H5v-4.2ZM13 6.8l4.2 4.2"
      {...stroke}
    />
  ),
  eye: (
    <>
      <path d="M3.4 12s3.2-6.2 8.6-6.2S20.6 12 20.6 12s-3.2 6.2-8.6 6.2S3.4 12 3.4 12Z" {...stroke} />
      <circle cx="12" cy="12" r="2.4" {...stroke} />
    </>
  ),
  gearshape: (
    <>
      <circle cx="12" cy="12" r="3.1" {...stroke} />
      <path
        d="M12 3.4 13.1 5.6l2.4-.5 1.4 2.1 2.2.9-.3 2.4 1.8 1.5-1.8 1.5.3 2.4-2.2.9-1.4 2.1-2.4-.5L12 20.6l-1.1-2.2-2.4.5-1.4-2.1-2.2-.9.3-2.4L3.4 12l1.8-1.5-.3-2.4 2.2-.9 1.4-2.1 2.4.5Z"
        {...stroke}
      />
    </>
  ),
  "gearshape.fill": (
    <>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M12 3.2 13.3 5.7l2.6-.5 1.5 2.3 2.4 1-.3 2.6 2 1.6-2 1.6.3 2.6-2.4 1-1.5 2.3-2.6-.5L12 20.8l-1.3-2.5-2.6.5-1.5-2.3-2.4-1 .3-2.6-2-1.6 2-1.6-.3-2.6 2.4-1 1.5-2.3 2.6.5Zm0 5.5a3.3 3.3 0 1 0 0 6.6 3.3 3.3 0 0 0 0-6.6Z"
      />
    </>
  ),
};

export type SymbolWeight = "light" | "regular" | "semibold";

const WEIGHT: Record<SymbolWeight, number> = {
  light: 1.3,
  regular: 1.55,
  semibold: 2.15,
};

export function Symbol({
  name,
  className = "size-4",
  weight = "semibold",
}: {
  name: string;
  className?: string;
  weight?: SymbolWeight;
}) {
  const node = ICONS[name] ?? ICONS[name.replace(/\.fill$/, "")] ?? ICONS.doc;
  return (
    <svg
      viewBox="0 0 24 24"
      className={`block shrink-0 ${className}`}
      aria-hidden
      strokeWidth={WEIGHT[weight]}
    >
      {node}
    </svg>
  );
}

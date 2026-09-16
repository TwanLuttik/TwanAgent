import type { ReactNode } from "react";
import { fileIconKind, type FileIconKind } from "../lib/file-icon";
import { Symbol } from "./Symbol";

type Badge = { bg: string; fg: string; label: string };

const BADGES: Partial<Record<FileIconKind, Badge>> = {
  js: { bg: "#e8c547", fg: "#3a3208", label: "JS" },
  jsx: { bg: "#e8c547", fg: "#3a3208", label: "JX" },
  ts: { bg: "#3178c6", fg: "#ffffff", label: "TS" },
  tsx: { bg: "#3178c6", fg: "#ffffff", label: "TX" },
  json: { bg: "#c9a227", fg: "#ffffff", label: "{}" },
  css: { bg: "#563d7c", fg: "#ffffff", label: "#" },
  scss: { bg: "#c6538c", fg: "#ffffff", label: "S" },
  html: { bg: "#e34c26", fg: "#ffffff", label: "<>" },
  md: { bg: "#4a7fd4", fg: "#ffffff", label: "MD" },
  rs: { bg: "#dea584", fg: "#3b2417", label: "RS" },
  py: { bg: "#3572a5", fg: "#ffd343", label: "PY" },
  toml: { bg: "#9c4221", fg: "#ffffff", label: "TM" },
  yaml: { bg: "#cb171e", fg: "#ffffff", label: "YL" },
  go: { bg: "#00add8", fg: "#083344", label: "GO" },
  vue: { bg: "#41b883", fg: "#ffffff", label: "V" },
  svelte: { bg: "#ff3e00", fg: "#ffffff", label: "SV" },
  c: { bg: "#555555", fg: "#ffffff", label: "C" },
  cpp: { bg: "#004482", fg: "#ffffff", label: "C+" },
  java: { bg: "#b07219", fg: "#ffffff", label: "JV" },
  kt: { bg: "#a97bff", fg: "#ffffff", label: "KT" },
  swift: { bg: "#f05138", fg: "#ffffff", label: "SW" },
  rb: { bg: "#701516", fg: "#ffffff", label: "RB" },
  php: { bg: "#4f5d95", fg: "#ffffff", label: "PHP" },
  sh: { bg: "#3e4e3a", fg: "#89e051", label: "SH" },
  sql: { bg: "#e38c00", fg: "#ffffff", label: "SQL" },
  xml: { bg: "#0060ac", fg: "#ffffff", label: "XML" },
  svg: { bg: "#ffb13b", fg: "#3a2a00", label: "SVG" },
  txt: { bg: "#8e8e93", fg: "#ffffff", label: "TXT" },
  pdf: { bg: "#e5252a", fg: "#ffffff", label: "PDF" },
  wasm: { bg: "#654ff0", fg: "#ffffff", label: "WM" },
  npm: { bg: "#cb3837", fg: "#ffffff", label: "NPM" },
  docker: { bg: "#2496ed", fg: "#ffffff", label: "DK" },
  git: { bg: "#f05033", fg: "#ffffff", label: "GIT" },
  env: { bg: "#ecd53f", fg: "#3a3208", label: "ENV" },
  make: { bg: "#525252", fg: "#ffffff", label: "MK" },
};

const SYMBOL_KINDS: Partial<Record<FileIconKind, { name: string; className: string }>> = {
  image: { name: "photo", className: "text-[#3b82f6]" },
  video: { name: "film", className: "text-[#a855f7]" },
  audio: { name: "music", className: "text-[#ec4899]" },
  zip: { name: "archivebox", className: "text-[#d97706]" },
  font: { name: "doc", className: "text-[#6366f1]" },
  config: { name: "gearshape.fill", className: "text-muted" },
  lock: { name: "lock.fill", className: "text-[#a1a1a6]" },
};

function BadgeGlyph({ bg, fg, label }: Badge): ReactNode {
  const size = label.length >= 3 ? 5.15 : label.length === 1 ? 7.2 : 6.35;
  return (
    <>
      <rect x="0.7" y="0.7" width="14.6" height="14.6" rx="3.1" fill={bg} />
      <text
        x="8"
        y="11.05"
        textAnchor="middle"
        fill={fg}
        fontSize={size}
        fontWeight={700}
        fontFamily='ui-sans-serif, system-ui, "Segoe UI", sans-serif'
      >
        {label}
      </text>
    </>
  );
}

export function FileIcon({ name, className = "size-3.5" }: { name: string; className?: string }) {
  const kind = fileIconKind(name);
  const symbol = SYMBOL_KINDS[kind];
  if (symbol) {
    return <Symbol name={symbol.name} className={`${className} ${symbol.className}`} />;
  }
  const badge = BADGES[kind];
  if (!badge) {
    return <Symbol name="doc" className={className} />;
  }
  return (
    <svg viewBox="0 0 16 16" className={`block shrink-0 ${className}`} aria-hidden>
      {BadgeGlyph(badge)}
    </svg>
  );
}

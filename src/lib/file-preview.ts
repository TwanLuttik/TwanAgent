import { fileIconKind, type FileIconKind } from "./file-icon.ts";

const KIND_LABEL: Record<FileIconKind, string> = {
  js: "JavaScript",
  jsx: "JSX",
  ts: "TypeScript",
  tsx: "TSX",
  json: "JSON",
  css: "CSS",
  scss: "SCSS",
  html: "HTML",
  md: "Markdown",
  rs: "Rust",
  py: "Python",
  toml: "TOML",
  yaml: "YAML",
  go: "Go",
  vue: "Vue",
  svelte: "Svelte",
  c: "C",
  cpp: "C++",
  java: "Java",
  kt: "Kotlin",
  swift: "Swift",
  rb: "Ruby",
  php: "PHP",
  sh: "Shell",
  sql: "SQL",
  xml: "XML",
  svg: "SVG",
  txt: "Text",
  pdf: "PDF",
  wasm: "WebAssembly",
  npm: "npm",
  docker: "Docker",
  git: "Git",
  env: "Env",
  lock: "Lockfile",
  make: "Make",
  image: "Image",
  video: "Video",
  audio: "Audio",
  zip: "Archive",
  font: "Font",
  config: "Config",
  doc: "File",
};

export function fileKindLabel(path: string): string {
  return KIND_LABEL[fileIconKind(path)] ?? "File";
}

export function fileFolderLabel(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length < 2) return "";
  return parts.slice(0, -1).join("/");
}

export function formatFileBytes(n: number): string {
  const value = Math.max(0, Math.floor(n));
  if (value < 1000) return `${value} B`;
  if (value < 10_000) {
    const compact = (value / 1000).toFixed(1);
    return `${compact.endsWith(".0") ? compact.slice(0, -2) : compact} KB`;
  }
  if (value < 1_000_000) return `${Math.round(value / 1000)} KB`;
  const compact = (value / 1_000_000).toFixed(1);
  return `${compact.endsWith(".0") ? compact.slice(0, -2) : compact} MB`;
}

export function formatLineCount(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? "line" : "lines"}`;
}

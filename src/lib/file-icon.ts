export type FileIconKind =
  | "js"
  | "jsx"
  | "ts"
  | "tsx"
  | "json"
  | "css"
  | "scss"
  | "html"
  | "md"
  | "rs"
  | "py"
  | "toml"
  | "yaml"
  | "go"
  | "vue"
  | "svelte"
  | "c"
  | "cpp"
  | "java"
  | "kt"
  | "swift"
  | "rb"
  | "php"
  | "sh"
  | "sql"
  | "xml"
  | "svg"
  | "txt"
  | "pdf"
  | "wasm"
  | "npm"
  | "docker"
  | "git"
  | "env"
  | "lock"
  | "make"
  | "image"
  | "video"
  | "audio"
  | "zip"
  | "font"
  | "config"
  | "doc";

const SPECIAL_NAMES: Record<string, FileIconKind> = {
  "package.json": "npm",
  "package-lock.json": "lock",
  "npm-shrinkwrap.json": "lock",
  "pnpm-lock.yaml": "lock",
  "yarn.lock": "lock",
  "bun.lock": "lock",
  "bun.lockb": "lock",
  "cargo.toml": "rs",
  "cargo.lock": "lock",
  "go.mod": "go",
  "go.sum": "go",
  dockerfile: "docker",
  "dockerfile.dev": "docker",
  "dockerfile.prod": "docker",
  "docker-compose.yml": "docker",
  "docker-compose.yaml": "docker",
  "compose.yml": "docker",
  "compose.yaml": "docker",
  makefile: "make",
  gnumakefile: "make",
  "tsconfig.json": "ts",
  "jsconfig.json": "js",
  ".gitignore": "git",
  ".gitattributes": "git",
  ".gitmodules": "git",
  ".gitkeep": "git",
  ".dockerignore": "docker",
  ".editorconfig": "config",
  ".npmrc": "npm",
  ".nvmrc": "npm",
  license: "txt",
  "license.txt": "txt",
  "license.md": "md",
  copying: "txt",
  authors: "txt",
  changelog: "md",
  "changelog.md": "md",
  readme: "md",
  "readme.md": "md",
  "readme.txt": "txt",
  "agents.md": "md",
};

const EXTENSIONS: Record<string, FileIconKind> = {
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "jsx",
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "tsx",
  json: "json",
  jsonc: "json",
  json5: "json",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "css",
  html: "html",
  htm: "html",
  md: "md",
  mdx: "md",
  markdown: "md",
  rs: "rs",
  py: "py",
  pyw: "py",
  pyi: "py",
  toml: "toml",
  yml: "yaml",
  yaml: "yaml",
  go: "go",
  vue: "vue",
  svelte: "svelte",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  java: "java",
  kt: "kt",
  kts: "kt",
  swift: "swift",
  rb: "rb",
  erb: "rb",
  php: "php",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  fish: "sh",
  ps1: "sh",
  sql: "sql",
  xml: "xml",
  svg: "svg",
  txt: "txt",
  log: "txt",
  pdf: "pdf",
  wasm: "wasm",
  lock: "lock",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  ico: "image",
  bmp: "image",
  avif: "image",
  jfif: "image",
  apng: "image",
  heic: "image",
  heif: "image",
  mp4: "video",
  m4v: "video",
  webm: "video",
  ogv: "video",
  mov: "video",
  mkv: "video",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  flac: "audio",
  zip: "zip",
  tar: "zip",
  gz: "zip",
  tgz: "zip",
  rar: "zip",
  "7z": "zip",
  woff: "font",
  woff2: "font",
  ttf: "font",
  otf: "font",
  ini: "config",
  cfg: "config",
  conf: "config",
  env: "env",
};

export function fileBaseName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

export function fileIconKind(path: string): FileIconKind {
  const name = fileBaseName(path);
  const lower = name.toLowerCase();

  const special = SPECIAL_NAMES[lower];
  if (special) return special;

  if (lower.startsWith(".env")) return "env";
  if (lower.startsWith("tsconfig") && lower.endsWith(".json")) return "ts";
  if (lower.startsWith("dockerfile")) return "docker";
  if (lower.startsWith("readme.")) return "md";
  if (lower.startsWith("docker-compose.")) return "docker";

  const dot = lower.lastIndexOf(".");
  if (dot > 0) {
    const ext = lower.slice(dot + 1);
    const kind = EXTENSIONS[ext];
    if (kind) return kind;
  }

  return "doc";
}

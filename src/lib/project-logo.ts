/** A file the sidebar can paint in place of the project folder. */
export type ProjectLogoFile = { path: string; name?: string; modified?: number | null };

/** Direct children of the project that may hold the icon. */
const TOP_LOGO_DIRS = ["public", "static", "assets", "images", "img", "app", "src"] as const;

/** One level under those. Next.js keeps its icon in `app` or `src/app`. */
const NESTED_LOGO_DIRS = ["src/app", "src/assets", "app/public"] as const;

const TOP_LOGO_DIR_SET = new Set<string>(TOP_LOGO_DIRS);
const NESTED_LOGO_DIR_SET = new Set<string>(NESTED_LOGO_DIRS);
const LOGO_DIRS = new Set<string>(["", ...TOP_LOGO_DIRS, ...NESTED_LOGO_DIRS]);

const DIR_RANK: Record<string, number> = {
  "": 0,
  public: 1,
  static: 2,
  app: 3,
  "app/public": 4,
  "src/app": 5,
  assets: 6,
  "src/assets": 7,
  images: 8,
  img: 9,
  src: 10,
};

const FAVICON_RANK: Record<string, number> = {
  "favicon.ico": 0,
  "favicon.png": 1,
  "favicon.svg": 2,
  "favicon.jpg": 3,
  "favicon.jpeg": 4,
  "favicon.webp": 5,
  "favicon.gif": 6,
};

const LOGO_RANK: Record<string, number> = {
  "logo.svg": 0,
  "logo.png": 1,
  "logo.jpg": 2,
  "logo.jpeg": 3,
  "logo.webp": 4,
  "logo.gif": 5,
  "logo.avif": 6,
  "icon.svg": 7,
  "icon.png": 8,
  "icon.jpg": 9,
  "icon.jpeg": 10,
  "icon.webp": 11,
  "icon.gif": 12,
  "icon.avif": 13,
  "app-icon.png": 14,
  "app-icon.svg": 15,
  "apple-touch-icon.png": 16,
  "apple-touch-icon.svg": 17,
  "apple-icon.png": 18,
  "apple-icon.svg": 19,
};

type LogoEntry = { path: string; kind: string };

function slashPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/**
 * Logo folders sitting directly in the project. The original path is kept so
 * the listing can open that folder on a case-sensitive disk.
 */
export function rootLogoDirs(entries: LogoEntry[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "dir") {
      const path = slashPath(entry.path);
      if (!path || path.includes("/") || seen.has(path.toLowerCase())) continue;
      if (!TOP_LOGO_DIR_SET.has(path.toLowerCase())) continue;
      seen.add(path.toLowerCase());
      found.push(path);
    }
  }
  return found;
}

/** `src/app` and the other second-level folders. Deeper paths are not walked. */
export function nestedLogoDirs(entries: LogoEntry[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "dir") {
      const path = slashPath(entry.path);
      const key = path.toLowerCase();
      if (!NESTED_LOGO_DIR_SET.has(key) || seen.has(key)) continue;
      seen.add(key);
      found.push(path);
    }
  }
  return found;
}

type Best = { path: string; favicon: boolean; depth: number; rank: number; dirRank: number };

function better(next: Best, prev: Best): boolean {
  if (next.favicon !== prev.favicon) return next.favicon;
  if (next.depth !== prev.depth) return next.depth < prev.depth;
  if (next.rank !== prev.rank) return next.rank < prev.rank;
  return next.dirRank < prev.dirRank;
}

/**
 * The image to show for a project.
 * A favicon wins, including one under public, app, or src/app.
 * Other logo and icon images are used only when no favicon is there.
 * A shallower file wins. Anything outside those folders is ignored.
 */
export function pickProjectLogo(files: ProjectLogoFile[]): string | null {
  let best: Best | null = null;
  for (const file of files) {
    const path = slashPath(file.path);
    if (!path) continue;
    const slash = path.lastIndexOf("/");
    const dir = slash < 0 ? "" : path.slice(0, slash).toLowerCase();
    if (!LOGO_DIRS.has(dir)) continue;
    const name = slashPath(file.name ?? path).split("/").pop()?.toLowerCase() ?? "";
    const faviconRank = FAVICON_RANK[name];
    const logoRank = faviconRank === undefined ? LOGO_RANK[name] : undefined;
    if (faviconRank === undefined && logoRank === undefined) continue;
    const next: Best = {
      path,
      favicon: faviconRank !== undefined,
      depth: slash < 0 ? 0 : path.split("/").length - 1,
      rank: faviconRank ?? logoRank ?? 0,
      dirRank: DIR_RANK[dir] ?? 100,
    };
    if (!best || better(next, best)) best = next;
  }
  return best?.path ?? null;
}

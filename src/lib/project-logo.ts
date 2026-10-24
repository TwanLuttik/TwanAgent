/** A file the sidebar can paint in place of the project folder. */
export type ProjectLogoFile = { path: string; name?: string };

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
};

/**
 * The image to show for a project.
 * A favicon wins. Other logo and icon images are used only when no favicon is there.
 * Nested files are ignored. Nothing here means the folder glyph stays.
 */
export function pickProjectLogo(files: ProjectLogoFile[]): string | null {
  let favicon: { path: string; rank: number } | null = null;
  let logo: { path: string; rank: number } | null = null;
  for (const file of files) {
    const path = file.path.replace(/\\/g, "/");
    if (!path || path.includes("/")) continue;
    const name = (file.name ?? path).replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
    const faviconRank = FAVICON_RANK[name];
    if (faviconRank !== undefined && (!favicon || faviconRank < favicon.rank)) {
      favicon = { path, rank: faviconRank };
      continue;
    }
    const logoRank = LOGO_RANK[name];
    if (logoRank !== undefined && (!logo || logoRank < logo.rank)) {
      logo = { path, rank: logoRank };
    }
  }
  return favicon?.path ?? logo?.path ?? null;
}

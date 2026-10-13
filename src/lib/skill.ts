export type SkillOrigin = "project" | "user" | "plugin" | "bundled" | "claude" | "cursor";

export type DetectedSkill = {
  name: string;
  source: string;
  origin: SkillOrigin;
  description: string;
  enabled: boolean;
};

export const VENDOR_SKILL_NAMES = new Set(["shell", "canvas", "statusline"]);

export type SkillFileInput = {
  source: string;
  origin: SkillOrigin;
  contents: string;
};

export function skillFallbackName(source: string): string {
  const normalized = source.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = normalized.split("/").pop() || "";
  const stem = base.replace(/\.md$/i, "");
  if (stem && stem.toLowerCase() !== "skill") return normalizeSkillName(stem);
  const parent = normalized.split("/").slice(0, -1).pop() || "";
  return normalizeSkillName(parent);
}

export function normalizeSkillName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

export function skillNameOk(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
}

export function parseSkillMd(source: string, contents: string, fallbackName: string): DetectedSkill | null {
  const text = contents.trim();
  if (!text) return null;
  const origin = originFromSource(source);
  const matter = parseFrontmatter(text);
  const name = normalizeSkillName(String(matter.name ?? fallbackName ?? skillFallbackName(source)));
  if (!name || !skillNameOk(name)) return null;
  if (VENDOR_SKILL_NAMES.has(name)) return null;
  const description = String(matter.description ?? firstParagraph(stripFrontmatter(text))).trim();
  return { name, source, origin, description, enabled: true };
}

/** A row for the skills pill. The file is not read until Edit opens it. */
export function skillFromPath(source: string, origin: SkillOrigin): DetectedSkill | null {
  const name = skillFallbackName(source);
  if (!name || !skillNameOk(name) || VENDOR_SKILL_NAMES.has(name)) return null;
  return { name, source, origin: origin || originFromSource(source), description: "", enabled: true };
}

export function detectSkills(files: SkillFileInput[], grokToml?: string | null): DetectedSkill[] {
  const disabled = new Set(parseSkillsDisabled(grokToml ?? ""));
  const seen = new Set<string>();
  const out: DetectedSkill[] = [];
  for (const file of files) {
    const parsed = file.contents.trim()
      ? parseSkillMd(file.source, file.contents, skillFallbackName(file.source))
      : skillFromPath(file.source, file.origin);
    if (!parsed) continue;
    const skill = { ...parsed, origin: file.origin || parsed.origin };
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    out.push({ ...skill, enabled: !disabled.has(skill.name) });
  }
  return out;
}

export function parseSkillsDisabled(contents: string): string[] {
  return parseTomlTableArray(contents, "skills", "disabled");
}

export function setSkillEnabledInToml(contents: string, name: string, enabled: boolean): string {
  if (!skillNameOk(name)) return contents;
  const names = parseSkillsDisabled(contents);
  const has = names.includes(name);
  if (enabled === !has) return contents;
  const next = enabled ? names.filter((row) => row !== name) : [...names, name];
  return rewriteTomlTableArray(contents, "skills", "disabled", next);
}

export function skillPillSummary(skills: DetectedSkill[]): string {
  if (skills.length === 0) return "";
  const on = skills.filter((row) => row.enabled);
  if (on.length === 1 && on.length === skills.length) return `Skills · ${on[0].name}`;
  return `Skills · ${on.length}/${skills.length}`;
}

export function skillSystemLine(skills: DetectedSkill[]): string {
  if (skills.length === 0) return "";
  const on = skills.filter((row) => row.enabled);
  const off = skills.length - on.length;
  const list = on.map((row) => row.name).join(", ");
  const disabled = off ? ` ${off} disabled.` : "";
  return `This workspace has skills (not auto-loaded): ${list || "none enabled."}${disabled} You cannot invoke them as slash commands here. You may discuss them or help edit their SKILL.md files.`;
}

export function userSkillRel(source: string): string | null {
  if (source.startsWith("~/")) return source.slice(2);
  return null;
}

export function parseSkillOrigin(raw: string, source: string): SkillOrigin {
  switch (raw) {
    case "project":
    case "user":
    case "plugin":
    case "bundled":
    case "claude":
    case "cursor":
      return raw;
    default:
      return originFromSource(source);
  }
}

export function originFromSource(source: string): SkillOrigin {
  const path = source.replace(/\\/g, "/");
  if (path.includes("/installed-plugins/")) return "plugin";
  if (path.includes("/bundled/skills/")) return "bundled";
  if (path.includes("/.cursor/")) return "cursor";
  if (path.includes("/.claude/")) return "claude";
  if (path.startsWith("~/") || path.startsWith("/")) return "user";
  return "project";
}

function parseFrontmatter(contents: string): Record<string, string> {
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return {};
  const out: Record<string, string> = {};
  let key = "";
  let folded = "";
  for (const raw of match[1].split(/\r?\n/)) {
    const block = raw.match(/^([A-Za-z0-9_-]+):\s*[|>]\s*$/);
    if (block) {
      if (key) out[key] = folded.trim();
      key = block[1];
      folded = "";
      continue;
    }
    if (key && /^\s+/.test(raw)) {
      folded += (folded ? " " : "") + raw.trim();
      continue;
    }
    if (key) {
      out[key] = folded.trim();
      key = "";
      folded = "";
    }
    const line = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!line) continue;
    out[line[1]] = stripQuotes(line[2].trim());
  }
  if (key) out[key] = folded.trim();
  return out;
}

function stripFrontmatter(contents: string): string {
  return contents.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function firstParagraph(body: string): string {
  const block = body
    .replace(/^#+\s+.+$/m, "")
    .split(/\n\s*\n/)
    .map((part) => part.replace(/^#+\s+/, "").trim())
    .find((part) => part.length > 0);
  return block ?? "";
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseTomlTableArray(contents: string, table: string, key: string): string[] {
  const section = tomlTable(contents, table);
  if (!section) return [];
  const block = section.match(new RegExp(`${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  if (!block?.[1]) return [];
  const names: string[] = [];
  for (const match of block[1].matchAll(/"([^"]+)"|'([^']+)'/g)) {
    const name = (match[1] ?? match[2] ?? "").trim();
    if (name) names.push(name);
  }
  return names;
}

function rewriteTomlTableArray(contents: string, table: string, key: string, values: string[]): string {
  const header = new RegExp(`^\\[${table}\\]\\s*$`, "m");
  const start = contents.search(header);
  const block = formatTomlArray(key, values);
  if (start < 0) {
    const pad = contents.length === 0 || contents.endsWith("\n") ? "" : "\n";
    return `${contents}${pad}\n[${table}]\n${block}\n`;
  }
  const rest = contents.slice(start);
  const nextHeader = rest.slice(1).search(/\n\[/);
  const section = nextHeader >= 0 ? rest.slice(0, nextHeader + 1) : rest;
  const tail = nextHeader >= 0 ? rest.slice(nextHeader + 1) : "";
  const existing = section.match(new RegExp(`${key}\\s*=\\s*\\[[\\s\\S]*?\\]`));
  if (existing && existing.index != null) {
    const updated = section.slice(0, existing.index) + block + section.slice(existing.index + existing[0].length);
    return contents.slice(0, start) + updated + tail;
  }
  const insertAt = section.indexOf("\n");
  const updated =
    insertAt >= 0
      ? `${section.slice(0, insertAt + 1)}${block}\n${section.slice(insertAt + 1)}`
      : `${section}\n${block}\n`;
  return contents.slice(0, start) + updated + tail;
}

function formatTomlArray(key: string, values: string[]): string {
  if (values.length === 0) return `${key} = []`;
  return `${key} = [\n${values.map((name) => `  "${name}"`).join(",\n")}\n]`;
}

function tomlTable(contents: string, table: string): string | null {
  const header = new RegExp(`^\\[${table}\\]\\s*$`, "m");
  const start = contents.search(header);
  if (start < 0) return null;
  const rest = contents.slice(start);
  const nextHeader = rest.slice(1).search(/\n\[/);
  return nextHeader >= 0 ? rest.slice(0, nextHeader + 1) : rest;
}

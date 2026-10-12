import { execFileSync } from "node:child_process";
import { readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const bundleDir = join(root, "src-tauri/target/release/bundle");
const build = gitBuildId();

let renamed = 0;
for (const file of walk(bundleDir)) {
  const slash = file.lastIndexOf("/");
  const dir = file.slice(0, slash);
  const name = file.slice(slash + 1);
  if (!name.startsWith("TwanAgent_") || name.includes("+")) continue;
  const next = name.replace(/^(TwanAgent_.+?)(_[^_]+)$/, `$1+${build}$2`);
  if (next === name) continue;
  renameSync(file, join(dir, next));
  console.log(`${name} -> ${next}`);
  renamed += 1;
}

if (renamed === 0) {
  console.log("No bundle files to rename.");
}

function walk(dir) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

function gitBuildId() {
  try {
    const hash = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (/^[0-9a-f]{7,}$/i.test(hash)) return hash;
  } catch {
    /* not a git checkout */
  }
  return "dev";
}

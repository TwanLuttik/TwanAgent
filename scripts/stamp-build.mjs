import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const build = gitBuildId();
const label = `${version}+${build}`;

writeFileSync(
  new URL("../src/build-stamp.ts", import.meta.url),
  `export const APP_VERSION = ${JSON.stringify(version)};\nexport const APP_BUILD = ${JSON.stringify(build)};\nexport const APP_VERSION_LABEL = ${JSON.stringify(label)};\n`,
);

console.log(label);

// Short commit id, like `af4395`. A build outside a git checkout still gets a stamp.
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
  return randomBytes(3).toString("hex");
}

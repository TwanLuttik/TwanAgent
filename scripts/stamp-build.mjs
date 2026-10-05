import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const build = randomBytes(3).toString("hex");
const label = `${version}+${build}`;

writeFileSync(
  new URL("../src/build-stamp.ts", import.meta.url),
  `export const APP_VERSION = ${JSON.stringify(version)};\nexport const APP_BUILD = ${JSON.stringify(build)};\nexport const APP_VERSION_LABEL = ${JSON.stringify(label)};\n`,
);

console.log(label);

const WEB_TLDS = new Set(
  "com org net io ai app dev co ca uk us edu gov info biz me tv xyz gg ly it de fr nl se no fi es au nz jp kr in br mx za ie eu ch at be dk cz pt gl is int design cloud page site online store tech blog wiki news media software group world pro link email run pub host vc im pm id to".split(
    " ",
  ),
);

const BARE_URL =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?::\d{2,5})?(?:\/[^\s<>]*)?/i;

/**
 * Wrap bare domains such as quickbooks.intuit.com/path in autolinks.
 * Code, existing links, and filenames stay as they are.
 */
export function linkifyBareUrls(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const fence = fenceEnd(input, i);
    if (fence > i) {
      out += input.slice(i, fence);
      i = fence;
      continue;
    }
    const code = inlineCodeEnd(input, i);
    if (code > i) {
      out += input.slice(i, code);
      i = code;
      continue;
    }
    const link = markdownLinkEnd(input, i);
    if (link > i) {
      out += input.slice(i, link);
      i = link;
      continue;
    }
    const auto = autolinkEnd(input, i);
    if (auto > i) {
      out += input.slice(i, auto);
      i = auto;
      continue;
    }
    const found = matchBareUrl(input, i);
    if (found) {
      out += `<https://${found.core}>${found.rest}`;
      i += found.rawLength;
      continue;
    }
    out += input[i];
    i++;
  }
  return out;
}

/** When the link text is the URL itself, drop the scheme for display. */
export function bareUrlLabel(href: string, text: string): string | null {
  const strip = (value: string) => value.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const left = strip(text);
  const right = strip(href);
  if (!left || !right || left !== right) return null;
  return right;
}

function matchBareUrl(input: string, i: number): { core: string; rest: string; rawLength: number } | null {
  if (i > 0 && /[\w@./-]/.test(input[i - 1] ?? "")) return null;
  const raw = BARE_URL.exec(input.slice(i))?.[0];
  if (!raw) return null;
  const { core, rest } = trimTail(raw);
  if (!core || !knownHost(hostOf(core))) return null;
  return { core, rest, rawLength: raw.length };
}

function hostOf(core: string): string {
  return (core.split("/")[0] ?? "").replace(/:\d+$/, "");
}

function knownHost(host: string): boolean {
  const name = host.toLowerCase();
  const labels = name.split(".");
  if (labels.length < 2) return false;
  if (labels.some((label) => label.length === 0 || label.length > 63)) return false;
  const tld = labels[labels.length - 1];
  return Boolean(tld && WEB_TLDS.has(tld));
}

function trimTail(raw: string): { core: string; rest: string } {
  let end = raw.length;
  while (end > 0) {
    const ch = raw[end - 1] ?? "";
    if (",.;:!?\"'”’".includes(ch)) {
      end--;
      continue;
    }
    const balanced =
      (ch === ")" && raw.slice(0, end).includes("(")) || (ch === "]" && raw.slice(0, end).includes("["));
    if ((ch === ")" || ch === "]") && !balanced) {
      end--;
      continue;
    }
    break;
  }
  return { core: raw.slice(0, end), rest: raw.slice(end) };
}

function fenceEnd(input: string, i: number): number {
  if (i > 0 && input[i - 1] !== "\n") return i;
  let j = i;
  let indent = 0;
  while (input[j] === " " && indent < 4) {
    j++;
    indent++;
  }
  if (indent > 3) return i;
  const marker = input[j];
  if (marker !== "`" && marker !== "~") return i;
  let count = 0;
  while (input[j + count] === marker) count++;
  if (count < 3) return i;
  j += count;
  while (j < input.length && input[j] !== "\n") j++;
  if (j < input.length) j++;
  while (j < input.length) {
    const line = j;
    let spaces = 0;
    while (input[j] === " " && spaces < 4) {
      j++;
      spaces++;
    }
    if (spaces < 4) {
      let close = 0;
      while (input[j + close] === marker) close++;
      if (close >= count) {
        let k = j + close;
        while (k < input.length && (input[k] === " " || input[k] === "\t")) k++;
        if (k === input.length || input[k] === "\n") return input[k] === "\n" ? k + 1 : k;
      }
    }
    const next = input.indexOf("\n", line);
    if (next < 0) return input.length;
    j = next + 1;
  }
  return input.length;
}

function inlineCodeEnd(input: string, i: number): number {
  if (input[i] !== "`") return i;
  let ticks = 0;
  while (input[i + ticks] === "`") ticks++;
  let k = i + ticks;
  while (k < input.length) {
    if (input[k] !== "`") {
      k++;
      continue;
    }
    let count = 0;
    while (input[k + count] === "`") count++;
    if (count === ticks) return k + count;
    k += count;
  }
  return i;
}

function autolinkEnd(input: string, i: number): number {
  if (input[i] !== "<") return i;
  const match = /^<(https?:\/\/[^>\s]+)>/i.exec(input.slice(i));
  return match ? i + match[0].length : i;
}

function markdownLinkEnd(input: string, i: number): number {
  let start = i;
  if (input[start] === "!" && input[start + 1] === "[") start++;
  if (input[start] !== "[") return i;
  const labelEnd = skipWrapped(input, start, "[", "]");
  if (labelEnd < 0) return i;
  if (input[labelEnd] === "(") {
    const destEnd = skipWrapped(input, labelEnd, "(", ")");
    return destEnd < 0 ? i : destEnd;
  }
  if (input[labelEnd] === "[") {
    const refEnd = skipWrapped(input, labelEnd, "[", "]");
    return refEnd < 0 ? i : refEnd;
  }
  return i;
}

function skipWrapped(input: string, i: number, open: string, close: string): number {
  if (input[i] !== open) return -1;
  let depth = 1;
  for (let k = i + 1; k < input.length; k++) {
    const ch = input[k];
    if (ch === "\\") {
      k++;
      continue;
    }
    if (ch === "`") {
      const end = inlineCodeEnd(input, k);
      if (end > k) {
        k = end - 1;
        continue;
      }
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return k + 1;
    }
  }
  return -1;
}

/** In-app docs. The first page is the service, including how to uninstall it. */

export type DocPlatform = "mac" | "linux";

export type DocPage = {
  id: string;
  title: string;
  summary: string;
  /** Shared text. Platform steps live in `platforms` when the commands differ. */
  body: string;
  platforms?: Record<DocPlatform, string>;
};

export const DOC_PLATFORMS: { id: DocPlatform; label: string }[] = [
  { id: "mac", label: "Mac" },
  { id: "linux", label: "Linux" },
];

export const DOCS: DocPage[] = [
  {
    id: "service",
    title: "Service",
    summary: "The program that runs on a paired machine, and how to remove it.",
    body: `TwanAgent copies \`twanagent-server\` to a paired machine and starts it over SSH. The program has no window. It lives at \`~/.twanagent/bin/twanagent-server\` on that machine, not on this Mac.

The desktop app starts it when you open a project that lives there:

\`\`\`sh
~/.twanagent/bin/twanagent-server --serve --data "$HOME/.twanagent"
\`\`\`

That process binds \`127.0.0.1:8731\` and reads turns from \`~/.twanagent/serve.stdin\`. A second start leaves the first process alone. Chats for each project are stored under \`~/.twanagent/projects\`.

## What a server keeps

| Path | What it is |
| --- | --- |
| \`~/.twanagent/bin/twanagent-server\` | The program. |
| \`~/.twanagent/bin/twanagent-server.version\` | The version the last copy wrote. |
| \`~/.local/bin/twanagent-server\` | A link so a new shell can run \`twanagent-server\`. |
| \`~/.twanagent/auth-token\` | The pairing token. Mode \`0600\`. |
| \`~/.twanagent/provider-keys.json\` | Provider keys you chose to copy. Mode \`0600\`. |
| \`~/.twanagent/projects\` | One \`store.db\` per project on this machine. |
| \`~/.twanagent/live\` | The tail of a turn that is still running. |
| \`~/.twanagent/serve.stdin\` | The fifo the desktop writes frames to. |

Removing the server in TwanAgent only forgets it on this Mac. The program, the token, the keys, and the chats stay on the machine.

The program and the \`~/.twanagent\` folder are the same on a Mac and on Linux. The shell startup files are not, so the uninstall steps below follow the machine you are removing it from.
`,
    platforms: {
      mac: `## Uninstall on a Mac

SSH to that Mac, or open Terminal there. macOS remembers the full process name, so find it and stop it by that name. You do not need the PID.

\`\`\`sh
pgrep -lx twanagent-server
killall twanagent-server
rm -f "$HOME/.local/bin/twanagent-server"
rm -rf "$HOME/.twanagent"
\`\`\`

\`pgrep -l\` prints the running copy and its name. \`killall\` stops every process with that name. \`killall\` exits with an error when nothing is running, which is fine.

From this Mac, for a machine you already sign in to:

\`\`\`sh
ssh <user>@<host> 'killall twanagent-server; rm -f "$HOME/.local/bin/twanagent-server"; rm -rf "$HOME/.twanagent"'
\`\`\`

Check that it is gone:

\`\`\`sh
ssh <user>@<host> 'test ! -e "$HOME/.twanagent" && echo uninstalled'
\`\`\`

The install may have added \`~/.local/bin\` to \`~/.zshrc\` and \`~/.zprofile\`. Leave those lines if other tools use that folder. Otherwise remove the line \`export PATH="$HOME/.local/bin:$PATH"\`:

\`\`\`sh
sed -i '' '/\\.local\\/bin/d' "$HOME/.zshrc" "$HOME/.zprofile"
\`\`\`

Then open Servers in the sidebar and choose Remove on that row. Remove does not delete the remote files. Run the commands above first if the program should actually leave the Mac.

## What this does not remove

- The project folders. Chats are not stored inside them.
- The SSH login, the trusted host key, and provider keys saved on this Mac.
- Remote Login. Turn that off in System Settings if you no longer want SSH.

Deleting \`~/.twanagent\` deletes the conversations stored on that Mac. Copy \`~/.twanagent/projects\` first if you still want them.
`,
      linux: `## Uninstall on Linux

SSH to the machine. Linux keeps only the first 15 characters of a process name, and \`twanagent-server\` is longer than that, so a match on the process name misses it. Match the program path instead. You do not need the PID.

\`\`\`sh
pgrep -af /twanagent-server
pkill -f '[/]twanagent-server'
rm -f "$HOME/.local/bin/twanagent-server"
rm -rf "$HOME/.twanagent"
\`\`\`

\`pgrep -af\` prints the running copy and its path. \`pkill -f\` stops every process whose path contains \`/twanagent-server\`. The brackets keep \`pkill\` from matching its own command. \`pkill\` exits with an error when nothing is running, which is fine.

From this Mac, for a machine you already sign in to:

\`\`\`sh
ssh <user>@<host> 'pkill -f "[/]twanagent-server"; rm -f "$HOME/.local/bin/twanagent-server"; rm -rf "$HOME/.twanagent"'
\`\`\`

For an OrbStack machine, \`<host>\` is \`<machine>@orb\`. The VM's bridge address is not reachable from the Mac.

Check that it is gone:

\`\`\`sh
ssh <user>@<host> 'test ! -e "$HOME/.twanagent" && echo uninstalled'
\`\`\`

The install may have added \`~/.local/bin\` to \`~/.bashrc\`, \`~/.profile\`, and \`~/.zshrc\`. Leave those lines if other tools use that folder. Otherwise remove the line \`export PATH="$HOME/.local/bin:$PATH"\`:

\`\`\`sh
sed -i '/\\.local\\/bin/d' "$HOME/.bashrc" "$HOME/.profile" "$HOME/.zshrc"
\`\`\`

Then open Servers in the sidebar and choose Remove on that row. Remove does not delete the remote files. Run the commands above first if the program should actually leave the machine.

## What this does not remove

- The project folders. Chats are not stored inside them.
- The SSH login, the trusted host key, and provider keys saved on this Mac.

Deleting \`~/.twanagent\` deletes the conversations stored on that machine. Copy \`~/.twanagent/projects\` first if you still want them.
`,
    },
  },
];

export function docById(id: string): DocPage | undefined {
  return DOCS.find((page) => page.id === id);
}

/** Shared page text, then the steps for one server platform. */
export function docBody(page: DocPage, platform: DocPlatform): string {
  const steps = page.platforms?.[platform];
  if (!steps) return page.body;
  return `${page.body.trim()}\n\n${steps.trim()}\n`;
}

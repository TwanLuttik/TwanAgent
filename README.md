# TwanAgent

TwanAgent is a desktop IDE where a coding agent works in your project with you. Open a folder, talk to Grok or Claude, and watch it read files, edit code, run commands, and search the web. The chat, the editor, and the terminal stay in one window.

It runs on macOS, Linux, and Windows.

## What you can do

- **Chat with an agent in the project.** Each conversation keeps its own model, thinking level, context size, and permission mode. Switch models before the first message of a new chat.
- **Edit the codebase.** The agent reads, writes, and patches files. You can open the same files in the built-in editor, preview Markdown, and inspect images and video.
- **Review git changes.** See status, diffs, branches, and the lines a change added or removed.
- **Run a terminal.** Keep a shell or a Grok terminal next to the chat. Commands the agent wants to run can wait for your approval.
- **Work across projects.** The sidebar holds local folders and archived chats.
- **Open a project on another machine.** Connect over SSH, browse the remote folder, and run the agent's commands there.
- **Queue the next message.** Send a follow-up while a reply is still streaming. Dictate into the composer, attach images, and mention files with `@`.
- **See what the turn cost.** Usage is estimated per model, including Claude and Grok rates.

## Models

| Provider | How you sign in | Models |
| --- | --- | --- |
| xAI Grok | [Grok CLI](https://x.ai/cli) (`grok login`) or an xAI API key in Settings | The Grok models reported by the CLI |
| Anthropic Claude | `claude login` or an Anthropic API key in Settings | The Claude models that account can use |

Keys stay in the system keychain. A chat uses the provider of the model you picked.

## What the agent can use

In a chat the agent can list and read files, write and edit them, check git, run a shell command, search the web, keep a short task list, and hand a piece of work to a subagent. You choose whether it asks before running a command, runs freely, or stays read-only.

MCP servers and skills discovered in the project or in your home config can be turned on from Settings.

## Develop

Setup, tests, and release builds are in [DEVELOPMENT.md](DEVELOPMENT.md). macOS signing is in [docs/signing.md](docs/signing.md).

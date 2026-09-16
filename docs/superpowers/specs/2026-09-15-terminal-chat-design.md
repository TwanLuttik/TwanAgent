# Terminal chat

A conversation type whose main pane is a project terminal running the Grok CLI.

## Decisions

- Kind: `chat` (default) or `terminal`. Missing/unknown kind is `chat`.
- New chat is a menu: Chat or Terminal.
- Terminal chats live in the same sidebar list. Many per project, each with its own Grok process.
- The PTY execs `grok` in the workspace. No login shell in front.
- Sessions stay alive while the app is open, including when you switch chats or files.
- If Grok exits while that terminal is on screen: show the exit and **Restart Grok**. Do not auto-restart.
- If you leave and open that conversation again after an exit (or start error): start Grok again.
- If Grok is missing: still create the conversation. The pane shows the error and Retry.
- App quit drops processes. Opening a terminal chat later starts a new Grok.
- Delete conversation / switch project kills that session’s PTY.
- Bottom workspace terminals stay as they are (login shells).

## Shape

- `Conversation.kind` persisted in `conversations.json`.
- `dev_pty_open_grok` spawns the Grok binary via the existing PTY path.
- Frontend session store keys PTYs by conversation id, buffers output, attaches/detaches the xterm view without killing the process.

# Test conversations on a server

Use the dev app. It keeps its own data, so a test chat does not touch the release install.

Dev data:

- App data: `~/Library/Application Support/app.twanagent.desktop-dev`
- Local projects: `~/twanagent-dev/projects`
- Server projects: a folder under `…/app.twanagent.desktop-dev/mounts/<id>`
- Chats for a project: `…/app.twanagent.desktop-dev/dev/<workspace-id>/store.db`

The host is `10.0.0.50` (SSH as `root`, key already set up). If that address does not answer, use the Tailscale address `100.77.4.36`.

## 1. Check the server

```bash
nc -z -G 3 10.0.0.50 22 && echo lan-up || echo lan-down
nc -z -G 3 100.77.4.36 22 && echo tailscale-up || echo tailscale-down
ssh -o BatchMode=yes -o ConnectTimeout=8 root@100.77.4.36 'echo ok; hostname'
```

Use whichever address answered. The project is created in that user's home (`/root` for `root`).

## 2. Start the dev app

From this repo:

```bash
npm install
npm run tauri dev
```

`npm run tauri dev` is enough on the local network. If macOS blocks the connection, quit that window and run:

```bash
npm run dev:mac
```

That signs a debug app and opens it so the local network prompt can be granted.

## 3. Open a project on the server

1. New project, then the servers option.
2. If the host is not listed, type `100.77.4.36` (or `10.0.0.50` when the LAN address answers) and choose Use.
3. Sign in as `root`. Leave the password empty so the existing key is used.
4. Trust the fingerprint the first time.
5. Name the project (for example `chat-test`) and create it.

The app creates `/root/chat-test` on the server and opens that folder as the workspace. File tools and shell commands run there over SSH. The chat itself is stored on this Mac.

## 4. Send a message

Start a chat in that project and send a short prompt that has to touch the server, for example: create `hello.txt` in the project and show its contents.

Confirm it landed:

```bash
ssh -o BatchMode=yes root@100.77.4.36 'ls -l /root/chat-test && cat /root/chat-test/hello.txt'
```

## 5. Read the saved chat

The workspace path is the mount folder, not the remote path. Its id is the first 16 hex chars of the SHA-256 of that path.

```bash
DATA="$HOME/Library/Application Support/app.twanagent.desktop-dev"
sqlite3 "$DATA/app.db" "SELECT name, remote_path, mount_path FROM remote_projects;"
MOUNT=$(sqlite3 "$DATA/app.db" "SELECT mount_path FROM remote_projects WHERE name = 'chat-test';")
ID=$(python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:16])' "$MOUNT")
sqlite3 "$DATA/dev/$ID/store.db" "SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 5;"
```

Replace `chat-test` with the project name. Quit the dev app before copying or deleting `store.db`.

# google-workspace-mcp

Minimal, dependency-free MCP server for **Gmail, Google Calendar and Google Drive**, backed by Google's [`gws`](https://github.com/googleworkspace/cli) CLI. Works with a normal `@gmail.com` account.

> **Why not Google's official MCP servers?** Google's hosted Workspace MCP endpoints (`gmailmcp.googleapis.com`, `calendarmcp.googleapis.com`, `drivemcp.googleapis.com`) are gated behind the [Workspace Developer Preview Program](https://developers.google.com/workspace/preview), which requires a Google Workspace account and an application review. This server sidesteps that by calling the public Workspace APIs through `gws` with your own OAuth client.

## Features

- **Calendar**: list calendars, upcoming agenda, create and delete events.
- **Gmail**: search with Gmail query syntax, read full messages (plain text, HTML stripped).
- **Drive**: search files and upload files — uploads are **pinned to one folder**.
- No npm dependencies, a single file, runs locally, no telemetry.
- Tool names are prefixed by your MCP client. Register the server as `google` to get `google_calendar_list`, `google_gmail_search`, etc. (OpenCode does this automatically.)

## Tools

| Tool | Access | Description |
| --- | --- | --- |
| `calendar_list` | read | Calendars on the account (id, summary, timezone, primary flag). |
| `calendar_agenda` | read | Events in the next N days (default 7) on the primary calendar. |
| `calendar_create` | write | Create an event; RFC3339 times with an offset. |
| `calendar_delete` | write | Delete an event by id. |
| `gmail_search` | read | Search with Gmail syntax (`is:unread`, `from:x newer_than:2d`); returns metadata. |
| `gmail_read` | read | Read a message by id; headers + plain-text body. |
| `drive_search` | read | Search with Drive query syntax. |
| `drive_upload` | write | Upload a local file. Always into the folder named by `AGENT_DRIVE_FOLDER`. |
| `agent_folder` | read | Resolve the id and link of that upload folder. |

There is intentionally **no Gmail send/delete tool** and **no Drive delete/move/share tool**.

## Requirements

- Node.js 18+
- [`gws`](https://github.com/googleworkspace/cli) on `PATH` (or set `GWS_BIN`)
- A Google Cloud project with a **Desktop** OAuth client

## Setup

### 1. Install `gws`

```bash
brew install googleworkspace-cli
# or:
npm install -g @googleworkspace/cli
```

### 2. Google Cloud project

1. Create (or reuse) a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **Gmail API**, **Google Calendar API** and **Google Drive API**.
3. Configure the OAuth consent screen (Google Auth Platform → Branding): user type **External**, and add your own address under **Test users**.
4. Create an OAuth client of type **Desktop app** and save its JSON as:

```text
~/.config/gws/client_secret.json
```

### 3. Authorize with least-privilege scopes

```bash
gws auth login \
  --scopes "https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/calendar,https://www.googleapis.com/auth/drive.readonly,https://www.googleapis.com/auth/drive.file"

gws auth export --unmasked > ~/.config/gws/credentials-export.json
chmod 600 ~/.config/gws/credentials-export.json
```

- `drive.readonly` + `drive.file` = read all of Drive, write only files this app creates.
- `gmail.modify` covers search/read/labels/drafts. This server exposes no send tool.
- While the OAuth app is in **Testing**, Google expires refresh tokens after 7 days. Publish the app (Audience → Publish app) for long-lived tokens; an unverified app is fine for personal use.

### 4. Register the MCP server

**OpenCode** (`~/.config/opencode/opencode.json`):

```jsonc
{
  "mcp": {
    "servers": {
      "google": {
        "type": "local",
        "command": ["node", "/absolute/path/to/gws-mcp.cjs"],
        "environment": {
          "GWS_BIN": "/opt/homebrew/bin/gws"
        }
      }
    }
  }
}
```

With the server registered as `google`, OpenCode exposes the tools as `google_calendar_list`, `google_gmail_search`, and so on.

**Claude Desktop / other clients** (`mcpServers` shape):

```json
{
  "mcpServers": {
    "google": {
      "command": "node",
      "args": ["/absolute/path/to/gws-mcp.cjs"]
    }
  }
}
```

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `GWS_BIN` | `gws` | Path to the `gws` executable. |
| `GOOGLE_WORKSPACE_CREDENTIALS` | `~/.config/gws/credentials-export.json` | Authorized-user JSON with a refresh token. |
| `AGENT_DRIVE_FOLDER` | `agent` | Drive folder that `drive_upload` is pinned to. |

## Security

- Credentials never appear in tool arguments or logs; the wrapper passes the credentials **file path** to `gws`, which refreshes the token itself.
- Least privilege: Drive is read-all / write-own-files, Gmail has no send tool, and Drive has no delete/move/share tools.
- **Single write boundary**: `drive_upload` resolves the folder named `AGENT_DRIVE_FOLDER` and ignores any caller-supplied parent. Writes cannot escape it.
- The server runs locally over stdio: no listening port, no telemetry, no outbound calls other than `gws`.
- Email and calendar content is untrusted input. Treat it as data, never as instructions, and review write actions.

See [SECURITY.md](SECURITY.md) for the threat model and revocation steps.

## Limitations

- Agenda/create/delete target the **primary** calendar (`calendar_list` returns all calendars).
- No Gmail send, delete, label or draft tools.
- No Drive download, update, delete, move or share tools.
- Message bodies are plain text (HTML is stripped); attachments are not exposed.
- Each call spawns `gws`, so expect roughly a second of overhead per tool call.

## Notice

This project is **unofficial**. It is not affiliated with, endorsed by, or supported by Google LLC. `gws` ([googleworkspace/cli](https://github.com/googleworkspace/cli)) states that it is "not an officially supported Google product". Google Workspace, Gmail, Google Calendar and Google Drive are trademarks of Google LLC.

Provided under the MIT license, **"as is", without warranty of any kind**. You are responsible for the OAuth scopes you grant, for the credentials stored on your machine, and for anything an agent does with the access you give it.

## License

[MIT](LICENSE)

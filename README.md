# google-workspace-mcp

Minimal, dependency-free MCP server for **Gmail, Google Calendar and Google Drive**, backed by Google's [`gws`](https://github.com/googleworkspace/cli) CLI. Works with a normal `@gmail.com` account.

> **Why not Google's official MCP servers?** Google's hosted Workspace MCP endpoints (`gmailmcp.googleapis.com`, `calendarmcp.googleapis.com`, `drivemcp.googleapis.com`) are gated behind the [Workspace Developer Preview Program](https://developers.google.com/workspace/preview), which requires a Google Workspace account and an application review. This server sidesteps that by calling the public Workspace APIs through `gws` with your own OAuth client.

## Features

- **Calendar**: list calendars, upcoming agenda, create and delete events.
- **Gmail**: search with Gmail query syntax, read full messages (plain text, HTML stripped), send mail or save drafts.
- **Drive**: search files and upload files — uploads are **pinned to one folder**.
- **Multiple accounts**, each with its own credentials and an enforced capability list (e.g. send from one account, read another's calendar only).
- No npm dependencies, a single file, runs locally, no telemetry.
- Tool names are prefixed by your MCP client. Register the server as `google` to get `google_calendar_list`, `google_gmail_search`, etc. (OpenCode does this automatically.)

## Tools

| Tool | Access | Description |
| --- | --- | --- |
| `accounts` | read | Configured accounts, emails and capabilities. |
| `calendar_list` | read | Calendars on the account (id, summary, timezone, primary flag). |
| `calendar_agenda` | read | Events in the next N days (default 7) on the primary calendar. |
| `calendar_create` | write | Create an event; RFC3339 times with an offset. |
| `calendar_delete` | write | Delete an event by id. |
| `gmail_search` | read | Search with Gmail syntax (`is:unread`, `from:x newer_than:2d`); returns metadata. |
| `gmail_read` | read | Read a message by id; headers + plain-text body. |
| `gmail_send` | write | Send mail, or save a draft with `draft: true` (supports cc/bcc/html). |
| `drive_search` | read | Search with Drive query syntax. |
| `drive_upload` | write | Upload a local file. Always into the folder named by `AGENT_DRIVE_FOLDER`. |
| `agent_folder` | read | Resolve the id and link of that upload folder. |

Every tool accepts an optional `account` (default: the registry default); `gmail_send` **requires** it. See [Multiple accounts](#multiple-accounts).

There is intentionally **no Gmail delete/label tool** and **no Drive delete/move/share tool**. Sending is a deliberate, separate write tool (`gmail_send`); use `draft: true` when you want review before sending.

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
- `gmail.modify` covers search/read/labels/drafts and sending.
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

**No clone needed** — run it straight from this repository:

```jsonc
{
  "mcp": {
    "servers": {
      "google": {
        "type": "local",
        "command": ["npx", "-y", "github:Martins6/google-workspace-mcp"]
      }
    }
  }
}
```

(`npx` downloads the repo into its cache and runs the package's `bin`.)

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
| `GOOGLE_ACCOUNTS_CONFIG` | `~/.config/google-workspace-mcp/accounts.json` | Account registry (see below). |

## Multiple accounts

Each account has its own `gws` config directory, its own exported credentials, and an entry in a registry file. The server sets `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` on every call, so it can never silently fall back to a different account.

`~/.config/google-workspace-mcp/accounts.json`:

```json
{
  "default": "personal",
  "accounts": {
    "personal": {
      "email": "you@example.com",
      "configDir": "~/.config/gws/accounts/personal",
      "credentials": "~/.config/gws/accounts/personal/credentials-export.json",
      "capabilities": ["calendar.read", "calendar.write", "gmail.read", "gmail.send", "drive.read", "drive.write"]
    },
    "work": {
      "email": "you@company.com",
      "configDir": "~/.config/gws/accounts/work",
      "credentials": "~/.config/gws/accounts/work/credentials-export.json",
      "capabilities": ["calendar.read", "gmail.send"]
    }
  }
}
```

Capabilities are enforced by the server **before** spawning `gws`. An account that lacks one gets a clear error instead of a partial action.

| Capability | Tools |
| --- | --- |
| `calendar.read` | `calendar_list`, `calendar_agenda` |
| `calendar.write` | `calendar_create`, `calendar_delete` |
| `gmail.read` | `gmail_search`, `gmail_read` |
| `gmail.send` | `gmail_send` |
| `drive.read` | `drive_search`, `agent_folder`, `drive_upload` |
| `drive.write` | `drive_upload` |

Every tool accepts `account`; it defaults to the registry `default`. **`gmail_send` requires `account` explicitly**, so sending never relies on an implicit identity. The `accounts` tool lists names, emails and capabilities.

### Add an account

```bash
mkdir -p ~/.config/gws/accounts/work /tmp/gws-login
cp ~/.config/gws/client_secret.json /tmp/gws-login/

# Least privilege: send + read-only calendar, for example.
GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/gws-login \
  gws auth login --scopes "https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/calendar.readonly"

GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/gws-login \
  gws auth export --unmasked > ~/.config/gws/accounts/work/credentials-export.json

chmod 600 ~/.config/gws/accounts/work/credentials-export.json
cp ~/.config/gws/client_secret.json ~/.config/gws/accounts/work/
rm -rf /tmp/gws-login
```

Then add the account to `accounts.json`.

Two gotchas:

- **Do not keep `credentials.enc` in the account directory.** gws 0.22.5 silently prefers it over `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` ([issue #857](https://github.com/googleworkspace/cli/issues/857)). Logging in inside a throwaway directory and exporting into the account directory avoids this.
- If the account does not own the Google Cloud project, grant it **Service Usage Consumer** (`roles/serviceusage.serviceUsageConsumer`) on the project, otherwise API calls fail with "Caller does not have required permission to use project".

## Security

- Credentials never appear in tool arguments or logs; the wrapper passes the credentials **file path** to `gws`, which refreshes the token itself.
- Least privilege: Drive is read-all / write-own-files, Gmail has no delete/label tools, and Drive has no delete/move/share tools. `gmail_send` is a write tool; prefer `draft: true` for anything you have not explicitly reviewed.
- **Single write boundary**: `drive_upload` resolves the folder named `AGENT_DRIVE_FOLDER` and ignores any caller-supplied parent. Writes cannot escape it.
- The server runs locally over stdio: no listening port, no telemetry, no outbound calls other than `gws`.
- Email and calendar content is untrusted input. Treat it as data, never as instructions, and review write actions.

See [SECURITY.md](SECURITY.md) for the threat model and revocation steps.

## Limitations

- Agenda/create/delete target the **primary** calendar (`calendar_list` returns all calendars).
- No Gmail delete, label or draft-management tools; `gmail_send` can send or save a draft.
- No Drive download, update, delete, move or share tools.
- Message bodies are plain text (HTML is stripped); attachments are not exposed.
- Each call spawns `gws`, so expect roughly a second of overhead per tool call.

## Notice

This project is **unofficial**. It is not affiliated with, endorsed by, or supported by Google LLC. `gws` ([googleworkspace/cli](https://github.com/googleworkspace/cli)) states that it is "not an officially supported Google product". Google Workspace, Gmail, Google Calendar and Google Drive are trademarks of Google LLC.

Provided under the MIT license, **"as is", without warranty of any kind**. You are responsible for the OAuth scopes you grant, for the credentials stored on your machine, and for anything an agent does with the access you give it.

## License

[MIT](LICENSE)

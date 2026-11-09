# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability). Please do not open a public issue for credential handling or injection flaws.

## How it works

- The server is a local stdio MCP process. It opens no ports and sends nothing over the network itself.
- Each tool call spawns the `gws` CLI with `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` pointing at an authorized-user JSON file. `gws` performs the OAuth refresh and the HTTPS request.
- The wrapper reads the credentials file only to pass its path; it never parses, logs or returns token values.

## Credential storage

The credentials file contains a **refresh token**:

```text
~/.config/gws/credentials-export.json
```

- Keep it `chmod 600` and outside any repository.
- To revoke: remove access in your [Google Account permissions](https://myaccount.google.com/permissions), then delete the file and run `gws auth logout`.
- Rotating the file: run `gws auth login` again and re-export.

## Scope and blast radius

The recommended scopes are deliberately narrow:

| Scope | Grants |
| --- | --- |
| `gmail.modify` | Read, label, draft and send mail. No permanent delete. |
| `calendar` | Manage calendars and events. |
| `drive.readonly` | Read and download all Drive files. |
| `drive.file` | Create and modify only files this app created. |

The server exposes `gmail_send` (send, or save as a draft with `draft: true`). It has no Gmail delete, label or draft-management tools, and no Drive delete, move, rename or share tool. `drive_upload` is pinned server-side to the folder named by `AGENT_DRIVE_FOLDER`; it does not accept a parent folder from the caller. `drive_search` and `gmail_search` can read broadly, by design.

## Multiple accounts

Each account has its own config directory, its own refresh token, and an explicit capability list in `~/.config/google-workspace-mcp/accounts.json`. The server sets the account's config directory on every `gws` call, so there is no implicit "default account" fallback inside `gws` itself.

- Capabilities are enforced in code (`calendar.read`, `calendar.write`, `gmail.read`, `gmail.send`, `drive.read`, `drive.write`). An account with `calendar.read` only cannot create or delete events, even if its token would allow it.
- `gmail_send` requires an explicit `account`; it never picks an identity by default.
- Keep every `credentials-export.json` at `chmod 600`. Tokens are separate per account, so revoking one account does not affect the others.
- If an account is not an owner of the Google Cloud project, grant it only `roles/serviceusage.serviceUsageConsumer` so quota can be attributed.

## Prompt injection

Email bodies, calendar descriptions and Drive metadata are untrusted input. An agent that reads them can be manipulated into calling tools with attacker-chosen arguments — including `gmail_send`, which can send mail as you. Mitigations:

- Keep human approval enabled for write tools in your MCP client, and prefer `draft: true` when a human will review the message.
- Do not grant this server to unattended agents that auto-approve tools.
- Review the `drive_upload` destination, `gmail_send` recipients and calendar changes.

## Non-goals

This project is not a sandbox for the agent and does not replace your MCP client's permission system. It also does not protect against a compromised local account: anyone who can read the credentials file can act as you until the grant is revoked.

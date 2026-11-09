#!/usr/bin/env node
/**
 * google-workspace-mcp — minimal stdio MCP server for Gmail, Google Calendar and
 * Google Drive, backed by the `gws` CLI (googleworkspace/cli).
 *
 * Multi-account:
 *   Accounts live in ~/.config/google-workspace-mcp/accounts.json (override with
 *   GOOGLE_ACCOUNTS_CONFIG). Each account has its own gws config dir + exported
 *   credentials and a capability list. Every tool accepts an `account` argument
 *   (defaults to the registry default), and the server enforces capabilities
 *   before spawning gws — e.g. a read-only calendar account cannot create events.
 *
 * Why per-account config dirs: gws 0.22.5 silently prefers credentials.enc over
 * GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE. The account dirs contain no
 * credentials.enc, so the exported authorized-user file is the only source.
 *
 * Safety:
 *   - gmail_send requires an explicit `account` (no default identity).
 *   - The only Drive write tool pins uploads to the folder named by
 *     AGENT_DRIVE_FOLDER and ignores caller-supplied parents.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

const GWS = process.env.GWS_BIN || "gws";
const ACCOUNTS_FILE = expandHome(
  process.env.GOOGLE_ACCOUNTS_CONFIG ||
    "~/.config/google-workspace-mcp/accounts.json"
);
const AGENT_FOLDER_NAME = process.env.AGENT_DRIVE_FOLDER || "agent";
const FOLDER_MIME = "application/vnd.google-apps.folder";

const ENV = { ...process.env };
// Some sandboxes cannot read the macOS Keychain for TLS roots. Fall back to the
// system CA bundle only when the caller has not provided one.
if (!ENV.SSL_CERT_FILE && fs.existsSync("/etc/ssl/cert.pem")) {
  ENV.SSL_CERT_FILE = "/etc/ssl/cert.pem";
  ENV.SSL_CERT_DIR = ENV.SSL_CERT_DIR || "/etc/ssl/certs";
}

function loadRegistry() {
  let raw;
  try {
    raw = fs.readFileSync(ACCOUNTS_FILE, "utf8");
  } catch (e) {
    throw new Error(
      `cannot read accounts registry at ${ACCOUNTS_FILE}: ${e.message}\n` +
        `Create it with: {"default":"personal","accounts":{"personal":{"email":"you@example.com","configDir":"~/.config/gws/accounts/personal","credentials":"~/.config/gws/accounts/personal/credentials-export.json","capabilities":["calendar.read","calendar.write","gmail.read","gmail.send","drive.read","drive.write"]}}}`
    );
  }
  const registry = JSON.parse(raw);
  if (!registry.accounts || typeof registry.accounts !== "object") {
    throw new Error(`accounts registry at ${ACCOUNTS_FILE} has no "accounts" object`);
  }
  if (!registry.default || !registry.accounts[registry.default]) {
    throw new Error(
      `accounts registry at ${ACCOUNTS_FILE} has an invalid "default" (must name an account)`
    );
  }
  for (const [name, a] of Object.entries(registry.accounts)) {
    for (const field of ["configDir", "credentials"]) {
      if (!a[field]) throw new Error(`account "${name}" is missing "${field}"`);
    }
    if (!Array.isArray(a.capabilities)) a.capabilities = [];
  }
  return registry;
}

const REGISTRY = loadRegistry();

function getAccount(name) {
  const key = name || REGISTRY.default;
  const account = REGISTRY.accounts[key];
  if (!account) {
    throw new Error(
      `unknown account "${key}". Known accounts: ${Object.keys(REGISTRY.accounts).join(", ")}`
    );
  }
  return { name: key, ...account };
}

function requireCapability(accountName, capability) {
  const account = getAccount(accountName);
  if (!account.capabilities.includes(capability)) {
    throw new Error(
      `account "${account.name}" (${account.email}) does not allow "${capability}". ` +
        `Allowed: ${account.capabilities.length ? account.capabilities.join(", ") : "none"}`
    );
  }
  return account;
}

function runGws(args, opts = {}) {
  const account = getAccount(opts.account);
  const env = {
    ...ENV,
    GOOGLE_WORKSPACE_CLI_CONFIG_DIR: expandHome(account.configDir),
    GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: expandHome(account.credentials),
  };
  const r = spawnSync(GWS, args, {
    env,
    encoding: "utf8",
    timeout: opts.timeout || 60000,
    cwd: opts.cwd,
  });
  if (r.error) throw new Error(`gws spawn failed: ${r.error.message}`);
  const out = (r.stdout || "").trim();
  const err = (r.stderr || "").trim();
  if (r.status !== 0) throw new Error(`gws exited ${r.status}: ${err || out}`);
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

function q(obj) {
  return JSON.stringify(obj);
}

function b64urlDecode(s) {
  return Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function findPart(payload, mime) {
  if (!payload) return "";
  if (payload.mimeType === mime && payload.body && payload.body.data) {
    return b64urlDecode(payload.body.data);
  }
  for (const part of payload.parts || []) {
    const t = findPart(part, mime);
    if (t) return t;
  }
  return "";
}

function extractText(payload) {
  const plain = findPart(payload, "text/plain");
  if (plain) return plain;
  const html = findPart(payload, "text/html");
  if (html) {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  if (payload && payload.body && payload.body.data) {
    return b64urlDecode(payload.body.data);
  }
  return "";
}

function header(payload, name) {
  const h = (payload && payload.headers) || [];
  const found = h.find((x) => String(x.name).toLowerCase() === name.toLowerCase());
  return found ? found.value : undefined;
}

const agentFolderCache = new Map();

function resolveAgentFolder(accountName) {
  const key = getAccount(accountName).name;
  if (agentFolderCache.has(key)) return agentFolderCache.get(key);
  const res = runGws(
    [
      "drive", "files", "list",
      "--params", q({
        q: `name = '${AGENT_FOLDER_NAME}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
        pageSize: 5,
        fields: "files(id,name)",
      }),
    ],
    { account: key }
  );
  const file = res && res.files && res.files[0];
  if (!file) throw new Error(`Drive folder "${AGENT_FOLDER_NAME}" not found for account "${key}"`);
  agentFolderCache.set(key, file.id);
  return file.id;
}

const ACCOUNT_PROP = {
  type: "string",
  description:
    "Account name from the accounts tool. Defaults to the registry default; gmail_send requires it explicitly.",
};

const TOOLS = [
  {
    name: "accounts",
    description: "List configured Google accounts, their email addresses and allowed capabilities.",
    inputSchema: { type: "object", properties: {} },
    run: () => ({
      default: REGISTRY.default,
      accounts: Object.entries(REGISTRY.accounts).map(([name, a]) => ({
        name,
        email: a.email,
        capabilities: a.capabilities,
      })),
    }),
  },
  {
    name: "calendar_list",
    description: "List calendars on the selected account (id, summary, timezone, primary flag).",
    inputSchema: { type: "object", properties: { account: ACCOUNT_PROP } },
    run: ({ account } = {}) => {
      requireCapability(account, "calendar.read");
      return runGws(
        [
          "calendar", "calendarList", "list",
          "--params", q({ maxResults: 50, fields: "items(id,summary,timeZone,primary,accessRole)" }),
        ],
        { account }
      );
    },
  },
  {
    name: "calendar_agenda",
    description:
      "Upcoming events from the primary calendar for the next N days (default 7), ordered by start time.",
    inputSchema: {
      type: "object",
      properties: {
        account: ACCOUNT_PROP,
        days: { type: "integer", minimum: 1, maximum: 60, description: "Days ahead (default 7)." },
        max: { type: "integer", minimum: 1, maximum: 100, description: "Max events (default 25)." },
      },
    },
    run: ({ account, days = 7, max = 25 } = {}) => {
      requireCapability(account, "calendar.read");
      const now = new Date();
      const end = new Date(now.getTime() + days * 86400000);
      return runGws(
        [
          "calendar", "events", "list",
          "--params", q({
            calendarId: "primary",
            timeMin: now.toISOString(),
            timeMax: end.toISOString(),
            singleEvents: true,
            orderBy: "startTime",
            maxResults: max,
            fields: "items(id,summary,start,end,location,attendees,htmlLink,status)",
          }),
        ],
        { account }
      );
    },
  },
  {
    name: "calendar_create",
    description:
      "Create an event on the primary calendar. Times must be RFC3339 with an offset (e.g. 2026-11-10T10:00:00+01:00).",
    inputSchema: {
      type: "object",
      properties: {
        account: ACCOUNT_PROP,
        summary: { type: "string", minLength: 1 },
        start: { type: "string", description: "RFC3339 start with timezone offset." },
        end: { type: "string", description: "RFC3339 end with timezone offset." },
        description: { type: "string" },
        location: { type: "string" },
        attendees: { type: "string", description: "Comma-separated email addresses." },
      },
      required: ["summary", "start", "end"],
    },
    run: ({ account, summary, start, end, description, location, attendees }) => {
      requireCapability(account, "calendar.write");
      if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(start) || !/[zZ]|[+-]\d{2}:\d{2}$/.test(end)) {
        throw new Error("start and end must include a timezone offset (e.g. +01:00) or Z");
      }
      const body = { summary, start: { dateTime: start }, end: { dateTime: end } };
      if (description) body.description = description;
      if (location) body.location = location;
      if (attendees) {
        body.attendees = attendees
          .split(",")
          .map((e) => ({ email: e.trim() }))
          .filter((e) => e.email);
      }
      return runGws(
        [
          "calendar", "events", "insert",
          "--params", q({ calendarId: "primary", fields: "id,htmlLink,summary,start,end" }),
          "--json", q(body),
        ],
        { account }
      );
    },
  },
  {
    name: "calendar_delete",
    description: "Delete an event from the primary calendar by event id. Returns { deleted: true, id }.",
    inputSchema: {
      type: "object",
      properties: {
        account: ACCOUNT_PROP,
        id: { type: "string", minLength: 1, description: "Event id." },
      },
      required: ["id"],
    },
    run: ({ account, id }) => {
      requireCapability(account, "calendar.write");
      runGws(["calendar", "events", "delete", "--params", q({ calendarId: "primary", eventId: id })], {
        account,
      });
      return { deleted: true, id };
    },
  },
  {
    name: "gmail_search",
    description:
      "Search Gmail using Gmail query syntax (e.g. 'is:unread newer_than:2d', 'from:x subject:y'). Returns message metadata.",
    inputSchema: {
      type: "object",
      properties: {
        account: ACCOUNT_PROP,
        query: { type: "string", minLength: 1, description: "Gmail search query." },
        max: { type: "integer", minimum: 1, maximum: 20, description: "Max messages (default 10)." },
      },
      required: ["query"],
    },
    run: ({ account, query, max = 10 }) => {
      requireCapability(account, "gmail.read");
      const list = runGws(
        [
          "gmail", "users", "messages", "list",
          "--params", q({ userId: "me", q: query, maxResults: max, fields: "messages(id,threadId)" }),
        ],
        { account }
      );
      const messages = (list && list.messages) || [];
      return messages.map((m) => {
        try {
          const msg = runGws(
            [
              "gmail", "users", "messages", "get",
              "--params", q({
                userId: "me",
                id: m.id,
                format: "metadata",
                metadataHeaders: ["Subject", "From", "Date"],
                fields: "id,threadId,snippet,payload/headers",
              }),
            ],
            { account }
          );
          return {
            id: msg.id || m.id,
            threadId: msg.threadId || m.threadId,
            subject: header(msg.payload, "Subject"),
            from: header(msg.payload, "From"),
            date: header(msg.payload, "Date"),
            snippet: msg.snippet,
          };
        } catch (e) {
          return { id: m.id, threadId: m.threadId, error: String(e.message || e) };
        }
      });
    },
  },
  {
    name: "gmail_read",
    description: "Read one Gmail message by id. Returns headers and the plain-text body when available.",
    inputSchema: {
      type: "object",
      properties: {
        account: ACCOUNT_PROP,
        id: { type: "string", minLength: 1, description: "Gmail message id." },
      },
      required: ["id"],
    },
    run: ({ account, id }) => {
      requireCapability(account, "gmail.read");
      const msg = runGws(
        [
          "gmail", "users", "messages", "get",
          "--params", q({ userId: "me", id, format: "full" }),
        ],
        { account }
      );
      return {
        id: msg.id,
        threadId: msg.threadId,
        subject: header(msg.payload, "Subject"),
        from: header(msg.payload, "From"),
        to: header(msg.payload, "To"),
        date: header(msg.payload, "Date"),
        snippet: msg.snippet,
        body: extractText(msg.payload).slice(0, 20000),
      };
    },
  },
  {
    name: "gmail_send",
    description:
      "Send an email, or create a draft with draft=true. Requires an explicit account: confirm the identity before sending.",
    inputSchema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description:
            "Account to send from. Required: pick the identity deliberately (see the accounts tool).",
        },
        to: { type: "string", minLength: 3, description: "Recipients, comma-separated." },
        subject: { type: "string", minLength: 1 },
        body: { type: "string", minLength: 1, description: "Plain text, or HTML when html=true." },
        cc: { type: "string", description: "CC recipients, comma-separated." },
        bcc: { type: "string", description: "BCC recipients, comma-separated." },
        html: { type: "boolean", description: "Treat body as HTML." },
        draft: { type: "boolean", description: "Save as a draft instead of sending." },
        from: { type: "string", description: "Optional send-as alias within the same account." },
      },
      required: ["account", "to", "subject", "body"],
    },
    run: ({ account, to, subject, body, cc, bcc, html, draft, from }) => {
      if (!account) throw new Error("account is required for gmail_send (see the accounts tool)");
      requireCapability(account, "gmail.send");
      const args = ["gmail", "+send", "--to", to, "--subject", subject, "--body", body];
      if (cc) args.push("--cc", cc);
      if (bcc) args.push("--bcc", bcc);
      if (html) args.push("--html");
      if (from) args.push("--from", from);
      if (draft) args.push("--draft");
      return runGws(args, { account });
    },
  },
  {
    name: "drive_search",
    description:
      "Search Drive files and folders. Use Drive query syntax, e.g. \"name contains 'report'\" or \"mimeType = 'application/vnd.google-apps.folder'\".",
    inputSchema: {
      type: "object",
      properties: {
        account: ACCOUNT_PROP,
        query: { type: "string", minLength: 1, description: "Drive query (q parameter)." },
        max: { type: "integer", minimum: 1, maximum: 50, description: "Max files (default 15)." },
      },
      required: ["query"],
    },
    run: ({ account, query, max = 15 }) => {
      requireCapability(account, "drive.read");
      return runGws(
        [
          "drive", "files", "list",
          "--params", q({
            q: query,
            pageSize: max,
            fields: "files(id,name,mimeType,parents,webViewLink,modifiedTime,size)",
          }),
        ],
        { account }
      );
    },
  },
  {
    name: "drive_upload",
    description:
      "Upload a local file to Drive, always into the account's folder named by AGENT_DRIVE_FOLDER. Returns the new file id and link.",
    inputSchema: {
      type: "object",
      properties: {
        account: ACCOUNT_PROP,
        path: { type: "string", minLength: 1, description: "Absolute local file path." },
        name: { type: "string", description: "Optional Drive file name (defaults to the local basename)." },
        mimeType: { type: "string", description: "Optional MIME type override." },
      },
      required: ["path"],
    },
    run: ({ account, path: filePath, name, mimeType }) => {
      requireCapability(account, "drive.read");
      requireCapability(account, "drive.write");
      if (!path.isAbsolute(filePath)) throw new Error("path must be absolute");
      if (!fs.existsSync(filePath)) throw new Error(`file not found: ${filePath}`);
      const parent = resolveAgentFolder(account);
      const body = { name: name || path.basename(filePath), parents: [parent] };
      if (mimeType) body.mimeType = mimeType;
      // gws refuses uploads outside its working directory, so run it from the
      // file's own directory and pass the bare filename.
      return runGws(
        [
          "drive", "files", "create",
          "--params", q({ fields: "id,name,webViewLink,parents" }),
          "--json", q(body),
          "--upload", path.basename(filePath),
        ],
        { account, cwd: path.dirname(filePath) }
      );
    },
  },
  {
    name: "agent_folder",
    description:
      "Return the id and web link of the Drive folder that uploads are pinned to, for the selected account.",
    inputSchema: { type: "object", properties: { account: ACCOUNT_PROP } },
    run: ({ account } = {}) => {
      requireCapability(account, "drive.read");
      const key = getAccount(account).name;
      const id = resolveAgentFolder(key);
      return { account: key, id, name: AGENT_FOLDER_NAME, webViewLink: `https://drive.google.com/drive/folders/${id}` };
    },
  },
];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const text = (t) => ({
  content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t, null, 2) }],
});

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;

  if (method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "google-workspace", version: "0.3.0" },
        instructions:
          "Google Workspace tools backed by the gws CLI. Multiple accounts are supported; call `accounts` to see names and capabilities. Reads are safe; gmail_send requires an explicit account, and Drive uploads are pinned to the account's 'agent' folder.",
      },
    });
  }
  if (method === "notifications/initialized") return;
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });

  if (method === "tools/list") {
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      },
    });
  }

  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${name}` } });
    try {
      return send({ jsonrpc: "2.0", id, result: text(tool.run(args)) });
    } catch (e) {
      return send({
        jsonrpc: "2.0",
        id,
        result: { ...text(String(e.message || e)), isError: true },
      });
    }
  }

  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
});

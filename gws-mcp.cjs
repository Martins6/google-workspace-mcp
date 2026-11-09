#!/usr/bin/env node
/**
 * gws-mcp — minimal stdio MCP server that exposes Google Workspace actions by
 * shelling out to the `gws` CLI (googleworkspace/cli) with the authorized-user
 * credentials exported from `gws auth export`.
 *
 * Why this exists: OpenCode's own Google MCP servers are gated behind the
 * Workspace Developer Preview Program, and the shell tool's sandbox has no DNS.
 * Local MCP servers are spawned by the OpenCode server, so they do have network.
 *
 * Safety: read tools are unrestricted; the only write tool (drive_upload) pins
 * every upload to the Drive folder named "agent" — it resolves the folder id
 * itself and never accepts a parent from the caller.
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
const CREDS = expandHome(
  process.env.GOOGLE_WORKSPACE_CREDENTIALS ||
    "~/.config/gws/credentials-export.json"
);
const AGENT_FOLDER_NAME = process.env.AGENT_DRIVE_FOLDER || "agent";
const FOLDER_MIME = "application/vnd.google-apps.folder";

const ENV = {
  ...process.env,
  GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: CREDS,
};
// Some sandboxes cannot read the macOS Keychain for TLS roots. Fall back to the
// system CA bundle only when the caller has not provided one.
if (!ENV.SSL_CERT_FILE && fs.existsSync("/etc/ssl/cert.pem")) {
  ENV.SSL_CERT_FILE = "/etc/ssl/cert.pem";
  ENV.SSL_CERT_DIR = ENV.SSL_CERT_DIR || "/etc/ssl/certs";
}

function runGws(args, opts = {}) {
  const r = spawnSync(GWS, args, {
    env: ENV,
    encoding: "utf8",
    timeout: opts.timeout || 60000,
    cwd: opts.cwd,
  });
  if (r.error) throw new Error(`gws spawn failed: ${r.error.message}`);
  const out = (r.stdout || "").trim();
  const err = (r.stderr || "").trim();
  if (r.status !== 0) throw new Error(`gws exited ${r.status}: ${err || out}`);
  if (!out) return null;
  try { return JSON.parse(out); } catch { return out; }
}

function q(obj) { return JSON.stringify(obj); }

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

let agentFolderId;
function resolveAgentFolder() {
  if (agentFolderId) return agentFolderId;
  const res = runGws([
    "drive", "files", "list",
    "--params", q({
      q: `name = '${AGENT_FOLDER_NAME}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
      pageSize: 5,
      fields: "files(id,name)",
    }),
  ]);
  const file = res && res.files && res.files[0];
  if (!file) throw new Error(`Drive folder "${AGENT_FOLDER_NAME}" not found in My Drive`);
  agentFolderId = file.id;
  return agentFolderId;
}

const TOOLS = [
  {
    name: "calendar_list",
    description: "List the calendars on this Google account (id, summary, timezone, primary flag).",
    inputSchema: { type: "object", properties: {} },
    run: () => runGws([
      "calendar", "calendarList", "list",
      "--params", q({ maxResults: 50, fields: "items(id,summary,timeZone,primary,accessRole)" }),
    ]),
  },
  {
    name: "calendar_agenda",
    description: "Upcoming events from the primary calendar for the next N days (default 7), ordered by start time.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "integer", minimum: 1, maximum: 60, description: "Days ahead (default 7)." },
        max: { type: "integer", minimum: 1, maximum: 100, description: "Max events (default 25)." },
      },
    },
    run: ({ days = 7, max = 25 } = {}) => {
      const now = new Date();
      const end = new Date(now.getTime() + days * 86400000);
      return runGws([
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
      ]);
    },
  },
  {
    name: "calendar_create",
    description: "Create an event on the primary calendar. Times must be RFC3339 with an offset (e.g. 2026-11-10T10:00:00+01:00).",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", minLength: 1 },
        start: { type: "string", description: "RFC3339 start with timezone offset." },
        end: { type: "string", description: "RFC3339 end with timezone offset." },
        description: { type: "string" },
        location: { type: "string" },
        attendees: { type: "string", description: "Comma-separated email addresses." },
      },
      required: ["summary", "start", "end"],
    },
    run: ({ summary, start, end, description, location, attendees }) => {
      if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(start) || !/[zZ]|[+-]\d{2}:\d{2}$/.test(end)) {
        throw new Error("start and end must include a timezone offset (e.g. +01:00) or Z");
      }
      const body = {
        summary,
        start: { dateTime: start },
        end: { dateTime: end },
      };
      if (description) body.description = description;
      if (location) body.location = location;
      if (attendees) body.attendees = attendees.split(",").map((e) => ({ email: e.trim() })).filter((e) => e.email);
      return runGws([
        "calendar", "events", "insert",
        "--params", q({ calendarId: "primary", fields: "id,htmlLink,summary,start,end" }),
        "--json", q(body),
      ]);
    },
  },
  {
    name: "calendar_delete",
    description: "Delete an event from the primary calendar by event id. Returns { deleted: true, id }.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1, description: "Event id." } },
      required: ["id"],
    },
    run: ({ id }) => {
      runGws(["calendar", "events", "delete", "--params", q({ calendarId: "primary", eventId: id })]);
      return { deleted: true, id };
    },
  },
  {
    name: "gmail_search",
    description: "Search Gmail using Gmail query syntax (e.g. 'is:unread newer_than:2d', 'from:x subject:y'). Returns message metadata.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "Gmail search query." },
        max: { type: "integer", minimum: 1, maximum: 20, description: "Max messages (default 10)." },
      },
      required: ["query"],
    },
    run: ({ query, max = 10 }) => {
      const list = runGws([
        "gmail", "users", "messages", "list",
        "--params", q({ userId: "me", q: query, maxResults: max, fields: "messages(id,threadId)" }),
      ]);
      const messages = (list && list.messages) || [];
      return messages.map((m) => {
        try {
          const msg = runGws([
            "gmail", "users", "messages", "get",
            "--params", q({
              userId: "me",
              id: m.id,
              format: "metadata",
              metadataHeaders: ["Subject", "From", "Date"],
              fields: "id,threadId,snippet,payload/headers",
            }),
          ]);
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
      properties: { id: { type: "string", minLength: 1, description: "Gmail message id." } },
      required: ["id"],
    },
    run: ({ id }) => {
      const msg = runGws([
        "gmail", "users", "messages", "get",
        "--params", q({ userId: "me", id, format: "full" }),
      ]);
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
    description: "Send an email, or create a draft with draft=true. This is a write action: confirm with the user before sending.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", minLength: 3, description: "Recipients, comma-separated." },
        subject: { type: "string", minLength: 1 },
        body: { type: "string", minLength: 1, description: "Plain text, or HTML when html=true." },
        cc: { type: "string", description: "CC recipients, comma-separated." },
        bcc: { type: "string", description: "BCC recipients, comma-separated." },
        html: { type: "boolean", description: "Treat body as HTML." },
        draft: { type: "boolean", description: "Save as a draft instead of sending." },
      },
      required: ["to", "subject", "body"],
    },
    run: ({ to, subject, body, cc, bcc, html, draft }) => {
      const args = ["gmail", "+send", "--to", to, "--subject", subject, "--body", body];
      if (cc) args.push("--cc", cc);
      if (bcc) args.push("--bcc", bcc);
      if (html) args.push("--html");
      if (draft) args.push("--draft");
      return runGws(args);
    },
  },
  {
    name: "drive_search",
    description: "Search Drive files and folders. Use Drive query syntax, e.g. \"name contains 'report'\" or \"mimeType = 'application/vnd.google-apps.folder'\".",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "Drive query (q parameter)." },
        max: { type: "integer", minimum: 1, maximum: 50, description: "Max files (default 15)." },
      },
      required: ["query"],
    },
    run: ({ query, max = 15 }) => runGws([
      "drive", "files", "list",
      "--params", q({
        q: query,
        pageSize: max,
        fields: "files(id,name,mimeType,parents,webViewLink,modifiedTime,size)",
      }),
    ]),
  },
  {
    name: "drive_upload",
    description: "Upload a local file to Google Drive, always into the folder named 'agent'. Returns the new file id and link.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Absolute local file path." },
        name: { type: "string", description: "Optional Drive file name (defaults to the local basename)." },
        mimeType: { type: "string", description: "Optional MIME type override." },
      },
      required: ["path"],
    },
    run: ({ path: filePath, name, mimeType }) => {
      if (!path.isAbsolute(filePath)) throw new Error("path must be absolute");
      if (!fs.existsSync(filePath)) throw new Error(`file not found: ${filePath}`);
      const parent = resolveAgentFolder();
      const body = { name: name || path.basename(filePath), parents: [parent] };
      if (mimeType) body.mimeType = mimeType;
      // gws refuses uploads outside its working directory, so run it from the
      // file's own directory and pass the bare filename.
      return runGws([
        "drive", "files", "create",
        "--params", q({ fields: "id,name,webViewLink,parents" }),
        "--json", q(body),
        "--upload", path.basename(filePath),
      ], { cwd: path.dirname(filePath) });
    },
  },
  {
    name: "agent_folder",
    description: "Return the id and web link of the Drive folder named 'agent' that all uploads are pinned to.",
    inputSchema: { type: "object", properties: {} },
    run: () => {
      const id = resolveAgentFolder();
      return { id, name: AGENT_FOLDER_NAME, webViewLink: `https://drive.google.com/drive/folders/${id}` };
    },
  },
];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const text = (t) => ({ content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t, null, 2) }] });

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;

  if (method === "initialize") {
    return send({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "google-workspace", version: "0.2.0" },
        instructions: "Google Workspace tools backed by the gws CLI. Reads are safe; the only write tool uploads into the Drive folder named 'agent'.",
      },
    });
  }
  if (method === "notifications/initialized") return;
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });

  if (method === "tools/list") {
    return send({
      jsonrpc: "2.0", id,
      result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
    });
  }

  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${name}` } });
    try {
      const value = tool.run(args);
      return send({ jsonrpc: "2.0", id, result: text(value) });
    } catch (e) {
      return send({ jsonrpc: "2.0", id, result: { ...text(String(e.message || e)), isError: true } });
    }
  }

  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
});

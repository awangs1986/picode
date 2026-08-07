import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AccountsManager } from "../store/accounts.ts";
import {
  parseAccountJson,
  scanLocalAccountCandidates,
  type AccountImportCandidate,
} from "./account-source-scanner.ts";

export type WizardCompletion =
  | { status: "imported"; provider: string; accountId: string }
  | { status: "cancelled" }
  | { status: "timed_out" };

export interface AccountImportWizard {
  url: URL;
  completion: Promise<WizardCompletion>;
  cancel(): void;
  browserOpened: boolean;
}

export async function startAccountImportWizard(options: {
  accounts: AccountsManager;
  openBrowser: (url: string) => Promise<void>;
  timeoutMs?: number;
  discoverAccounts?: () => Promise<AccountImportCandidate[]>;
}): Promise<AccountImportWizard> {
  const bootstrapToken = randomBytes(24).toString("hex");
  const sessionToken = randomBytes(32).toString("hex");
  let bootstrapAvailable = true;
  let settle!: (value: WizardCompletion) => void;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  const candidates = await (options.discoverAccounts ?? scanLocalAccountCandidates)();
  const candidatesById = new Map(candidates.map((item) => [item.id, item]));
  const renderCandidates = (items: readonly AccountImportCandidate[]): string => items.length === 0
    ? "<p>No supported accounts were found.</p>"
    : `<form method="post" action="/import-candidates"><fieldset><legend>Select one account</legend>${items.map((item) =>
      `<label><input type="radio" name="candidateId" value="${escapeHtml(item.id)}"> ${escapeHtml(item.summary)}</label>`
    ).join("")}<button type="submit">Import selected account</button></fieldset></form>`;
  const escapeHtml = (value: string): string => value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  const completion = new Promise<WizardCompletion>((resolve) => { settle = resolve; });
  const finish = (value: WizardCompletion): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    settle(value);
    server.close();
  };
  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const headers = {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    };
    if (req.method === "GET" && requestUrl.pathname === `/${bootstrapToken}/`) {
      if (!bootstrapAvailable) {
        res.writeHead(410, headers).end("bootstrap link already used");
        return;
      }
      bootstrapAvailable = false;
      res.writeHead(303, {
        ...headers,
        location: "/import",
        "set-cookie": `picode_import=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=120`,
      }).end();
      return;
    }
    const authenticated = (req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .includes(`picode_import=${sessionToken}`);
    if (!authenticated) {
      res.writeHead(403, headers).end("forbidden");
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/import") {
      const candidateRows = renderCandidates(candidates);
      res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Picode account import</title>
<style>body{font:16px system-ui;max-width:42rem;margin:3rem auto;padding:0 1rem}label{display:block;margin:1rem 0}input{box-sizing:border-box;width:100%;padding:.65rem}button{padding:.7rem 1.2rem}</style>
<h1>Picode account import</h1>
<p>Credentials are sent only to this temporary loopback server and stored in the Picode Account Vault.</p>
${candidateRows}
<form method="post" action="/preview-json">
<fieldset><legend>Import a JSON snapshot</legend>
<label>Source format <select name="kind"><option>codex</option><option>claude</option><option>cursor</option><option>custom</option></select></label>
<label>JSON <textarea name="json" rows="8" style="width:100%" required></textarea></label>
<button type="submit">Preview JSON accounts</button></fieldset></form>
<form method="post" action="/submit">
<label>Provider <input name="provider" required placeholder="openai, anthropic, cursor"></label>
<label>Account label <input name="label" required></label>
<label>API Key / Access Token <input name="accessToken" type="password" required autocomplete="off"></label>
<label>Refresh Token (optional) <input name="refreshToken" type="password" autocomplete="off"></label>
<label>Base URL (optional) <input name="baseUrl" type="url" placeholder="https://example.com/v1"></label>
<label>Default model (optional) <input name="defaultModel"></label>
<button type="submit">Import account</button>
</form></html>`);
      return;
    }
    if (req.method === "POST" && requestUrl.pathname === "/preview-json") {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > 1_048_576) {
          res.writeHead(413, headers).end("JSON snapshot is too large");
          return;
        }
        chunks.push(buffer);
      }
      try {
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const kind = form.get("kind");
        if (kind !== "codex" && kind !== "claude" && kind !== "cursor" && kind !== "custom") {
          res.writeHead(400, headers).end("unsupported source format");
          return;
        }
        const parsed = parseAccountJson(kind, form.get("json") ?? "", "uploaded JSON");
        for (const item of parsed) candidatesById.set(item.id, item);
        res.writeHead(parsed.length === 0 ? 422 : 200, {
          ...headers,
          "content-type": "text/html; charset=utf-8",
        });
        res.end(parsed.length === 0 ? "No supported account was found." : renderCandidates(parsed));
      } catch {
        res.writeHead(400, headers).end("invalid JSON account snapshot");
      }
      return;
    }
    if (req.method === "POST" && requestUrl.pathname === "/cancel") {
      res.writeHead(204, headers).end();
      finish({ status: "cancelled" });
      return;
    }
    if (req.method === "POST" && requestUrl.pathname === "/import-candidates") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const selected = candidatesById.get(form.get("candidateId") ?? "");
      if (selected === undefined) {
        res.writeHead(400, headers).end("select one detected account");
        return;
      }
      const imported = await options.accounts.importCredentials({
        provider: selected.provider,
        label: selected.label,
        credentials: selected.credentials,
        ...(selected.defaultModel === undefined ? {} : { defaultModel: selected.defaultModel }),
      });
      if (!imported.ok) {
        res.writeHead(500, headers).end(imported.error.message);
        return;
      }
      res.writeHead(201, { ...headers, "content-type": "application/json" });
      res.end(JSON.stringify(imported.value));
      finish({ status: "imported", provider: imported.value.provider, accountId: imported.value.id });
      return;
    }
    if (req.method !== "POST" || requestUrl.pathname !== "/submit") {
      res.writeHead(404, headers).end("not found");
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > 1_048_576) throw new Error("payload too large");
        chunks.push(buffer);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = req.headers["content-type"]?.startsWith("application/json")
        ? JSON.parse(raw) as Record<string, unknown>
        : Object.fromEntries(new URLSearchParams(raw));
      if (typeof body.provider !== "string" || typeof body.label !== "string" || typeof body.accessToken !== "string") {
        res.writeHead(400, headers).end("invalid account payload");
        return;
      }
      const imported = await options.accounts.importCredentials({
        provider: body.provider,
        label: body.label,
        credentials: {
          accessToken: body.accessToken,
          ...(typeof body.refreshToken === "string" ? { refreshToken: body.refreshToken } : {}),
          ...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl } : {}),
        },
        ...(typeof body.defaultModel === "string" ? { defaultModel: body.defaultModel } : {}),
      });
      if (!imported.ok) {
        res.writeHead(500, headers).end(imported.error.message);
        return;
      }
      res.writeHead(201, { ...headers, "content-type": "application/json" });
      res.end(JSON.stringify(imported.value));
      finish({ status: "imported", provider: imported.value.provider, accountId: imported.value.id });
    } catch {
      res.writeHead(400, headers).end("invalid account payload");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("wizard did not bind a TCP port");
  const url = new URL(`http://127.0.0.1:${address.port}/${bootstrapToken}/`);
  timer = setTimeout(() => finish({ status: "timed_out" }), options.timeoutMs ?? 120_000);
  let browserOpened = true;
  try {
    await options.openBrowser(url.toString());
  } catch {
    browserOpened = false;
  }
  return { url, completion, browserOpened, cancel: () => finish({ status: "cancelled" }) };
}

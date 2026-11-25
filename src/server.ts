import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";
import { getAttachment, parseMail } from "./mail.js";
import type { PmgClient } from "./pmg.js";
import type { Poller } from "./poller.js";
import type { Store } from "./store/index.js";
import type { MessageRow, View } from "./types.js";

export interface ServerDeps {
  pmg: PmgClient;
  store: Store;
  poller: Poller;
  webUser: string;
  webPassword: string;
  spamHideConfidence: number;
  welcomelistName: string;
  blocklistName: string;
  provider: string;
  model: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const ActionBody = z.object({
  action: z.enum(["release", "delete"]),
  ids: z.array(z.number().int().positive()).min(1).max(500),
  /** Also add each sender (or its whole domain) to the system Welcomelist (release) or Blocklist (delete). */
  list: z.enum(["address", "domain"]).optional(),
});

/** Domains shared by millions of unrelated senders: never list these whole. */
const SHARED_DOMAINS = new Set(
  `gmail.com googlemail.com outlook.com hotmail.com live.com msn.com yahoo.com yahoo.co.uk ymail.com icloud.com me.com
   aol.com proton.me protonmail.com gmx.com gmx.net mail.com zoho.com yandex.com mweb.co.za telkomsa.net vodamail.co.za
   webmail.co.za iafrica.com absamail.co.za amazonses.com sendgrid.net mailgun.org mcsv.net mandrillapp.com
   sparkpostmail.com onmicrosoft.com outlook.office365.com`.split(/\s+/),
);

/** What PMG's rules match on: the envelope sender, or the From address when that is empty. */
export function listEntry(row: MessageRow, kind: "address" | "domain"): string | undefined {
  const addr = (row.envelope_sender || row.sender_addr).trim().toLowerCase().replace(/^<|>$/g, "");
  if (!/^[^\s@<>]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(addr)) return undefined;
  return kind === "address" ? addr : addr.slice(addr.lastIndexOf("@") + 1);
}

/**
 * Bulk senders often build the recipient into the envelope sender ("news-sarah=example.com@bulk.test"),
 * so blocking that address covers one mailbox only: suggest its domain instead. Applied when the list is
 * read, so mail classified earlier benefits too. Advice of "none" is kept.
 */
export function withDomainAdvice(row: MessageRow): MessageRow {
  if (row.block_advice !== "address") return row;
  const addr = listEntry(row, "address");
  const domain = listEntry(row, "domain");
  const ours = row.receiver.toLowerCase().split("@")[1];
  if (!addr || !domain || !ours) return row;
  const local = addr.slice(0, addr.lastIndexOf("@"));
  const at = local.indexOf(`=${ours}`);
  // The domain must end there, and a forwarder's rewritten address (SRS) is not a bulk sender's.
  if (at < 1 || /^[a-z0-9.]/.test(local.slice(at + 1 + ours.length)) || /^srs[01][=+-]/.test(local)) return row;
  // Mail services share their subdomains between customers as well.
  if ([...SHARED_DOMAINS].some((d) => domain === d || domain.endsWith(`.${d}`))) return row;
  return {
    ...row,
    block_advice: "domain",
    block_reason: "The sender's address has the recipient built in, so blocking the address would only cover one mailbox.",
  };
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const page = readFileSync(join(here, "..", "public", "index.html"), "utf8");

  app.addHook("onRequest", async (req, reply) => {
    const [scheme, encoded] = (req.headers.authorization ?? "").split(" ");
    const decoded = scheme === "Basic" && encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";
    const sep = decoded.indexOf(":");
    const user = sep >= 0 ? decoded.slice(0, sep) : "";
    const pass = sep >= 0 ? decoded.slice(sep + 1) : "";
    // Evaluate both so timing does not reveal which half was wrong.
    const ok = [same(user, deps.webUser), same(pass, deps.webPassword)].every(Boolean);
    if (!ok) {
      return reply.header("WWW-Authenticate", 'Basic realm="Mail triage"').code(401).send("Authentication required");
    }
    // Browsers cannot add this header to a cross-site form post, which blocks CSRF.
    if (req.method !== "GET" && req.headers["x-requested-with"] !== "mailtriage") {
      return reply.code(403).send({ error: "Missing X-Requested-With header" });
    }
    (req as { actor?: string }).actor = user;
  });

  app.get("/", async (_req, reply) =>
    reply
      .header("Content-Type", "text/html; charset=utf-8")
      .header("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: https: http:; font-src data:")
      .header("X-Frame-Options", "DENY")
      // An unsubscribe page opened from here must not learn where the click came from.
      .header("Referrer-Policy", "no-referrer")
      .send(page),
  );

  app.get("/api/messages", async (req) => {
    const view = z.enum(["review", "spam", "history"]).catch("review").parse((req.query as { view?: string }).view);
    const rows = await deps.store.list(view as View, deps.spamHideConfidence);
    // What was decided before about mail like each pending message, so the same call can be made again.
    const keys = view === "history" ? [] : [...new Set(rows.flatMap((r) => (r.group_key ? [r.group_key] : [])))];
    return { rows: rows.map(withDomainAdvice), similar: await deps.store.groupHistory(keys) };
  });

  app.get("/api/status", async () => ({
    stats: await deps.store.stats(),
    counts: await deps.store.counts(deps.spamHideConfidence),
    lastPoll: deps.poller.lastRun ?? null,
    provider: deps.provider,
    model: deps.model,
    spamHideConfidence: deps.spamHideConfidence,
  }));

  // The message is read live from PMG. Its HTML is untrusted: the page only ever
  // shows it inside a sandboxed frame with scripts and remote content blocked.
  app.get("/api/messages/:id/content", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const [row] = await deps.store.getMany([id]);
    if (!row) return reply.code(404).send({ error: "Unknown message" });
    try {
      const content = await deps.pmg.getContent(row.pmg_id);
      const mail = await parseMail(content.content, { inlineImages: true });
      const headers = content.header || content.content.split(/\r?\n\r?\n/)[0] || "";
      return {
        mail: { ...mail, text: mail.text.slice(0, 200_000), html: mail.html.slice(0, 3_000_000) },
        rules: content.spaminfo,
        headers: headers.slice(0, 100_000),
      };
    } catch (err) {
      return reply.code(502).send({ error: `Could not read the message from PMG: ${(err as Error).message}` });
    }
  });

  // Downloads are always sent as opaque files, never as something the browser will open in place.
  const sendFile = (reply: FastifyReply, name: string, bytes: Buffer) => {
    const safe = name.replace(/[\r\n"\\/:*?<>|\x00-\x1f]/g, "_").slice(0, 150) || "download";
    const ascii = safe.replace(/[^\x20-\x7e]/g, "_");
    return reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`)
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "no-store")
      .send(bytes);
  };

  const rawFor = async (idParam: string) => {
    const [row] = await deps.store.getMany([Number(idParam)]);
    return row ? { row, raw: (await deps.pmg.getContent(row.pmg_id)).content } : undefined;
  };

  app.get("/api/messages/:id/raw", async (req, reply) => {
    try {
      const found = await rawFor((req.params as { id: string }).id);
      if (!found) return reply.code(404).send({ error: "Unknown message" });
      return sendFile(reply, `${found.row.subject || "message"}.eml`, Buffer.from(found.raw, "utf8"));
    } catch (err) {
      return reply.code(502).send({ error: `Could not read the message from PMG: ${(err as Error).message}` });
    }
  });

  app.get("/api/messages/:id/attachments/:index", async (req, reply) => {
    const { id, index } = req.params as { id: string; index: string };
    try {
      const found = await rawFor(id);
      const file = found && /^\d+$/.test(index) ? await getAttachment(found.raw, Number(index)) : undefined;
      if (!file) return reply.code(404).send({ error: "Unknown attachment" });
      return sendFile(reply, file.filename, file.content);
    } catch (err) {
      return reply.code(502).send({ error: `Could not read the message from PMG: ${(err as Error).message}` });
    }
  });

  app.post("/api/actions", async (req, reply) => {
    const body = ActionBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Expected { action, ids }" });
    const rows = (await deps.store.getMany(body.data.ids)).filter((r) => r.status === "pending");
    if (!rows.length) return reply.code(409).send({ error: "None of those messages are still pending" });

    // List the senders first, so a refusal leaves the mail untouched in the quarantine.
    const listed: string[] = [];
    if (body.data.list) {
      const kind = body.data.list;
      const entries = [...new Set(rows.map((r) => listEntry(r, kind)))];
      if (entries.includes(undefined)) {
        return reply.code(422).send({ error: "A message has no usable sender address to list" });
      }
      const shared = kind === "domain" ? entries.find((e) => SHARED_DOMAINS.has(e!)) : undefined;
      if (shared) {
        return reply.code(422).send({ error: `${shared} is shared by many unrelated senders; list the address instead` });
      }
      const group = body.data.action === "release" ? deps.welcomelistName : deps.blocklistName;
      try {
        for (const entry of entries) {
          await deps.pmg.addToList(group, kind === "address" ? "email" : "domain", entry!);
          listed.push(entry!);
        }
      } catch (err) {
        return reply.code(502).send({ error: `Could not update the PMG ${group}: ${(err as Error).message}` });
      }
    }

    try {
      await deps.pmg.act(
        body.data.action === "release" ? "deliver" : "delete",
        rows.map((r) => r.pmg_id),
      );
    } catch (err) {
      return reply.code(502).send({ error: `PMG refused the action: ${(err as Error).message}` });
    }
    const actor = (req as { actor?: string }).actor ?? "unknown";
    await deps.store.recordAction(
      rows.map((r) => r.id),
      body.data.action,
      actor,
    );

    // A new block rule also clears what it would have stopped from the rest of the queue.
    const also: number[] = [];
    let alsoError: string | undefined;
    if (body.data.action === "delete" && body.data.list) {
      const kind = body.data.list;
      try {
        const matches = (await deps.store.pending()).filter((r) => listed.includes(listEntry(r, kind) ?? ""));
        // In PMG's own batch size, so a refusal part way leaves the earlier batches recorded.
        for (let i = 0; i < matches.length; i += 50) {
          const batch = matches.slice(i, i + 50);
          await deps.pmg.act("delete", batch.map((r) => r.pmg_id));
          const ids = batch.map((r) => r.id);
          await deps.store.recordAction(ids, "delete", actor);
          also.push(...ids);
        }
      } catch (err) {
        // The chosen messages are already dealt with, so this is not a failed request.
        alsoError = `Could not delete all other mail matching the rule: ${(err as Error).message}`;
      }
    }
    return { done: rows.length, listed, also, alsoError };
  });

  app.post("/api/poll", async (_req, reply) => {
    try {
      return await deps.poller.run();
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  return app;
}

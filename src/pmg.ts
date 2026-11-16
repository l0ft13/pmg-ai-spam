import { readFileSync } from "node:fs";
import { Agent, fetch } from "undici";
import type { QuarantineItem, SpamRule } from "./types.js";

export interface PmgOptions {
  url: string;
  username: string;
  password: string;
  caFile?: string;
  insecure?: boolean;
}

export interface PmgContent {
  id: string;
  /** The complete raw message: headers, blank line, body. */
  content: string;
  header: string;
  spaminfo: SpamRule[];
  spamlevel: number;
}

export type PmgAction = "deliver" | "delete";

const TICKET_MAX_AGE_MS = 90 * 60 * 1000; // PMG tickets last two hours
const ID_PATTERN = /^C\d+R\d+T\d+$/;

export class PmgError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Minimal client for the Proxmox Mail Gateway quarantine API. */
export class PmgClient {
  private readonly base: string;
  private readonly agent: Agent;
  private ticket?: { value: string; csrf: string; at: number };

  constructor(private readonly opts: PmgOptions) {
    this.base = opts.url.replace(/\/+$/, "") + "/api2/json";
    this.agent = new Agent({
      connect: {
        ca: opts.caFile ? readFileSync(opts.caFile) : undefined,
        rejectUnauthorized: !opts.insecure,
      },
    });
  }

  private async login(): Promise<void> {
    const res = await fetch(`${this.base}/access/ticket`, {
      method: "POST",
      dispatcher: this.agent,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: this.opts.username, password: this.opts.password }),
    });
    if (!res.ok) {
      const hint = !this.opts.username.includes("@")
        ? ` PMG_USERNAME "${this.opts.username}" has no realm; use ${this.opts.username}@pmg (or root@pam).`
        : res.status === 401
          ? " Check PMG_USERNAME and PMG_PASSWORD, and that the user has no two-factor login."
          : "";
      throw new PmgError(`PMG login failed (HTTP ${res.status}).${hint}`, res.status);
    }
    const body = (await res.json()) as { data?: { ticket?: string; CSRFPreventionToken?: string } };
    if (!body.data?.ticket || !body.data.CSRFPreventionToken) {
      throw new PmgError("PMG login returned no ticket");
    }
    this.ticket = { value: body.data.ticket, csrf: body.data.CSRFPreventionToken, at: Date.now() };
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    params: Record<string, string | number>,
    retry = true,
  ): Promise<T> {
    if (!this.ticket || Date.now() - this.ticket.at > TICKET_MAX_AGE_MS) await this.login();
    const ticket = this.ticket!;
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) form.set(k, String(v));

    const url = method === "GET" ? `${this.base}${path}?${form}` : `${this.base}${path}`;
    const res = await fetch(url, {
      method,
      dispatcher: this.agent,
      headers: {
        Cookie: `PMGAuthCookie=${encodeURIComponent(ticket.value)}`,
        ...(method === "POST"
          ? { CSRFPreventionToken: ticket.csrf, "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
      },
      body: method === "POST" ? form : undefined,
    });

    if (res.status === 401 && retry) {
      this.ticket = undefined;
      return this.request<T>(method, path, params, false);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new PmgError(`PMG ${method} ${path} failed (HTTP ${res.status}) ${text.slice(0, 200)}`, res.status);
    }
    const body = (await res.json()) as { data: T };
    return body.data;
  }

  /** Every quarantined spam message for every receiver between two unix times. */
  async listQuarantine(starttime: number, endtime: number): Promise<QuarantineItem[]> {
    const users = await this.request<{ mail: string }[]>("GET", "/quarantine/spamusers", { starttime, endtime });
    const items = new Map<string, QuarantineItem>();
    for (const { mail } of users) {
      const rows = await this.request<QuarantineItem[]>("GET", "/quarantine/spam", {
        pmail: mail,
        starttime,
        endtime,
      });
      for (const r of rows) {
        items.set(r.id, {
          id: r.id,
          receiver: r.receiver ?? mail,
          envelope_sender: r.envelope_sender ?? "",
          from: r.from ?? "",
          subject: r.subject ?? "",
          time: Number(r.time),
          spamlevel: Number(r.spamlevel ?? 0),
          bytes: Number(r.bytes ?? 0),
        });
      }
    }
    return [...items.values()];
  }

  /** The full raw message plus the spam rules PMG matched. */
  async getContent(id: string): Promise<PmgContent> {
    assertId(id);
    const data = await this.request<Partial<PmgContent>>("GET", "/quarantine/content", { id, raw: 1 });
    // PMG returns the headers and the body separately; "content" is the body alone.
    // Rejoin them, or the MIME structure (parts, encodings, charset) cannot be decoded.
    const { header, raw } = joinMessage(data.header ?? "", data.content ?? "");
    return {
      id,
      content: raw,
      header,
      spaminfo: Array.isArray(data.spaminfo)
        ? data.spaminfo.map((r) => ({ name: String(r.name), score: Number(r.score), desc: r.desc }))
        : [],
      spamlevel: Number(data.spamlevel ?? 0),
    };
  }

  /**
   * Add a sender address or domain to one of PMG's system-wide rule lists
   * (the "who" groups behind the Welcomelist and Blocklist rules). Needs the
   * PMG Administrator role. Returns false when the entry was already there.
   */
  async addToList(groupName: string, kind: "email" | "domain", value: string): Promise<boolean> {
    const groups = await this.request<{ id: number; name: string }[]>("GET", "/config/ruledb/who", {});
    const group = groups.find((g) => g.name.toLowerCase() === groupName.toLowerCase());
    if (!group) throw new PmgError(`PMG has no rule list called "${groupName}"`);
    const existing = await this.request<{ email?: string; domain?: string }[]>(
      "GET",
      `/config/ruledb/who/${group.id}/objects`,
      {},
    );
    if (existing.some((o) => (o[kind] ?? "").toLowerCase() === value.toLowerCase())) return false;
    await this.request<number>("POST", `/config/ruledb/who/${group.id}/${kind}`, { [kind]: value });
    return true;
  }

  /** Deliver messages to their mailbox, or delete them from the quarantine. */
  async act(action: PmgAction, ids: string[]): Promise<void> {
    ids.forEach(assertId);
    for (let i = 0; i < ids.length; i += 50) {
      await this.request<null>("POST", "/quarantine/content", {
        action,
        id: ids.slice(i, i + 50).join(";"),
      });
    }
  }
}

const MIME_HEADER = /^(mime-version|content-type):/im;

/**
 * Rebuild the raw message from PMG's separate header and body.
 *
 * Some senders put a whitespace-only line in the middle of their headers. PMG
 * ends the header there, so the rest of the headers (including Content-Type)
 * arrive at the top of the body. When that has happened, move them back.
 */
export function joinMessage(headerIn: string, body: string): { header: string; raw: string } {
  let header = headerIn.replace(/\s+$/, "");
  if (!header) return { header, raw: body };

  if (!MIME_HEADER.test(header)) {
    const end = body.search(/\r?\n\r?\n/);
    const spill = end < 0 ? "" : body.slice(0, end);
    if (spill.length < 20_000 && MIME_HEADER.test(spill)) {
      const lines = spill.split(/\r?\n/).filter((l) => l.trim() !== "");
      // A first line that is not "Name: value" continues the header PMG cut short.
      if (lines[0] && !/^[!-9;-~]+:/.test(lines[0]) && !/^[ \t]/.test(lines[0])) lines[0] = ` ${lines[0]}`;
      header = `${header}\n${lines.join("\n")}`;
      body = body.slice(end).replace(/^(\r?\n){2}/, "");
    }
  }
  return { header, raw: `${header}\n\n${body}` };
}

function assertId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new PmgError(`Not a PMG quarantine id: ${id}`);
}

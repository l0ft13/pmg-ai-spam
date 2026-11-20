import { simpleParser } from "mailparser";

export interface MailLink {
  href: string;
  /** Visible link text, when it came from an HTML anchor. */
  text?: string;
}

export interface ParsedMail {
  from: string;
  to: string;
  replyTo: string;
  returnPath: string;
  subject: string;
  date: string;
  authResults: string[];
  receivedSpf: string;
  text: string;
  /** The HTML part, untouched and untrusted. Empty for plain-text mail. */
  html: string;
  links: MailLink[];
  /** The http(s) and mailto addresses the sender's List-Unsubscribe header offers. */
  listUnsubscribe: string[];
  /** The sender accepts a one-click unsubscribe POST (RFC 8058) to its https address. */
  oneClickUnsubscribe: boolean;
  attachments: { filename: string; contentType: string; size: number }[];
}

const MAX_LINKS = 40;
/** Unsubscribe links sit at the foot of a mail, so the last few links are kept when a long list is cut. */
const TAIL_LINKS = 10;

function headerText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(headerText).join("; ");
  if (typeof value === "object" && "text" in value) return String((value as { text: unknown }).text);
  return String(value);
}

function headerList(value: unknown): string[] {
  if (value == null) return [];
  return Array.isArray(value) ? value.map(headerText) : [headerText(value)];
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLinks(html: string, text: string): MailLink[] {
  const seen = new Set<string>();
  const links: MailLink[] = [];
  const add = (href: string, label?: string) => {
    const clean = href.trim();
    if (!/^(https?:|mailto:|tel:)/i.test(clean) || seen.has(clean)) return;
    seen.add(clean);
    links.push({ href: clean, text: label || undefined });
  };
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    add(m[1]!.replace(/&amp;/g, "&"), stripTags(m[2] ?? "").slice(0, 120));
  }
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) add(m[0]);
  if (links.length <= MAX_LINKS) return links;
  return [...links.slice(0, MAX_LINKS - TAIL_LINKS), ...links.slice(-TAIL_LINKS)];
}

/** The addresses inside a raw "List-Unsubscribe: <https://...>, <mailto:...>" header line. */
function unsubscribeTargets(line: string): string[] {
  return [...line.replace(/^[^:]*:/, "").matchAll(/<([^<>]+)>/g)]
    .map((m) => m[1]!.replace(/\s+/g, "")) // folding can split a long address
    .filter((u) => /^(https?:|mailto:)/i.test(u));
}

/** Parse a raw RFC 822 message into the parts the classifier and the preview use. */
export async function parseMail(raw: string, opts: { inlineImages?: boolean } = {}): Promise<ParsedMail> {
  // inlineImages turns embedded (cid:) pictures into data: URIs so a preview can show them.
  const mail = await simpleParser(raw, { skipImageLinks: !opts.inlineImages });
  const html = typeof mail.html === "string" ? mail.html : "";
  const text = (mail.text ?? stripTags(html)).replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const h = mail.headers;
  const rawHeader = (key: string) => mail.headerLines.find((l) => l.key === key)?.line ?? "";
  return {
    from: headerText(h.get("from")),
    to: headerText(h.get("to")),
    replyTo: headerText(h.get("reply-to")),
    returnPath: headerText(h.get("return-path")),
    subject: mail.subject ?? "",
    date: mail.date ? mail.date.toISOString() : "",
    authResults: headerList(h.get("authentication-results")),
    receivedSpf: headerText(h.get("received-spf")),
    text,
    html,
    links: extractLinks(html, text),
    listUnsubscribe: unsubscribeTargets(rawHeader("list-unsubscribe")),
    oneClickUnsubscribe: /one-click/i.test(rawHeader("list-unsubscribe-post")),
    attachments: mail.attachments.map((a) => ({
      filename: a.filename ?? "(unnamed)",
      contentType: a.contentType,
      size: a.size,
    })),
  };
}

/** One attachment's bytes, by its position in ParsedMail.attachments (parsed with inlineImages). */
export async function getAttachment(
  raw: string,
  index: number,
): Promise<{ filename: string; content: Buffer } | undefined> {
  const mail = await simpleParser(raw, { skipImageLinks: false });
  const a = mail.attachments[index];
  return a ? { filename: a.filename ?? `attachment-${index + 1}`, content: a.content } : undefined;
}

/**
 * What the messages of one wave have in common: who they claim to be from and
 * their subject, with the parts that change per recipient (the recipient's own
 * name, numbers, reference codes) taken out. Empty when there is nothing to go on.
 */
export function groupKey(from: string, subject: string, receiver: string): string {
  const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  // The display name rather than the address, which a wave often changes per message.
  const name = words(from.replace(/<[^<>]*>/g, " ").replace(/\S+@\S+/g, " ")).join(" ");
  const who = name || senderAddress(from).split("@")[1] || "";
  const to = receiver.toLowerCase();
  const own = new Set(words(to.split("@")[0] ?? ""));
  const subj = words(to ? subject.toLowerCase().split(to).join(" ") : subject)
    .filter((w) => !own.has(w))
    .map((w) => (/\p{N}/u.test(w) ? "#" : w))
    .join(" ");
  return who || subj ? `${who}|${subj}`.slice(0, 190) : "";
}

/** The bare address out of a From header, lower-cased. */
export function senderAddress(from: string): string {
  const angle = from.match(/<([^<>\s]+@[^<>\s]+)>/);
  const bare = angle?.[1] ?? from.match(/[^\s<>"]+@[^\s<>"]+/)?.[0] ?? "";
  return bare.toLowerCase();
}

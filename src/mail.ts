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
  attachments: { filename: string; contentType: string; size: number }[];
}

const MAX_LINKS = 40;

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
    if (links.length < MAX_LINKS) links.push({ href: clean, text: label || undefined });
  };
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    add(m[1]!.replace(/&amp;/g, "&"), stripTags(m[2] ?? "").slice(0, 120));
  }
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) add(m[0]);
  return links;
}

/** Parse a raw RFC 822 message into the parts the classifier and the preview use. */
export async function parseMail(raw: string, opts: { inlineImages?: boolean } = {}): Promise<ParsedMail> {
  // inlineImages turns embedded (cid:) pictures into data: URIs so a preview can show them.
  const mail = await simpleParser(raw, { skipImageLinks: !opts.inlineImages });
  const html = typeof mail.html === "string" ? mail.html : "";
  const text = (mail.text ?? stripTags(html)).replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const h = mail.headers;
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

/** The bare address out of a From header, lower-cased. */
export function senderAddress(from: string): string {
  const angle = from.match(/<([^<>\s]+@[^<>\s]+)>/);
  const bare = angle?.[1] ?? from.match(/[^\s<>"]+@[^\s<>"]+/)?.[0] ?? "";
  return bare.toLowerCase();
}

import { z } from "zod";
import type { ParsedMail } from "../mail.js";
import type { Classification } from "../types.js";
import { CATEGORIES, type ClassifyInput } from "./prompt.js";

export interface Classifier {
  readonly provider: string;
  readonly model: string;
  classify(input: ClassifyInput): Promise<Classification>;
}

/** What every provider must return. Kept free of numeric bounds so it works as a structured-output schema. */
export const VerdictSchema = z.object({
  verdict: z.enum(["spam", "legitimate", "unsure"]),
  confidence: z.number(),
  category: z.enum(CATEGORIES),
  reason: z.string(),
  block_advice: z.enum(["none", "address", "domain"]),
  block_reason: z.string(),
  /** Position in the prompt's numbered Links list, 0 for none. */
  unsubscribe_link: z.number(),
});
export type RawVerdict = z.infer<typeof VerdictSchema>;

/** Mail where an "unsubscribe" link is bait, or only tells the sender the address is read. */
const NO_UNSUBSCRIBE = new Set<string>(["phishing", "scam", "malware"]);
const MAX_UNSUBSCRIBE_URL = 2000;

/**
 * The unsubscribe address to offer: the sender's one-click header when there is
 * one, then the body link the model pointed at, then the header's plain web address.
 * The model only ever picks a link by number, so it cannot introduce an address of its own.
 */
export function pickUnsubscribe(
  raw: Pick<RawVerdict, "category" | "unsubscribe_link">,
  mail: Pick<ParsedMail, "links" | "listUnsubscribe" | "oneClickUnsubscribe">,
): Pick<Classification, "unsubscribe_url" | "unsubscribe_post"> {
  const none = { unsubscribe_url: "", unsubscribe_post: false };
  if (NO_UNSUBSCRIBE.has(raw.category)) return none;
  const usable = (u: string | undefined): u is string =>
    !!u && /^https?:\/\//i.test(u) && u.length <= MAX_UNSUBSCRIBE_URL && URL.canParse(u);
  const header = mail.listUnsubscribe.filter(usable);
  const oneClick = mail.oneClickUnsubscribe ? header.find((u) => /^https:/i.test(u)) : undefined;
  if (oneClick) return { unsubscribe_url: oneClick, unsubscribe_post: true };
  const picked = mail.links[Math.round(raw.unsubscribe_link) - 1]?.href;
  const url = usable(picked) ? picked : header[0];
  return url ? { unsubscribe_url: url, unsubscribe_post: false } : none;
}

export function toClassification(raw: RawVerdict, provider: string, model: string, mail: ParsedMail): Classification {
  return {
    verdict: raw.verdict,
    confidence: Math.max(0, Math.min(100, Math.round(raw.confidence))),
    category: raw.category,
    reason: raw.reason.trim().slice(0, 500),
    // Never suggest blocking the sender of mail the model does not itself call spam.
    block_advice: raw.verdict === "spam" ? raw.block_advice : "none",
    block_reason: raw.block_reason.trim().slice(0, 300),
    ...pickUnsubscribe(raw, mail),
    provider,
    model,
  };
}

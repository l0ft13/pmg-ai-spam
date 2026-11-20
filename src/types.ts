export type Verdict = "spam" | "legitimate" | "unsure";
export type Status = "pending" | "released" | "deleted" | "gone";
export type Action = "release" | "delete";
/** Whether the AI thinks the sender is worth blocklisting, and how widely. */
export type BlockAdvice = "none" | "address" | "domain";

/** One entry from the PMG spam quarantine listing. */
export interface QuarantineItem {
  id: string;
  receiver: string;
  envelope_sender: string;
  from: string;
  subject: string;
  time: number;
  spamlevel: number;
  bytes: number;
}

export interface SpamRule {
  name: string;
  score: number;
  desc?: string;
}

export interface Classification {
  verdict: Verdict;
  /** 0-100 */
  confidence: number;
  category: string;
  reason: string;
  block_advice: BlockAdvice;
  block_reason: string;
  /** Where to unsubscribe from this sender; empty when the mail offers nothing usable. */
  unsubscribe_url: string;
  /** The address takes a one-click POST (RFC 8058) rather than a visit. */
  unsubscribe_post: boolean;
  provider: string;
  model: string;
}

export interface MessageRow {
  id: number;
  pmg_id: string;
  receiver: string;
  envelope_sender: string;
  from_header: string;
  sender_addr: string;
  subject: string;
  received_at: Date;
  spamlevel: number;
  bytes: number;
  status: Status;
  verdict: Verdict | null;
  confidence: number | null;
  category: string | null;
  reason: string | null;
  block_advice: BlockAdvice | null;
  block_reason: string | null;
  unsubscribe_url: string | null;
  /** MySQL hands this back as 0 or 1. */
  unsubscribe_post: boolean | number | null;
  provider: string | null;
  model: string | null;
  classify_error: string | null;
  attempts: number;
  updated_at: Date;
}

export interface PastDecision {
  from_header: string;
  subject: string;
  action: Action;
  ai_verdict: Verdict | null;
}

export interface SenderHistory {
  released: number;
  deleted: number;
}

export interface Stats {
  pending: number;
  decisions: number;
  agreed: number;
  /** Released by a person although the AI said spam. */
  missedLegitimate: number;
  /** Deleted by a person although the AI said legitimate. */
  missedSpam: number;
}

export type View = "review" | "spam" | "history";

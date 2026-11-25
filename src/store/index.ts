import type {
  Action,
  Classification,
  MessageRow,
  PastDecision,
  QuarantineItem,
  SenderHistory,
  SimilarHistory,
  Stats,
  View,
} from "../types.js";

/** Everything the app remembers: what was quarantined, what the AI said, what a person decided. */
export interface Store {
  init(): Promise<void>;
  close(): Promise<void>;
  /** Insert quarantine entries not seen before; known ones are left alone. */
  upsertItems(items: QuarantineItem[]): Promise<void>;
  /** Pending messages that still need a verdict, blocking advice or an unsubscribe lookup (fewer than 3 attempts). */
  unclassified(limit: number): Promise<MessageRow[]>;
  saveClassification(id: number, c: Classification): Promise<void>;
  saveClassifyError(id: number, error: string): Promise<void>;
  /** Give pending messages whose classification failed a fresh set of attempts. */
  retryFailed(): Promise<void>;
  /** Mark pending messages that PMG no longer lists (expired, or handled in PMG itself). */
  markGone(presentPmgIds: string[]): Promise<number>;
  list(view: View, spamHideConfidence: number): Promise<MessageRow[]>;
  /** Every message still waiting for a decision, whichever view it sits in. */
  pending(): Promise<MessageRow[]>;
  getMany(ids: number[]): Promise<MessageRow[]>;
  /** Record a person's decision and close the messages. */
  recordAction(ids: number[], action: Action, actor: string): Promise<void>;
  recentDecisions(limit: number): Promise<PastDecision[]>;
  senderHistory(senderAddr: string): Promise<SenderHistory>;
  /** Past decisions on mail sharing each group key. Keys nobody has decided on are left out. */
  groupHistory(groupKeys: string[]): Promise<Record<string, SimilarHistory>>;
  stats(): Promise<Stats>;
  /** How many messages each view of the review screen holds. */
  counts(spamHideConfidence: number): Promise<Record<View, number>>;
}

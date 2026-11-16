import { senderAddress } from "../mail.js";
import type {
  Action,
  Classification,
  MessageRow,
  PastDecision,
  QuarantineItem,
  SenderHistory,
  Stats,
  Verdict,
  View,
} from "../types.js";
import type { Store } from "./index.js";

interface Decision {
  message_id: number;
  action: Action;
  ai_verdict: Verdict | null;
  at: number;
}

/** In-RAM store for demos and tests. Nothing survives a restart. */
export class MemoryStore implements Store {
  private rows: MessageRow[] = [];
  private decisions: Decision[] = [];
  private nextId = 1;

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async upsertItems(items: QuarantineItem[]): Promise<void> {
    for (const it of items) {
      if (this.rows.some((r) => r.pmg_id === it.id)) continue;
      this.rows.push({
        id: this.nextId++,
        pmg_id: it.id,
        receiver: it.receiver,
        envelope_sender: it.envelope_sender,
        from_header: it.from,
        sender_addr: senderAddress(it.from),
        subject: it.subject,
        received_at: new Date(it.time * 1000),
        spamlevel: it.spamlevel,
        bytes: it.bytes,
        status: "pending",
        verdict: null,
        confidence: null,
        category: null,
        reason: null,
        block_advice: null,
        block_reason: null,
        provider: null,
        model: null,
        classify_error: null,
        attempts: 0,
        updated_at: new Date(),
      });
    }
  }

  private byNewest(rows: MessageRow[]): MessageRow[] {
    return [...rows].sort((a, b) => b.received_at.getTime() - a.received_at.getTime());
  }

  async unclassified(limit: number): Promise<MessageRow[]> {
    return this.byNewest(
      this.rows.filter((r) => r.status === "pending" && (r.verdict === null || r.block_advice === null) && r.attempts < 3),
    ).slice(0, limit);
  }

  async saveClassification(id: number, c: Classification): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    Object.assign(row, c, { classify_error: null, attempts: row.attempts + 1, updated_at: new Date() });
  }

  async saveClassifyError(id: number, error: string): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    row.classify_error = error.slice(0, 500);
    row.attempts += 1;
  }

  async retryFailed(): Promise<void> {
    for (const r of this.rows) if (r.status === "pending" && r.verdict === null) r.attempts = 0;
  }

  async markGone(presentPmgIds: string[]): Promise<number> {
    const present = new Set(presentPmgIds);
    let n = 0;
    for (const r of this.rows) {
      if (r.status === "pending" && !present.has(r.pmg_id)) {
        r.status = "gone";
        n++;
      }
    }
    return n;
  }

  async list(view: View, spamHideConfidence: number): Promise<MessageRow[]> {
    const obvious = (r: MessageRow) => r.verdict === "spam" && (r.confidence ?? 0) >= spamHideConfidence;
    if (view === "history") {
      return this.rows
        .filter((r) => r.status === "released" || r.status === "deleted")
        .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime());
    }
    const pending = this.rows.filter((r) => r.status === "pending");
    if (view === "spam") return this.byNewest(pending.filter(obvious));
    const rank = { legitimate: 0, unsure: 1, spam: 2 } as const;
    return this.byNewest(pending.filter((r) => !obvious(r))).sort(
      (a, b) => rank[a.verdict ?? "unsure"] - rank[b.verdict ?? "unsure"],
    );
  }

  async getMany(ids: number[]): Promise<MessageRow[]> {
    return this.rows.filter((r) => ids.includes(r.id));
  }

  async recordAction(ids: number[], action: Action, _actor: string): Promise<void> {
    for (const r of this.rows) {
      if (!ids.includes(r.id) || r.status !== "pending") continue;
      this.decisions.push({ message_id: r.id, action, ai_verdict: r.verdict, at: Date.now() });
      r.status = action === "release" ? "released" : "deleted";
      r.updated_at = new Date();
    }
  }

  async recentDecisions(limit: number): Promise<PastDecision[]> {
    return [...this.decisions]
      .sort((a, b) => Number(b.action === "release") - Number(a.action === "release") || b.at - a.at)
      .slice(0, limit)
      .map((d) => {
        const m = this.rows.find((r) => r.id === d.message_id)!;
        return { from_header: m.from_header, subject: m.subject, action: d.action, ai_verdict: d.ai_verdict };
      });
  }

  async senderHistory(senderAddr: string): Promise<SenderHistory> {
    const same = this.rows.filter((r) => senderAddr && r.sender_addr === senderAddr);
    return {
      released: same.filter((r) => r.status === "released").length,
      deleted: same.filter((r) => r.status === "deleted").length,
    };
  }

  async counts(spamHideConfidence: number): Promise<Record<View, number>> {
    const pending = this.rows.filter((r) => r.status === "pending");
    const spam = pending.filter((r) => r.verdict === "spam" && (r.confidence ?? 0) >= spamHideConfidence).length;
    return {
      review: pending.length - spam,
      spam,
      history: this.rows.filter((r) => r.status === "released" || r.status === "deleted").length,
    };
  }

  async stats(): Promise<Stats> {
    const d = this.decisions;
    return {
      pending: this.rows.filter((r) => r.status === "pending").length,
      decisions: d.length,
      agreed: d.filter(
        (x) =>
          (x.action === "release" && x.ai_verdict === "legitimate") ||
          (x.action === "delete" && x.ai_verdict === "spam"),
      ).length,
      missedLegitimate: d.filter((x) => x.action === "release" && x.ai_verdict === "spam").length,
      missedSpam: d.filter((x) => x.action === "delete" && x.ai_verdict === "legitimate").length,
    };
  }
}

import type { Classifier } from "./classifier/index.js";
import { parseMail } from "./mail.js";
import type { PmgClient } from "./pmg.js";
import type { Store } from "./store/index.js";
import type { MessageRow } from "./types.js";

export interface PollDeps {
  pmg: PmgClient;
  store: Store;
  classifier: Classifier;
  quarantineDays: number;
  bodyCharLimit: number;
  log?: (msg: string) => void;
}

export interface PollResult {
  listed: number;
  classified: number;
  failed: number;
  gone: number;
}

const CONCURRENCY = 3;
const PAST_DECISIONS = 20;

/** Fetches the quarantine, records new entries and asks the classifier about them. Advisory only: it never releases or deletes. */
export class Poller {
  private running?: Promise<PollResult>;
  lastRun?: { at: Date; result?: PollResult; error?: string };

  constructor(private readonly deps: PollDeps) {}

  /** Run one poll. A call made while one is in flight joins it. */
  run(): Promise<PollResult> {
    this.running ??= this.pollOnce()
      .then((result) => {
        this.lastRun = { at: new Date(), result };
        return result;
      })
      .catch((err: unknown) => {
        this.lastRun = { at: new Date(), error: err instanceof Error ? err.message : String(err) };
        throw err;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private async pollOnce(): Promise<PollResult> {
    const { pmg, store, quarantineDays } = this.deps;
    const now = Math.floor(Date.now() / 1000);
    const items = await pmg.listQuarantine(now - quarantineDays * 86400, now + 3600);
    await store.upsertItems(items);
    const gone = await store.markGone(items.map((i) => i.id));

    const todo = await store.unclassified(500);
    let classified = 0;
    let failed = 0;
    const queue = [...todo];
    const worker = async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        try {
          await this.classify(row);
          classified++;
        } catch (err) {
          failed++;
          const message = err instanceof Error ? err.message : String(err);
          await store.saveClassifyError(row.id, message);
          this.deps.log?.(`classify ${row.pmg_id} failed: ${message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return { listed: items.length, classified, failed, gone };
  }

  private async classify(row: MessageRow): Promise<void> {
    const { pmg, store, classifier, bodyCharLimit } = this.deps;
    const content = await pmg.getContent(row.pmg_id);
    const mail = await parseMail(content.content);
    const [senderHistory, pastDecisions, similar] = await Promise.all([
      store.senderHistory(row.sender_addr),
      store.recentDecisions(PAST_DECISIONS),
      store.groupHistory(row.group_key ? [row.group_key] : []),
    ]);
    const verdict = await classifier.classify({
      item: {
        id: row.pmg_id,
        receiver: row.receiver,
        envelope_sender: row.envelope_sender,
        from: row.from_header,
        subject: row.subject,
        time: Math.floor(row.received_at.getTime() / 1000),
        spamlevel: Number(row.spamlevel),
        bytes: row.bytes,
      },
      mail,
      rules: content.spaminfo,
      senderHistory,
      similarHistory: similar[row.group_key ?? ""] ?? { released: 0, deleted: 0, last_at: null },
      pastDecisions,
      bodyCharLimit,
    });
    await store.saveClassification(row.id, verdict);
  }
}

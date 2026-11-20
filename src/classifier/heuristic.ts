import type { Classification } from "../types.js";
import { toClassification, type Classifier, type RawVerdict } from "./schema.js";
import type { ClassifyInput } from "./prompt.js";

/**
 * No AI at all: a verdict from the gateway score and sender history.
 * For demos and tests, so the rest of the system can run without a model.
 */
export class HeuristicClassifier implements Classifier {
  readonly provider = "heuristic";
  readonly model = "pmg-score";

  async classify({ item, senderHistory, mail }: ClassifyInput): Promise<Classification> {
    const score = item.spamlevel;
    // Nothing reads the body here, so only a List-Unsubscribe header can yield an unsubscribe link.
    const done = (raw: Omit<RawVerdict, "unsubscribe_link">) =>
      toClassification({ ...raw, unsubscribe_link: 0 }, this.provider, this.model, mail);
    if (senderHistory.released > 0 && senderHistory.deleted === 0) {
      return done({ verdict: "legitimate", confidence: 70, category: "business", reason: "Mail from this sender was released before.", block_advice: "none", block_reason: "No AI is configured, so there is no blocking advice." });
    }
    if (score >= 10) {
      return done({ verdict: "spam", confidence: 95, category: "other", reason: `Gateway score ${score} is very high.`, block_advice: "none", block_reason: "No AI is configured, so there is no blocking advice." });
    }
    if (score >= 6) {
      return done({ verdict: "spam", confidence: 70, category: "other", reason: `Gateway score ${score} is high.`, block_advice: "none", block_reason: "No AI is configured, so there is no blocking advice." });
    }
    return done({ verdict: "unsure", confidence: 40, category: "other", reason: `Gateway score ${score} is borderline.`, block_advice: "none", block_reason: "" });
  }
}

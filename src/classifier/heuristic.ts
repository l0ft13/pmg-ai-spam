import type { Classification } from "../types.js";
import { toClassification, type Classifier } from "./schema.js";
import type { ClassifyInput } from "./prompt.js";

/**
 * No AI at all: a verdict from the gateway score and sender history.
 * For demos and tests, so the rest of the system can run without a model.
 */
export class HeuristicClassifier implements Classifier {
  readonly provider = "heuristic";
  readonly model = "pmg-score";

  async classify({ item, senderHistory }: ClassifyInput): Promise<Classification> {
    const score = item.spamlevel;
    if (senderHistory.released > 0 && senderHistory.deleted === 0) {
      return toClassification(
        { verdict: "legitimate", confidence: 70, category: "business", reason: "Mail from this sender was released before.", block_advice: "none", block_reason: "No AI is configured, so there is no blocking advice." },
        this.provider,
        this.model,
      );
    }
    if (score >= 10) {
      return toClassification(
        { verdict: "spam", confidence: 95, category: "other", reason: `Gateway score ${score} is very high.`, block_advice: "none", block_reason: "No AI is configured, so there is no blocking advice." },
        this.provider,
        this.model,
      );
    }
    if (score >= 6) {
      return toClassification(
        { verdict: "spam", confidence: 70, category: "other", reason: `Gateway score ${score} is high.`, block_advice: "none", block_reason: "No AI is configured, so there is no blocking advice." },
        this.provider,
        this.model,
      );
    }
    return toClassification(
      { verdict: "unsure", confidence: 40, category: "other", reason: `Gateway score ${score} is borderline.`, block_advice: "none", block_reason: "" },
      this.provider,
      this.model,
    );
  }
}

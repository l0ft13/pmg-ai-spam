import type { Classification } from "../types.js";
import { toClassification, VerdictSchema, type Classifier } from "./schema.js";
import { buildUserMessage, CATEGORIES, SYSTEM_PROMPT, type ClassifyInput } from "./prompt.js";

const FORMAT = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["spam", "legitimate", "unsure"] },
    confidence: { type: "number" },
    category: { type: "string", enum: [...CATEGORIES] },
    reason: { type: "string" },
    block_advice: { type: "string", enum: ["none", "address", "domain"] },
    block_reason: { type: "string" },
    unsubscribe_link: { type: "number" },
  },
  required: ["verdict", "confidence", "category", "reason", "block_advice", "block_reason", "unsubscribe_link"],
};

/** Local model served by Ollama; mail content never leaves the network. */
export class OllamaClassifier implements Classifier {
  readonly provider = "ollama";

  constructor(
    private readonly baseUrl: string,
    readonly model: string,
  ) {}

  async classify(input: ClassifyInput): Promise<Classification> {
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: FORMAT,
        options: { temperature: 0 },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserMessage(input) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { message?: { content?: string } };
    const parsed = VerdictSchema.parse(JSON.parse(body.message?.content ?? ""));
    return toClassification(parsed, this.provider, this.model, input.mail);
  }
}

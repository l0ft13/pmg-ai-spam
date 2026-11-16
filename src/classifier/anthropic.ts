import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Classification } from "../types.js";
import { toClassification, VerdictSchema, type Classifier } from "./schema.js";
import { buildUserMessage, SYSTEM_PROMPT, type ClassifyInput } from "./prompt.js";

export class AnthropicClassifier implements Classifier {
  readonly provider = "anthropic";
  private readonly client = new Anthropic(); // reads ANTHROPIC_API_KEY

  constructor(readonly model: string) {}

  async classify(input: ClassifyInput): Promise<Classification> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 4000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      output_config: { effort: "low", format: zodOutputFormat(VerdictSchema) },
      messages: [{ role: "user", content: buildUserMessage(input) }],
    });

    // A declined request must never hide a message: send it to review.
    if (response.stop_reason === "refusal") {
      return toClassification(
        { verdict: "unsure", confidence: 0, category: "other", reason: "The AI declined to assess this message.", block_advice: "none", block_reason: "" },
        this.provider,
        this.model,
      );
    }
    if (!response.parsed_output) {
      throw new Error(`No structured verdict returned (stop_reason: ${response.stop_reason})`);
    }
    return toClassification(response.parsed_output, this.provider, this.model);
  }
}

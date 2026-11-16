import { z } from "zod";
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
});
export type RawVerdict = z.infer<typeof VerdictSchema>;

export function toClassification(raw: RawVerdict, provider: string, model: string): Classification {
  return {
    verdict: raw.verdict,
    confidence: Math.max(0, Math.min(100, Math.round(raw.confidence))),
    category: raw.category,
    reason: raw.reason.trim().slice(0, 500),
    // Never suggest blocking the sender of mail the model does not itself call spam.
    block_advice: raw.verdict === "spam" ? raw.block_advice : "none",
    block_reason: raw.block_reason.trim().slice(0, 300),
    provider,
    model,
  };
}

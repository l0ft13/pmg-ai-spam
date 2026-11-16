import type { Config } from "../config.js";
import { AnthropicClassifier } from "./anthropic.js";
import { HeuristicClassifier } from "./heuristic.js";
import { OllamaClassifier } from "./ollama.js";
import type { Classifier } from "./schema.js";

export type { Classifier } from "./schema.js";

export function createClassifier(config: Config): Classifier {
  switch (config.AI_PROVIDER) {
    case "anthropic":
      return new AnthropicClassifier(config.ANTHROPIC_MODEL);
    case "ollama":
      return new OllamaClassifier(config.OLLAMA_URL, config.OLLAMA_MODEL);
    case "heuristic":
      return new HeuristicClassifier();
  }
}

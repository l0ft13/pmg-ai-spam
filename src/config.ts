import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  PMG_URL: z.string().url(),
  PMG_USERNAME: z.string().min(1),
  PMG_PASSWORD: z.string().min(1),
  PMG_CA_FILE: z.string().default(""),
  PMG_TLS_INSECURE: bool,
  PMG_WELCOMELIST_NAME: z.string().default("Welcomelist"),
  PMG_BLOCKLIST_NAME: z.string().default("Blocklist"),
  QUARANTINE_DAYS: z.coerce.number().int().min(1).max(60).default(7),

  DB_DRIVER: z.enum(["mysql", "memory"]).default("mysql"),
  DB_HOST: z.string().default("127.0.0.1"),
  DB_PORT: z.coerce.number().int().default(3306),
  DB_USER: z.string().default("mailtriage"),
  DB_PASSWORD: z.string().default(""),
  DB_NAME: z.string().default("mailtriage"),

  AI_PROVIDER: z.enum(["anthropic", "ollama", "heuristic"]).default("anthropic"),
  ANTHROPIC_MODEL: z.string().default("claude-haiku-5-5"),
  OLLAMA_URL: z.string().url().default("http://127.0.0.1:11434"),
  OLLAMA_MODEL: z.string().default("llama3.1:8b"),
  BODY_CHAR_LIMIT: z.coerce.number().int().min(500).default(8000),

  POLL_INTERVAL_MINUTES: z.coerce.number().min(1).default(5),
  SPAM_HIDE_CONFIDENCE: z.coerce.number().int().min(50).max(100).default(90),

  WEB_HOST: z.string().default("127.0.0.1"),
  WEB_PORT: z.coerce.number().int().default(8025),
  WEB_USER: z.string().min(1).default("admin"),
  WEB_PASSWORD: z.string().min(8, "WEB_PASSWORD must be at least 8 characters"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration (check .env):\n${lines.join("\n")}`);
  }
  return parsed.data;
}

import { existsSync } from "node:fs";
import { createClassifier } from "./classifier/index.js";
import { loadConfig } from "./config.js";
import { PmgClient } from "./pmg.js";
import { Poller } from "./poller.js";
import { buildServer } from "./server.js";
import type { Store } from "./store/index.js";
import { MemoryStore } from "./store/memory.js";
import { MysqlStore } from "./store/mysql.js";

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const config = loadConfig();

  const store: Store =
    config.DB_DRIVER === "memory"
      ? new MemoryStore()
      : new MysqlStore({
          host: config.DB_HOST,
          port: config.DB_PORT,
          user: config.DB_USER,
          password: config.DB_PASSWORD,
          database: config.DB_NAME,
        });
  await store.init();
  await store.retryFailed(); // a restart usually means the cause of earlier failures was fixed

  const pmg = new PmgClient({
    url: config.PMG_URL,
    username: config.PMG_USERNAME,
    password: config.PMG_PASSWORD,
    caFile: config.PMG_CA_FILE || undefined,
    insecure: config.PMG_TLS_INSECURE,
  });
  const classifier = createClassifier(config);
  const poller = new Poller({
    pmg,
    store,
    classifier,
    quarantineDays: config.QUARANTINE_DAYS,
    bodyCharLimit: config.BODY_CHAR_LIMIT,
    log,
  });

  const app = buildServer({
    pmg,
    store,
    poller,
    webUser: config.WEB_USER,
    webPassword: config.WEB_PASSWORD,
    spamHideConfidence: config.SPAM_HIDE_CONFIDENCE,
    welcomelistName: config.PMG_WELCOMELIST_NAME,
    blocklistName: config.PMG_BLOCKLIST_NAME,
    provider: classifier.provider,
    model: classifier.model,
  });
  await app.listen({ host: config.WEB_HOST, port: config.WEB_PORT });
  log(`Review screen on http://${config.WEB_HOST}:${config.WEB_PORT} (AI: ${classifier.provider}/${classifier.model})`);
  if (config.DB_DRIVER === "memory") log("DB_DRIVER=memory: nothing is saved between restarts");

  const tick = () =>
    poller
      .run()
      .then((r) => log(`poll: ${r.listed} in quarantine, ${r.classified} classified, ${r.failed} failed, ${r.gone} gone`))
      .catch((err: Error) => log(`poll failed: ${err.message}`));
  void tick();
  const timer = setInterval(tick, config.POLL_INTERVAL_MINUTES * 60_000);

  const stop = async () => {
    clearInterval(timer);
    await app.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});

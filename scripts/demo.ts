/**
 * Runs the whole app against the mock PMG with made-up mail, an in-RAM store
 * and no AI. Nothing real is contacted. Sign in with demo / demo-password.
 */
import { startMockPmg } from "./mock-pmg.js";

const mock = await startMockPmg();
Object.assign(process.env, {
  PMG_URL: mock.url,
  PMG_USERNAME: "triage@pmg",
  PMG_PASSWORD: "mock-password",
  DB_DRIVER: "memory",
  AI_PROVIDER: process.env.DEMO_AI_PROVIDER ?? "heuristic",
  WEB_HOST: "127.0.0.1",
  WEB_PORT: process.env.PORT ?? "8025",
  WEB_USER: "demo",
  WEB_PASSWORD: "demo-password",
});
console.log(`Mock PMG on ${mock.url}. Sign in to the review screen with demo / demo-password.`);
await import("../src/index.js");

import { pool } from "./db";
import { processBatch } from "./outbox";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let running = true;
process.on("SIGTERM", () => (running = false));
process.on("SIGINT", () => (running = false));

async function main() {
  console.log("outbox worker started");
  while (running) {
    try {
      const n = await processBatch();
      if (n > 0) console.log(`processed ${n} job(s)`);
      if (n === 0) await sleep(2000);
    } catch (e) {
      // e.g. database not migrated yet or temporarily down: log and retry
      console.error("worker error:", (e as Error).message);
      await sleep(3000);
    }
  }
  await pool.end();
}
main();

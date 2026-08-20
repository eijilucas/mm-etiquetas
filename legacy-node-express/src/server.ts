import { buildApp } from "./app";
import { config } from "./config";
import { logger } from "./lib/logger";
import { startShippingWorker } from "./queue/worker";
import { startReconciliationCron } from "./reconciliation/cron";

const app = buildApp();
const worker = startShippingWorker();
startReconciliationCron();

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, "server_started");
});

async function shutdown() {
  logger.info("shutting_down");
  await worker.close();
  server.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

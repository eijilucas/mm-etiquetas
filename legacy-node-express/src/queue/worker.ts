import { Worker, type Job } from "bullmq";
import { redisConnection } from "./connection";
import { SHIPPING_QUEUE_NAME, type ShippingJobData } from "./queue";
import { runShippingPipeline } from "../pipeline/shippingPipeline";
import { logger } from "../lib/logger";

export function startShippingWorker(): Worker<ShippingJobData> {
  const worker = new Worker<ShippingJobData>(
    SHIPPING_QUEUE_NAME,
    async (job: Job<ShippingJobData>) => {
      logger.info({ jobId: job.id, orderShippingId: job.data.orderShippingId }, "worker_job_start");
      await runShippingPipeline(job.data.orderShippingId);
    },
    { connection: redisConnection, concurrency: 5 },
  );

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id }, "worker_job_completed");
  });
  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "worker_job_failed");
  });

  return worker;
}

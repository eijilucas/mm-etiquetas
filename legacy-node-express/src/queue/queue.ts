import { Queue } from "bullmq";
import { redisConnection } from "./connection";

export const SHIPPING_QUEUE_NAME = "shipping-pipeline";

export interface ShippingJobData {
  orderShippingId: string;
}

export const shippingQueue = new Queue<ShippingJobData>(SHIPPING_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1000 },
  },
});

// Called only from the approval/reprocess endpoints — this is the single
// entry point that enqueues the shipping pipeline for a given order.
export async function enqueueShippingJob(orderShippingId: string): Promise<void> {
  await shippingQueue.add(
    "process-order",
    { orderShippingId },
    { jobId: `order-${orderShippingId}` },
  );
}

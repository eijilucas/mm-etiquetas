import IORedis from "ioredis";
import { config } from "../config";

export const redisConnection = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
});

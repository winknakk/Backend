import { config } from "../config/env";
import { IJobQueue } from "./types";
import { InMemoryJobQueue } from "./InMemoryJobQueue";
import { RedisJobQueue } from "./RedisJobQueue";

export class QueueFactory {
  private static instance: IJobQueue;

  static getQueue(): IJobQueue {
    if (!QueueFactory.instance) {
      const provider = config.QUEUE_PROVIDER || "memory";
      if (provider.toLowerCase() === "redis") {
        QueueFactory.instance = new RedisJobQueue();
      } else {
        QueueFactory.instance = new InMemoryJobQueue();
      }
    }
    return QueueFactory.instance;
  }
}

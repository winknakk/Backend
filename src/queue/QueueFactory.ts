import { config } from "../config/env";
import { IJobQueue } from "./types";
import { InMemoryJobQueue } from "./InMemoryJobQueue";
import { BullMQJobQueue } from "../infrastructure/queue/BullMQJobQueue";

export class QueueFactory {
  private static instance: IJobQueue;

  static getQueue(): IJobQueue {
    if (!QueueFactory.instance) {
      const provider = config.QUEUE_PROVIDER || "memory";
      if (provider.toLowerCase() === "redis") {
        QueueFactory.instance = new BullMQJobQueue();
      } else {
        QueueFactory.instance = new InMemoryJobQueue();
      }
    }
    return QueueFactory.instance;
  }
}

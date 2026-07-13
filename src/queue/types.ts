import { z } from "zod";
import { InboundMessage } from "../schemas/validation";

export const JobStatusSchema = z.enum(["QUEUED", "RUNNING", "COMPLETED", "FAILED"]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobPayloadSchema = z.object({
  jobId: z.string().uuid(),
  type: z.string(),
  data: z.any(),
  metadata: z.object({
    requestId: z.string(),
    receivedAt: z.string().datetime().optional(),
  }),
  status: JobStatusSchema.default("QUEUED"),
  retryCount: z.number().default(0),
  maxRetry: z.number().default(3),
  result: z.any().optional(),
  error: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
});
export type JobPayload = z.infer<typeof JobPayloadSchema>;

export interface IJobQueue {
  enqueue(payload: Omit<JobPayload, "jobId" | "status" | "retryCount" | "maxRetry"> & { retryCount?: number; maxRetry?: number }): Promise<string>;
  process(handler: (job: JobPayload) => Promise<any>): void;
  getJob(jobId: string): Promise<JobPayload | null>;
  getQueueDepth?(): Promise<number>;
}

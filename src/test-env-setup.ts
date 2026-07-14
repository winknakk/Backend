process.env.NODE_ENV = "test";

// If Redis is offline, inject in-memory mocks for ioredis and bullmq
const Module = require("module");
const originalRequire = Module.prototype.require;

const logger = {
  info: (...args: any[]) => console.log("[Mock-Queue]", ...args),
  warn: (...args: any[]) => console.warn("[Mock-Queue]", ...args),
  error: (...args: any[]) => console.error("[Mock-Queue]", ...args),
  debug: (...args: any[]) => console.debug("[Mock-Queue]", ...args),
};

class MockRedis {
  private static store = new Map<string, string>();
  private static lists = new Map<string, string[]>();
  private static subscribers = new Set<MockRedis>();
  private listeners: Map<string, Array<(...args: any[]) => void>> = new Map();
  private subscribedChannels = new Set<string>();

  constructor(url?: string, options?: any) {
    MockRedis.subscribers.add(this);
    setTimeout(() => {
      const connects = this.listeners.get("connect") || [];
      connects.forEach(cb => cb());
      const readys = this.listeners.get("ready") || [];
      readys.forEach(cb => cb());
    }, 10);
  }

  async set(key: string, value: string, ...args: any[]): Promise<string> {
    const isNx = args.includes("NX") || (args[2] === "NX") || (args[3] === "NX");
    if (isNx && MockRedis.store.has(key)) {
      return "FAIL";
    }
    MockRedis.store.set(key, value);
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    return MockRedis.store.get(key) || null;
  }

  async del(key: string): Promise<number> {
    const deleted = MockRedis.store.delete(key);
    return deleted ? 1 : 0;
  }

  async rpush(key: string, value: string): Promise<number> {
    if (!MockRedis.lists.has(key)) {
      MockRedis.lists.set(key, []);
    }
    MockRedis.lists.get(key)!.push(value);
    return MockRedis.lists.get(key)!.length;
  }

  async llen(key: string): Promise<number> {
    return MockRedis.lists.get(key)?.length || 0;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = MockRedis.lists.get(key) || [];
    return list.slice(start, stop === -1 ? undefined : stop + 1);
  }

  async flushdb(): Promise<string> {
    MockRedis.store.clear();
    MockRedis.lists.clear();
    return "OK";
  }

  async quit(): Promise<string> {
    MockRedis.subscribers.delete(this);
    return "OK";
  }

  async subscribe(channel: string): Promise<void> {
    this.subscribedChannels.add(channel);
    return;
  }

  async unsubscribe(channel: string): Promise<void> {
    this.subscribedChannels.delete(channel);
    return;
  }

  async publish(channel: string, message: string): Promise<number> {
    let count = 0;
    for (const sub of MockRedis.subscribers) {
      if (sub.subscribedChannels.has(channel)) {
        const cbs = sub.listeners.get("message") || [];
        cbs.forEach(cb => cb(channel, message));
        count++;
      }
    }
    return count;
  }

  on(event: string, callback: any) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);
  }
}

class MockQueue {
  public name: string;
  public static jobs = new Map<string, Map<string, MockJob>>();

  constructor(name: string, options?: any) {
    this.name = name;
    if (!MockQueue.jobs.has(name)) {
      MockQueue.jobs.set(name, new Map());
    }
  }

  async add(jobName: string, data: any, options?: any): Promise<any> {
    const jobId = options?.jobId || require("crypto").randomUUID();
    const job = new MockJob(jobId, jobName, data);
    MockQueue.jobs.get(this.name)!.set(jobId, job);

    // Trigger worker processing asynchronously
    const workers = MockWorker.workers.get(this.name) || [];
    for (const worker of workers) {
      setTimeout(async () => {
        try {
          await worker.processJob(job);
        } catch (err: any) {
          logger.error(`MockWorker failed job ${jobId}: ${err.message}`);
        }
      }, 50);
    }

    return job;
  }

  async getJob(jobId: string): Promise<any> {
    return MockQueue.jobs.get(this.name)?.get(jobId) || null;
  }

  async obliterate(options?: any): Promise<void> {
    MockQueue.jobs.get(this.name)?.clear();
  }

  async close(): Promise<void> {
    return;
  }
}

class MockJob {
  public id: string;
  public name: string;
  public data: any;
  public attemptsMade = 0;
  public returnvalue: any = null;
  public failedReason: string | null = null;
  public opts = { attempts: 3 };
  private state: string = "active";

  constructor(id: string, name: string, data: any) {
    this.id = id;
    this.name = name;
    this.data = data;
  }

  async getState(): Promise<string> {
    return this.state;
  }

  setState(state: string) {
    this.state = state;
  }
}

class MockWorker {
  public name: string;
  public handler: (job: any) => Promise<any>;
  public static workers = new Map<string, MockWorker[]>();
  private failedListeners: Array<(job: any, err: Error) => void> = [];
  private errorListeners: Array<(err: Error) => void> = [];

  constructor(name: string, handler: (job: any) => Promise<any>, options?: any) {
    this.name = name;
    this.handler = handler;
    if (!MockWorker.workers.has(name)) {
      MockWorker.workers.set(name, []);
    }
    MockWorker.workers.get(name)!.push(this);
  }

  async processJob(job: MockJob): Promise<void> {
    if (job.attemptsMade === 0) {
      job.attemptsMade = 1;
    }
    try {
      const res = await this.handler(job);
      job.returnvalue = res;
      job.setState("completed");
    } catch (err: any) {
      job.failedReason = err.message;
      job.setState("failed");

      // Handle retries
      if (job.attemptsMade < job.opts.attempts) {
        job.attemptsMade++;
        logger.info(`MockWorker retrying job ${job.id} (attempt ${job.attemptsMade})`);
        await this.processJob(job);
      } else {
        // Emit failed event
        for (const listener of this.failedListeners) {
          listener(job, err);
        }
      }
    }
  }

  on(event: string, callback: any) {
    if (event === "failed") {
      this.failedListeners.push(callback);
    } else if (event === "error") {
      this.errorListeners.push(callback);
    }
  }

  async close(): Promise<void> {
    return;
  }
}

Module.prototype.require = function (id: string) {
  if (id === "ioredis") {
    return MockRedis;
  }
  if (id === "bullmq") {
    return {
      Queue: MockQueue,
      Worker: MockWorker,
      Job: MockJob,
    };
  }
  return originalRequire.apply(this, arguments);
};

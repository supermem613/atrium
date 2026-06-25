export const defaultMaxConcurrentExecutions = 4;

export interface ExecutionQueueMetrics {
  queueLimit: number;
  queueWaitMs: number;
  queueDepthAtEnqueue: number;
  queueActiveAtEnqueue: number;
  queueActiveAtStart: number;
}

export interface ExecutionQueuePermit {
  metrics: ExecutionQueueMetrics;
  release(): void;
}

interface PendingAcquire {
  requestedAt: number;
  activeAtEnqueue: number;
  depthAtEnqueue: number;
  resolve: (permit: ExecutionQueuePermit) => void;
}

export class ExecutionQueue {
  private active = 0;
  private readonly pending: PendingAcquire[] = [];

  public constructor(private readonly limit = defaultMaxConcurrentExecutions) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("Execution queue limit must be a positive integer.");
    }
  }

  public acquire(): Promise<ExecutionQueuePermit> {
    const requestedAt = Date.now();
    const activeAtEnqueue = this.active;
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.createPermit({
        requestedAt,
        activeAtEnqueue,
        depthAtEnqueue: 0,
      }));
    }

    return new Promise((resolve) => {
      this.pending.push({
        requestedAt,
        activeAtEnqueue,
        depthAtEnqueue: this.pending.length + 1,
        resolve,
      });
    });
  }

  public snapshot(): { active: number; pending: number; limit: number } {
    return {
      active: this.active,
      pending: this.pending.length,
      limit: this.limit,
    };
  }

  private createPermit(input: Omit<PendingAcquire, "resolve">): ExecutionQueuePermit {
    let released = false;
    const metrics = {
      queueLimit: this.limit,
      queueWaitMs: Date.now() - input.requestedAt,
      queueDepthAtEnqueue: input.depthAtEnqueue,
      queueActiveAtEnqueue: input.activeAtEnqueue,
      queueActiveAtStart: this.active,
    } satisfies ExecutionQueueMetrics;

    return {
      metrics,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.release();
      },
    };
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.drain();
  }

  private drain(): void {
    while (this.active < this.limit && this.pending.length > 0) {
      const next = this.pending.shift();
      if (next === undefined) {
        return;
      }
      this.active += 1;
      next.resolve(this.createPermit(next));
    }
  }
}

export const defaultExecutionQueue = new ExecutionQueue();

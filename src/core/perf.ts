export interface PerfSpan {
  name: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface PerfOperationReport {
  operationId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  spans: PerfSpan[];
}

export interface PerfRecorder {
  startOperation(operationId: string): PerfOperationRecorder;
}

export interface PerfOperationRecorder {
  addSpan(name: string): void;
  finish(): PerfOperationReport;
}

export function createPerfRecorder(enabled: boolean): PerfRecorder | undefined {
  if (!enabled) {
    return undefined;
  }

  return new PerfRecorderImpl();
}

class PerfRecorderImpl implements PerfRecorder {
  startOperation(operationId: string): PerfOperationRecorder {
    return new PerfOperationRecorderImpl(operationId);
  }
}

class PerfOperationRecorderImpl implements PerfOperationRecorder {
  private readonly startedAt = new Date();
  private readonly spans: PerfSpan[] = [];

  constructor(private readonly operationId: string) {
  }

  addSpan(name: string): void {
    const startedAt = new Date();
    const endedAt = new Date(startedAt.getTime());
    this.spans.push({
      name,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: 0,
    });
  }

  finish(): PerfOperationReport {
    const endedAt = new Date();
    return {
      operationId: this.operationId,
      startedAt: this.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: Math.max(0, endedAt.getTime() - this.startedAt.getTime()),
      spans: this.spans,
    };
  }
}

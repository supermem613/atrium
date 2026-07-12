import { performance } from "node:perf_hooks";

export interface PerfSpan {
  name: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  attributes?: Record<string, unknown>;
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
  addSpan(name: string, attributes?: Record<string, unknown>): void;
  startSpan(name: string): PerfSpanRecorder;
  finish(): PerfOperationReport;
}

export interface PerfSpanRecorder {
  finish(attributes?: Record<string, unknown>): void;
}

export interface PerfClock {
  wallNow(): number;
  monotonicNow(): number;
}

const defaultPerfClock: PerfClock = {
  wallNow: () => Date.now(),
  monotonicNow: () => performance.now(),
};

export function createPerfRecorder(enabled: boolean, clock: PerfClock = defaultPerfClock): PerfRecorder | undefined {
  if (!enabled) {
    return undefined;
  }

  return new PerfRecorderImpl(clock);
}

export function sanitizePerfAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    sanitized[key] = sanitizePerfAttributeValue(value);
  }
  return sanitized;
}

class PerfRecorderImpl implements PerfRecorder {
  constructor(private readonly clock: PerfClock) {
  }

  startOperation(operationId: string): PerfOperationRecorder {
    return new PerfOperationRecorderImpl(operationId, this.clock);
  }
}

class PerfOperationRecorderImpl implements PerfOperationRecorder {
  private readonly startedAt: number;
  private readonly startedAtMonotonic: number;
  private readonly spans: PerfSpan[] = [];

  constructor(
    private readonly operationId: string,
    private readonly clock: PerfClock,
  ) {
    this.startedAt = clock.wallNow();
    this.startedAtMonotonic = clock.monotonicNow();
  }

  addSpan(name: string, attributes?: Record<string, unknown>): void {
    const startedAtMs = this.clock.wallNow();
    const endedAtMs = startedAtMs;
    this.spans.push({
      name,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: Math.max(0, endedAtMs - startedAtMs),
      ...(attributes === undefined ? {} : { attributes: sanitizePerfAttributes(attributes) }),
    });
  }

  startSpan(name: string): PerfSpanRecorder {
    const startedAtMs = this.clock.wallNow();
    const startedAtMonotonic = this.clock.monotonicNow();
    let finished = false;
    return {
      finish: (attributes?: Record<string, unknown>) => {
        if (finished) {
          return;
        }
        finished = true;
        const endedAtMs = this.clock.wallNow();
        const endedAtMonotonic = this.clock.monotonicNow();
        this.spans.push({
          name,
          startedAt: new Date(startedAtMs).toISOString(),
          endedAt: new Date(endedAtMs).toISOString(),
          durationMs: Math.max(0, endedAtMonotonic - startedAtMonotonic),
          ...(attributes === undefined ? {} : { attributes: sanitizePerfAttributes(attributes) }),
        });
      },
    };
  }

  finish(): PerfOperationReport {
    const endedAtMs = this.clock.wallNow();
    const endedAtMonotonic = this.clock.monotonicNow();
    return {
      operationId: this.operationId,
      startedAt: new Date(this.startedAt).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: Math.max(0, endedAtMonotonic - this.startedAtMonotonic),
      spans: this.spans,
    };
  }
}

function sanitizePerfAttributeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return sanitizePerfString(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((entry) => sanitizePerfAttributeValue(entry));
  }
  if (typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, childValue] of Object.entries(value as Record<string, unknown>)) {
      sanitized[key] = sanitizePerfAttributeValue(childValue);
    }
    return sanitized;
  }
  return sanitizePerfString(String(value));
}

function sanitizePerfString(value: string): string | number {
  if (value.length === 0) {
    return value;
  }
  const lower = value.toLowerCase();
  if (["content", "files", "search", "normalize", "queue", "spawn", "materialize", "semantic", "continue", "completed", "failed", "running", "ok", "true", "false", "native", "native-search"].includes(lower)) {
    return value;
  }
  return value.length <= 32 ? value : shortHash(value);
}

function shortHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) >>> 0;
  }
  return `h${hash.toString(16)}`;
}

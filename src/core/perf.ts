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
  finish(): PerfOperationReport;
}

export function createPerfRecorder(enabled: boolean): PerfRecorder | undefined {
  if (!enabled) {
    return undefined;
  }

  return new PerfRecorderImpl();
}

export function sanitizePerfAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    sanitized[key] = sanitizePerfAttributeValue(value);
  }
  return sanitized;
}

class PerfRecorderImpl implements PerfRecorder {
  startOperation(operationId: string): PerfOperationRecorder {
    return new PerfOperationRecorderImpl(operationId);
  }
}

class PerfOperationRecorderImpl implements PerfOperationRecorder {
  private readonly startedAt = Date.now();
  private readonly spans: PerfSpan[] = [];

  constructor(private readonly operationId: string) {
  }

  addSpan(name: string, attributes?: Record<string, unknown>): void {
    const startedAtMs = Date.now();
    const endedAtMs = startedAtMs;
    this.spans.push({
      name,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: Math.max(0, endedAtMs - startedAtMs),
      ...(attributes === undefined ? {} : { attributes: sanitizePerfAttributes(attributes) }),
    });
  }

  finish(): PerfOperationReport {
    const endedAtMs = Date.now();
    return {
      operationId: this.operationId,
      startedAt: new Date(this.startedAt).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: Math.max(0, endedAtMs - this.startedAt),
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
  if (["content", "files", "search", "normalize", "queue", "spawn", "materialize", "semantic", "continue", "completed", "failed", "running", "ok", "true", "false", "bundled-ripgrep", "ripgrep", "native", "native-search"].includes(lower)) {
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

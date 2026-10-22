import { redactText, redactValue } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/**
 * Structured logger. Every line passes through redaction before it reaches
 * the sink, so callers cannot write secrets by accident.
 */
export function createLogger(sink: (line: string) => void, now: () => Date = () => new Date()): Logger {
  const log = (level: LogLevel, event: string, fields: Record<string, unknown> = {}): void => {
    const record = {
      ts: now().toISOString(),
      level,
      event: redactText(event),
      ...(redactValue(fields) as Record<string, unknown>),
    };
    sink(JSON.stringify(record));
  };
  return {
    log,
    info: (event, fields) => log('info', event, fields),
    warn: (event, fields) => log('warn', event, fields),
    error: (event, fields) => log('error', event, fields),
  };
}

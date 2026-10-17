/**
 * Minimal structured logger: JSON lines with a level filter, no dependencies.
 * Server-side failures are always logged with enough context to debug them.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly scope = 'fracture',
  ) {}

  child(scope: string): Logger {
    return new Logger(this.level, `${this.scope}:${scope}`);
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.write('debug', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.write('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write('warn', message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.write('error', message, context);
  }

  private write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const entry: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      scope: this.scope,
      message,
    };
    if (context) entry.ctx = context;
    const line = JSON.stringify(entry);
    if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }
}

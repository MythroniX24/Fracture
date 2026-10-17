/**
 * Server configuration, read once from the environment.
 *
 * Only placeholders belong in `.env.example`; real values stay in the deploy
 * environment. Nothing here is ever exposed to the browser bundle.
 */
import { MATCHMAKING } from '@fracture/shared';

export interface ServerConfig {
  port: number;
  host: string;
  /** Allowed browser origins for the WebSocket upgrade. `['*']` disables the check. */
  clientOrigins: string[];
  /** Serve the built client from this process when the bundle exists. */
  serveClient: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Path to the built client bundle. */
  clientDist: string;
  /**
   * Milliseconds a lone human waits before bots fill the arena.
   * `0` or less disables the automatic fill (the test harness uses this).
   */
  botFillDelayMs: number;
}

function parseOrigins(raw: string | undefined): string[] {
  const value = (raw ?? '*').trim();
  if (value === '' || value === '*') return ['*'];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseLogLevel(raw: string | undefined): ServerConfig['logLevel'] {
  switch ((raw ?? 'info').toLowerCase()) {
    case 'debug':
      return 'debug';
    case 'warn':
      return 'warn';
    case 'error':
      return 'error';
    default:
      return 'info';
  }
}

function parseBotFillDelay(raw: string | undefined): number {
  if (raw === undefined) return MATCHMAKING.botFillDelayMs;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : MATCHMAKING.botFillDelayMs;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number.parseInt(env.PORT ?? '2567', 10) || 2567,
    host: env.HOST ?? '0.0.0.0',
    clientOrigins: parseOrigins(env.CLIENT_ORIGIN),
    serveClient: (env.SERVE_CLIENT ?? 'true').toLowerCase() !== 'false',
    logLevel: parseLogLevel(env.LOG_LEVEL),
    clientDist: env.CLIENT_DIST ?? new URL('../../client/dist', import.meta.url).pathname,
    // `Number.parseInt` returning NaN must not silently disable matchmaking.
    botFillDelayMs: parseBotFillDelay(env.FRACTURE_BOT_FILL_MS),
  };
}

/** True when `origin` is allowed to open a WebSocket connection. */
export function isOriginAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (allowed.includes('*')) return true;
  if (!origin) return false;
  return allowed.includes(origin);
}

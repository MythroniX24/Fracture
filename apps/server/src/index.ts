/**
 * FRACTURE authoritative game server.
 *
 * One process hosts:
 *   - `GET /health`          JSON status for load balancers and humans
 *   - `GET /*`               the built client bundle (when SERVE_CLIENT=true)
 *   - `WS  /ws`              the game protocol
 *
 * The WebSocket layer only decodes/validates messages and routes them to a
 * `Room`; all gameplay decisions happen inside the shared `MatchSim` at 30 Hz.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import {
  MAX_INPUT_MESSAGES_PER_SECOND,
  MAX_MESSAGE_BYTES,
  TICK_MS,
  encodeServerMessage,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
} from '@fracture/shared';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { pathToFileURL } from 'node:url';
import { isOriginAllowed, loadConfig, type ServerConfig } from './config.js';
import { Logger } from './logger.js';
import { RoomManager } from './roomManager.js';
import type { Room } from './room.js';
import { createStaticHandler } from './static.js';

const SERVER_VERSION = '0.1.0';
const WS_PATH = '/ws';

interface Session {
  socket: WebSocket;
  alive: boolean;
  roomCode: string | null;
  playerId: string | null;
  /** Sliding window counter for message rate limiting. */
  windowStartedAt: number;
  windowCount: number;
  /** Number of rate-limit violations, used to cut off abusers. */
  strikes: number;
}

export interface GameServer {
  readonly httpServer: Server;
  readonly rooms: RoomManager;
  readonly config: ServerConfig;
  /** Start the authoritative loop. */
  start(): void;
  /** Stop the loop (the HTTP server keeps running until `close()`). */
  stop(): void;
  /** Fully shut down: sockets closed, loop stopped, HTTP server closed. */
  close(): Promise<void>;
  listen(port?: number, host?: string): Promise<number>;
}

export function createGameServer(options: { config?: Partial<ServerConfig> } = {}): GameServer {
  const base = loadConfig();
  const config: ServerConfig = { ...base, ...options.config };
  const log = new Logger(config.logLevel, 'server');
  const rooms = new RoomManager(log, { botFillDelayMs: config.botFillDelayMs });
  const staticHandler = createStaticHandler(config.clientDist);
  const sessions = new Map<WebSocket, Session>();

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/health') {
      const body = JSON.stringify({
        status: 'ok',
        version: SERVER_VERSION,
        uptimeSeconds: Math.round(process.uptime()),
        tickRate: Math.round(1000 / TICK_MS),
        rooms: rooms.size,
        players: rooms.playerCount,
        roomCodes: rooms.describe(),
      });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
      return;
    }

    if (url.pathname === '/' && !staticHandler.available) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        [
          'FRACTURE game server is running.',
          '',
          `  WebSocket endpoint : ws://<host>${WS_PATH}`,
          '  Health             : GET /health',
          '',
          'The client bundle was not found, so nothing is served at "/".',
          'Build it with `npm run build -w @fracture/client` or set CLIENT_DIST.',
        ].join('\n'),
      );
      return;
    }

    if (staticHandler.handle(req, res, url.pathname)) return;

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  // -------------------------------------------------------------------------
  // WebSocket transport
  // -------------------------------------------------------------------------

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES * 2 });

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== WS_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!isOriginAllowed(req.headers.origin, config.clientOrigins)) {
      log.warn('rejected websocket upgrade', {
        origin: req.headers.origin ?? null,
        allowed: config.clientOrigins,
      });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  function send(session: Session, message: ServerMessage): void {
    if (session.socket.readyState !== WebSocket.OPEN) return;
    try {
      session.socket.send(encodeServerMessage(message));
    } catch (error) {
      log.warn('send failed', { error: (error as Error).message });
    }
  }

  function fail(session: Session, code: ErrorCode, message: string): void {
    send(session, { t: 'error', code, message });
  }

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const session: Session = {
      socket: ws,
      alive: true,
      roomCode: null,
      playerId: null,
      windowStartedAt: Date.now(),
      windowCount: 0,
      strikes: 0,
    };
    sessions.set(ws, session);
    log.debug('socket connected', { origin: req.headers.origin ?? null });

    ws.on('pong', () => {
      session.alive = true;
    });

    ws.on('message', (data, isBinary) => {
      // Input frequency guard: drop excess frames instead of letting a client
      // flood the simulation, and disconnect repeat offenders.
      const now = Date.now();
      if (now - session.windowStartedAt >= 1000) {
        session.windowStartedAt = now;
        session.windowCount = 0;
      }
      session.windowCount += 1;
      if (session.windowCount > MAX_INPUT_MESSAGES_PER_SECOND * 3) {
        session.strikes += 1;
        if (session.strikes > 20) {
          log.warn('closing rate-limited socket', { strikes: session.strikes });
          ws.close(1008, 'rate limited');
        }
        return;
      }

      const text = decodeFrame(data);
      if (isBinary && Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) {
        fail(session, 'bad-message', 'Binary frames are not supported');
        return;
      }

      const parsed = parseClientMessage(text);
      if (!parsed.ok) {
        fail(session, parsed.code, parsed.message);
        return;
      }
      try {
        handleMessage(session, parsed.message);
      } catch (error) {
        log.error('message handling failed', {
          type: parsed.message.t,
          error: (error as Error).message,
          stack: (error as Error).stack,
        });
        fail(session, 'server-error', 'Unexpected server error');
      }
    });

    ws.on('close', () => {
      sessions.delete(ws);
      if (!session.roomCode || !session.playerId) return;
      const room = rooms.get(session.roomCode);
      if (!room) return;
      // Ignore the close event of a superseded socket (reconnect on a new one).
      if (room.socketFor(session.playerId) && room.socketFor(session.playerId) !== ws) return;
      room.leave(session.playerId, false);
      room.broadcastRoom();
    });

    ws.on('error', (error) => {
      log.warn('socket error', { error: error.message });
    });
  });

  // -------------------------------------------------------------------------
  // Message routing
  // -------------------------------------------------------------------------

  function handleMessage(session: Session, message: ClientMessage): void {
    switch (message.t) {
      case 'create': {
        if (session.roomCode) {
          fail(session, 'already-in-room', 'Leave the current room first');
          return;
        }
        let room: Room;
        try {
          room = rooms.create();
        } catch (error) {
          log.error('room creation failed', { error: (error as Error).message });
          fail(session, 'server-error', 'Could not create a room, try again');
          return;
        }
        const result = room.join(session.socket, message.name, message.token);
        if (!result.ok) {
          fail(session, 'server-error', result.message);
          return;
        }
        session.roomCode = room.code;
        session.playerId = result.playerId;
        sendJoined(session, room.code, result.playerId, result.token, room);
        return;
      }

      case 'join': {
        if (session.roomCode && session.roomCode !== message.code) {
          fail(session, 'already-in-room', 'Leave the current room first');
          return;
        }
        const joined = rooms.join(message.code, session.socket, message.name, message.token);
        if (!joined.ok) {
          log.debug('join failed', { code: message.code, reason: joined.code });
          fail(session, 'room-not-found', `No room with code ${message.code}`);
          return;
        }
        if (!joined.result.ok) {
          fail(session, 'room-full', joined.result.message);
          return;
        }
        session.roomCode = joined.room.code;
        session.playerId = joined.result.playerId;
        sendJoined(
          session,
          joined.room.code,
          joined.result.playerId,
          joined.result.token,
          joined.room,
        );
        joined.room.broadcastRoom();
        return;
      }

      case 'ready': {
        const room = currentRoom(session);
        if (!room || !session.playerId) return;
        room.setReady(session.playerId, message.ready);
        return;
      }

      case 'start': {
        const room = currentRoom(session);
        if (!room || !session.playerId) {
          fail(session, 'not-in-room', 'Not in a room');
          return;
        }
        const outcome = room.requestStart(session.playerId);
        if (!outcome.ok) {
          fail(
            session,
            (outcome.error as ErrorCode) ?? 'wrong-phase',
            outcome.error === 'not-host'
              ? 'Only the host can start the match'
              : outcome.error === 'not-enough-players'
                ? 'At least two players are required'
                : 'The match cannot start right now',
          );
        }
        return;
      }

      case 'input': {
        const room = currentRoom(session);
        if (!room || !session.playerId) return;
        room.handleInput(session.playerId, message.input);
        return;
      }

      case 'rematch': {
        const room = currentRoom(session);
        if (!room || !session.playerId) {
          fail(session, 'not-in-room', 'Not in a room');
          return;
        }
        const outcome = room.requestRematch(session.playerId);
        if (!outcome.ok) {
          fail(
            session,
            (outcome.error as ErrorCode) ?? 'wrong-phase',
            outcome.error === 'not-host'
              ? 'Only the host can start a rematch'
              : 'A rematch is not available right now',
          );
        }
        return;
      }

      case 'leave': {
        const room = currentRoom(session);
        if (room && session.playerId) {
          room.leave(session.playerId, true);
          room.broadcastRoom();
        }
        session.roomCode = null;
        session.playerId = null;
        send(session, { t: 'left', reason: 'left' });
        return;
      }

      case 'ping': {
        send(session, { t: 'pong', ts: message.ts, serverTime: Date.now() });
        return;
      }

      default:
        return;
    }
  }

  function currentRoom(session: Session): Room | null {
    if (!session.roomCode || !session.playerId) return null;
    return rooms.get(session.roomCode) ?? null;
  }

  function sendJoined(
    session: Session,
    code: string,
    playerId: string,
    token: string,
    room: Room,
  ): void {
    send(session, {
      t: 'joined',
      playerId,
      code,
      token,
      room: room.summary(),
    });
  }

  // -------------------------------------------------------------------------
  // Loops
  // -------------------------------------------------------------------------

  let tickTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;
  let nextTickAt = 0;

  function start(): void {
    if (tickTimer) return;
    nextTickAt = performance.now();
    const loop = () => {
      const now = performance.now();
      let iterations = 0;
      while (now >= nextTickAt && iterations < 10) {
        rooms.tickAll();
        nextTickAt += TICK_MS;
        iterations += 1;
      }
      if (iterations >= 10) {
        // Falling far behind (debugger, suspend): resync instead of spiralling.
        log.warn('tick loop fell behind, resynchronising', { drift: now - nextTickAt });
        nextTickAt = now + TICK_MS;
      }
      tickTimer = setTimeout(loop, Math.max(1, nextTickAt - performance.now()));
    };
    loop();

    heartbeatTimer = setInterval(() => {
      for (const [socket, session] of sessions) {
        if (!session.alive) {
          log.debug('terminating unresponsive socket');
          socket.terminate();
          continue;
        }
        session.alive = false;
        try {
          socket.ping();
        } catch {
          socket.terminate();
        }
      }
    }, 10_000);

    sweepTimer = setInterval(() => {
      rooms.sweep();
    }, 5_000);
  }

  function stop(): void {
    if (tickTimer) {
      clearTimeout(tickTimer);
      tickTimer = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  function listen(port = config.port, host = config.host): Promise<number> {
    return new Promise((resolvePromise, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, host, () => {
        const address = httpServer.address();
        const actualPort = typeof address === 'object' && address ? address.port : port;
        log.info('server listening', {
          host,
          port: actualPort,
          wsPath: WS_PATH,
          serveClient: staticHandler.available,
          allowedOrigins: config.clientOrigins,
        });
        resolvePromise(actualPort);
      });
    });
  }

  function close(): Promise<void> {
    stop();
    rooms.closeAll();
    for (const socket of sessions.keys()) {
      try {
        socket.close(1001, 'server shutting down');
      } catch {
        /* ignore */
      }
    }
    sessions.clear();
    return new Promise((resolvePromise) => {
      wss.close(() => {
        httpServer.close(() => resolvePromise());
      });
    });
  }

  return { httpServer, rooms, config, start, stop, close, listen };
}

// ---------------------------------------------------------------------------
// Direct execution
// ---------------------------------------------------------------------------

/** Decode a `ws` frame into text regardless of the negotiated frame type. */
function decodeFrame(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

const entry = process.argv[1];
const isDirectRun = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (isDirectRun) {
  const server = createGameServer();
  server
    .listen()
    .then(() => server.start())
    .catch((error) => {
      process.stderr.write(`Failed to start server: ${(error as Error).message}\n`);
      process.exit(1);
    });

  const shutdown = (signal: string) => {
    process.stdout.write(`Received ${signal}, shutting down\n`);
    server
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (error) => {
    process.stderr.write(`Uncaught exception: ${error.stack ?? error.message}\n`);
  });
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`Unhandled rejection: ${String(reason)}\n`);
  });
}

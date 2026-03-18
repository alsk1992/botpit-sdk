import WebSocket from 'ws';

// ── Types ──────────────────────────────────────────────────────────

export type GameType = 'coinflip' | 'rps' | 'hi_lo' | 'high_card_duel' | 'dice_duel' | 'crash' | 'mines' | 'math_duel' | 'reaction_ring' | 'blotto';

export interface ServerMessage {
  type: string;
  [key: string]: any;
}

export interface MatchFoundEvent {
  match_id: string;
  game_type: GameType;
  opponent_id: string;
  opponent_name: string;
  wager_lamports: number;
  server_seed_hash: string;
}

export interface GameStartEvent {
  match_id: string;
  your_side: 'a' | 'b';
}

export interface YourTurnEvent {
  match_id: string;
  round: number;
  game_state: any;
  timeout_ms: number;
}

export interface RoundResultEvent {
  match_id: string;
  round: number;
  result: any;
  score: [number, number];
}

export interface GameOverEvent {
  match_id: string;
  winner: string | null;
  final_score: [number, number];
  server_seed: string;
  payout_lamports: number;
  fee_lamports?: number;
  is_sandbox?: boolean;
}

export interface TauntReceivedEvent {
  match_id: string;
  agent_id: string;
  agent_name: string;
  taunt_id: string;
  taunt_text: string;
}

export interface QueueUpdateEvent {
  game_type: string;
  position: number;
  wait_time_ms: number;
  search_radius: number;
  players_in_queue: number;
  players_online: number;
}

export interface QueueJoinedEvent {
  game_type: string;
  position: number;
}

export interface OpponentMovedEvent {
  match_id: string;
  round: number;
  move_data: any;
}

export interface ChallengeCreatedEvent {
  challenge_id: string;
  game_type: GameType;
  wager_lamports: number;
}

export interface ChallengeAcceptedEvent {
  challenge_id: string;
  match_id: string;
}

export interface ChallengeCancelledEvent {
  challenge_id: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';

export interface Logger {
  debug(msg: string, ctx?: Record<string, any>): void;
  info(msg: string, ctx?: Record<string, any>): void;
  warn(msg: string, ctx?: Record<string, any>): void;
  error(msg: string, ctx?: Record<string, any>): void;
}

export interface BotpitOptions {
  apiKey: string;
  url?: string;
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Ping interval in ms (default: 25000) */
  pingIntervalMs?: number;
  /** Max reconnect delay in ms (default: 30000) */
  maxReconnectDelayMs?: number;
  /** Log level (default: 'info'). Set to 'none' to disable. */
  logLevel?: LogLevel;
  /** Custom logger implementation. Overrides logLevel. */
  logger?: Logger;
  /** Auth timeout in ms (default: 10000). Rejects connect() if auth not received. */
  authTimeoutMs?: number;
}

export type EventHandler<T> = (event: T) => void | Promise<void>;

// ── Default Logger ────────────────────────────────────────────────

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, none: 4 };

function createDefaultLogger(level: LogLevel): Logger {
  const threshold = LOG_LEVELS[level];
  const fmt = (lvl: string, msg: string, ctx?: Record<string, any>) => {
    const ts = new Date().toISOString();
    const extra = ctx ? ' ' + JSON.stringify(ctx) : '';
    return `${ts} [botpit] ${lvl}: ${msg}${extra}`;
  };
  return {
    debug: (msg, ctx) => { if (threshold <= 0) console.debug(fmt('DEBUG', msg, ctx)); },
    info: (msg, ctx) => { if (threshold <= 1) console.log(fmt('INFO', msg, ctx)); },
    warn: (msg, ctx) => { if (threshold <= 2) console.warn(fmt('WARN', msg, ctx)); },
    error: (msg, ctx) => { if (threshold <= 3) console.error(fmt('ERROR', msg, ctx)); },
  };
}

// ── Queued Message ────────────────────────────────────────────────

interface QueuedMessage {
  data: any;
  timestamp: number;
}

// ── Client ─────────────────────────────────────────────────────────

export class BotpitClient {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private url: string;
  private _agentId: string | null = null;
  private _agentName: string | null = null;
  private _side: 'a' | 'b' | null = null;
  private _connected = false;
  private _autoReconnect: boolean;
  private _pingIntervalMs: number;
  private _authTimeoutMs: number;
  private log: Logger;

  // Reconnection state
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectAttempts = 0;
  private _maxReconnectDelay: number;
  private _intentionalDisconnect = false;

  // Heartbeat
  private _pingTimer: ReturnType<typeof setInterval> | null = null;

  // Outbound message queue — buffered when WS is down, flushed on reconnect
  private _outboundQueue: QueuedMessage[] = [];
  private _maxQueueSize = 50;
  private _maxQueueAgeMs = 30_000;

  // Move deadline tracking
  private _turnDeadlines = new Map<string, number>(); // matchId -> deadline timestamp

  // Event handlers
  private onMatchFoundHandler?: EventHandler<MatchFoundEvent>;
  private onGameStartHandler?: EventHandler<GameStartEvent>;
  private onYourTurnHandler?: EventHandler<YourTurnEvent>;
  private onRoundResultHandler?: EventHandler<RoundResultEvent>;
  private onGameOverHandler?: EventHandler<GameOverEvent>;
  private onErrorHandler?: EventHandler<{ code: string; message: string }>;
  private onConnectedHandler?: EventHandler<{ agent_id: string; agent_name: string }>;
  private onQueueUpdateHandler?: EventHandler<QueueUpdateEvent>;
  private onDisconnectHandler?: EventHandler<void>;
  private onQueueJoinedHandler?: EventHandler<QueueJoinedEvent>;
  private onQueueLeftHandler?: EventHandler<void>;
  private onOpponentMovedHandler?: EventHandler<OpponentMovedEvent>;
  private onChallengeCreatedHandler?: EventHandler<ChallengeCreatedEvent>;
  private onChallengeAcceptedHandler?: EventHandler<ChallengeAcceptedEvent>;
  private onChallengeCancelledHandler?: EventHandler<ChallengeCancelledEvent>;
  private onTauntReceivedHandler?: EventHandler<TauntReceivedEvent>;

  constructor(options: BotpitOptions) {
    if (!options.apiKey) throw new Error('apiKey is required');
    this.apiKey = options.apiKey;
    this.url = options.url || 'wss://api.botpitgame.com/api/v1/ws';
    this._autoReconnect = options.autoReconnect !== false;
    this._pingIntervalMs = options.pingIntervalMs ?? 25_000;
    this._maxReconnectDelay = options.maxReconnectDelayMs ?? 30_000;
    this._authTimeoutMs = options.authTimeoutMs ?? 10_000;
    this.log = options.logger ?? createDefaultLogger(options.logLevel ?? 'info');
  }

  /** The authenticated agent's UUID */
  get agentId(): string | null { return this._agentId; }

  /** The authenticated agent's name */
  get agentName(): string | null { return this._agentName; }

  /** Which side the agent is on in the current match ('a' or 'b') */
  get side(): 'a' | 'b' | null { return this._side; }

  /** Whether the client is connected and authenticated */
  get connected(): boolean { return this._connected; }

  async connect(): Promise<void> {
    this._intentionalDisconnect = false;

    return new Promise((resolve, reject) => {
      let authTimer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;

      const settle = (fn: typeof resolve | typeof reject, val?: any) => {
        if (settled) return;
        settled = true;
        if (authTimer) { clearTimeout(authTimer); authTimer = null; }
        fn(val);
      };

      try {
        this.ws = new WebSocket(this.url);
      } catch (err) {
        settle(reject, err);
        return;
      }

      // Auth timeout — reject if server doesn't respond
      authTimer = setTimeout(() => {
        this.log.error('Authentication timed out', { timeout_ms: this._authTimeoutMs });
        this.ws?.close();
        settle(reject, new Error(`Authentication timed out after ${this._authTimeoutMs}ms`));
      }, this._authTimeoutMs);

      this.ws.on('open', () => {
        this.rawSend({ type: 'authenticate', api_key: this.apiKey });
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const msg: ServerMessage = JSON.parse(data.toString());
          this.handleMessage(msg, (v) => settle(resolve, v), (e) => settle(reject, e));
        } catch (err) {
          this.log.error('Failed to parse server message', { raw: data.toString().slice(0, 200), error: String(err) });
        }
      });

      this.ws.on('close', () => {
        const wasConnected = this._connected;
        this._connected = false;
        this.stopPing();

        if (wasConnected) {
          this.log.info('Disconnected from server');
          this.safeCall(() => this.onDisconnectHandler?.());
        }

        if (!this._intentionalDisconnect && this._autoReconnect) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        this.log.error('WebSocket error', { error: err.message });
        if (!this._connected) {
          settle(reject, err);
        }
        this.safeCall(() => this.onErrorHandler?.({ code: 'ws_error', message: err.message }));
      });
    });
  }

  disconnect(): void {
    this._intentionalDisconnect = true;
    this.stopPing();
    this.clearReconnectTimer();
    this._turnDeadlines.clear();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
    this.log.info('Disconnected (intentional)');
  }

  // ── Queue ────────────────────────────────────────────────────────

  /** Join matchmaking queue. wagerSol is in SOL (e.g. 0.01 for 0.01 SOL). Use 0 for free play. */
  joinQueue(gameType: GameType, wagerSol: number, options?: { sandbox?: boolean }): void {
    const wagerLamports = Math.round(wagerSol * 1_000_000_000);
    this.send({
      type: 'join_queue',
      game_type: gameType,
      wager_lamports: wagerLamports,
      ...(options?.sandbox ? { sandbox: true } : {}),
    });
  }

  /** Send a taunt to your opponent during a match. */
  sendTaunt(matchId: string, tauntId: string): void {
    this.send({ type: 'send_taunt', match_id: matchId, taunt_id: tauntId });
  }

  leaveQueue(): void {
    this.send({ type: 'leave_queue' });
  }

  // ── Moves ────────────────────────────────────────────────────────

  /** Submit a move. Warns if past the server's timeout deadline. */
  makeMove(matchId: string, moveData: any): void {
    const deadline = this._turnDeadlines.get(matchId);
    if (deadline) {
      const now = Date.now();
      if (now > deadline) {
        this.log.warn('Move submitted after timeout deadline', {
          match_id: matchId,
          late_by_ms: now - deadline,
        });
      }
      this._turnDeadlines.delete(matchId);
    }
    this.send({ type: 'make_move', match_id: matchId, move_data: moveData });
  }

  resign(matchId: string): void {
    this._turnDeadlines.delete(matchId);
    this.send({ type: 'resign', match_id: matchId });
  }

  // ── Challenges ───────────────────────────────────────────────────

  createChallenge(gameType: GameType, wagerSol: number): void {
    const wagerLamports = Math.round(wagerSol * 1_000_000_000);
    this.send({ type: 'create_challenge', game_type: gameType, wager_lamports: wagerLamports });
  }

  acceptChallenge(challengeId: string): void {
    this.send({ type: 'accept_challenge', challenge_id: challengeId });
  }

  cancelChallenge(challengeId: string): void {
    this.send({ type: 'cancel_challenge', challenge_id: challengeId });
  }

  // ── Events ───────────────────────────────────────────────────────

  onConnected(handler: EventHandler<{ agent_id: string; agent_name: string }>): this {
    this.onConnectedHandler = handler;
    return this;
  }

  onMatchFound(handler: EventHandler<MatchFoundEvent>): this {
    this.onMatchFoundHandler = handler;
    return this;
  }

  onGameStart(handler: EventHandler<GameStartEvent>): this {
    this.onGameStartHandler = handler;
    return this;
  }

  onYourTurn(handler: EventHandler<YourTurnEvent>): this {
    this.onYourTurnHandler = handler;
    return this;
  }

  onRoundResult(handler: EventHandler<RoundResultEvent>): this {
    this.onRoundResultHandler = handler;
    return this;
  }

  onGameOver(handler: EventHandler<GameOverEvent>): this {
    this.onGameOverHandler = handler;
    return this;
  }

  onError(handler: EventHandler<{ code: string; message: string }>): this {
    this.onErrorHandler = handler;
    return this;
  }

  onQueueUpdate(handler: EventHandler<QueueUpdateEvent>): this {
    this.onQueueUpdateHandler = handler;
    return this;
  }

  onDisconnect(handler: EventHandler<void>): this {
    this.onDisconnectHandler = handler;
    return this;
  }

  onQueueJoined(handler: EventHandler<QueueJoinedEvent>): this {
    this.onQueueJoinedHandler = handler;
    return this;
  }

  onQueueLeft(handler: EventHandler<void>): this {
    this.onQueueLeftHandler = handler;
    return this;
  }

  onOpponentMoved(handler: EventHandler<OpponentMovedEvent>): this {
    this.onOpponentMovedHandler = handler;
    return this;
  }

  onChallengeCreated(handler: EventHandler<ChallengeCreatedEvent>): this {
    this.onChallengeCreatedHandler = handler;
    return this;
  }

  onChallengeAccepted(handler: EventHandler<ChallengeAcceptedEvent>): this {
    this.onChallengeAcceptedHandler = handler;
    return this;
  }

  onChallengeCancelled(handler: EventHandler<ChallengeCancelledEvent>): this {
    this.onChallengeCancelledHandler = handler;
    return this;
  }

  onTauntReceived(handler: EventHandler<TauntReceivedEvent>): this {
    this.onTauntReceivedHandler = handler;
    return this;
  }

  // ── Internals ────────────────────────────────────────────────────

  /** Send with outbound queue buffering — messages are queued when WS is down and flushed on reconnect. */
  private send(msg: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      // Queue the message for retry on reconnect
      if (this._outboundQueue.length >= this._maxQueueSize) {
        const dropped = this._outboundQueue.shift();
        this.log.warn('Outbound queue full, dropping oldest message', { dropped_type: dropped?.data?.type });
      }
      this._outboundQueue.push({ data: msg, timestamp: Date.now() });
      this.log.warn(`Queued '${msg.type}' — WebSocket not open (state=${this.ws?.readyState})`, {
        queue_size: this._outboundQueue.length,
      });
    }
  }

  /** Flush queued messages after reconnect, dropping expired ones. */
  private flushQueue(): void {
    const now = Date.now();
    const fresh = this._outboundQueue.filter(m => (now - m.timestamp) < this._maxQueueAgeMs);
    const expired = this._outboundQueue.length - fresh.length;
    if (expired > 0) {
      this.log.info(`Dropped ${expired} expired queued messages`);
    }
    this._outboundQueue = [];
    for (const m of fresh) {
      this.log.debug('Flushing queued message', { type: m.data?.type });
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(m.data));
      }
    }
  }

  private rawSend(msg: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Safely call a handler, catching and logging any exceptions. */
  private safeCall(fn: () => void | Promise<void>): void {
    try {
      const result = fn();
      if (result instanceof Promise) {
        result.catch((err) => {
          this.log.error('Unhandled error in event handler', { error: String(err), stack: (err as Error)?.stack });
        });
      }
    } catch (err) {
      this.log.error('Unhandled error in event handler', { error: String(err), stack: (err as Error)?.stack });
    }
  }

  private handleMessage(
    msg: ServerMessage,
    resolveConnect?: (value: void) => void,
    rejectConnect?: (reason: any) => void,
  ): void {
    if (!msg.type) {
      this.log.warn('Received message without type field', { msg: JSON.stringify(msg).slice(0, 200) });
      return;
    }

    switch (msg.type) {
      case 'authenticated':
        this._agentId = msg.agent_id;
        this._agentName = msg.agent_name;
        this._connected = true;
        this._reconnectAttempts = 0;
        this.startPing();
        this.flushQueue();
        this.log.info('Authenticated', { agent_id: msg.agent_id, agent_name: msg.agent_name });
        this.safeCall(() => this.onConnectedHandler?.({ agent_id: msg.agent_id, agent_name: msg.agent_name }));
        resolveConnect?.();
        break;

      case 'error':
        this.log.warn('Server error', { code: msg.code, message: msg.message });
        this.safeCall(() => this.onErrorHandler?.({ code: msg.code, message: msg.message }));
        if (!this._agentId && rejectConnect) {
          rejectConnect(new Error(msg.message));
        }
        break;

      case 'session_replaced':
        this.log.error('Session replaced by another connection — this client is being disconnected');
        this._autoReconnect = false; // Don't fight over the session
        this.safeCall(() => this.onErrorHandler?.({ code: 'session_replaced', message: 'Another connection authenticated with your API key' }));
        break;

      case 'match_found':
        this.safeCall(() => this.onMatchFoundHandler?.(msg as unknown as MatchFoundEvent));
        break;

      case 'game_start':
        this._side = msg.your_side;
        this.safeCall(() => this.onGameStartHandler?.(msg as unknown as GameStartEvent));
        break;

      case 'your_turn': {
        // Track move deadline
        if (msg.timeout_ms) {
          this._turnDeadlines.set(msg.match_id, Date.now() + msg.timeout_ms);
        }
        this.safeCall(() => this.onYourTurnHandler?.(msg as unknown as YourTurnEvent));
        break;
      }

      case 'round_result':
        this.safeCall(() => this.onRoundResultHandler?.(msg as unknown as RoundResultEvent));
        break;

      case 'game_over':
        this._side = null;
        this._turnDeadlines.delete(msg.match_id);
        this.safeCall(() => this.onGameOverHandler?.(msg as unknown as GameOverEvent));
        break;

      case 'queue_update':
        this.safeCall(() => this.onQueueUpdateHandler?.(msg as unknown as QueueUpdateEvent));
        break;

      case 'queue_joined':
        this.safeCall(() => this.onQueueJoinedHandler?.(msg as unknown as QueueJoinedEvent));
        break;

      case 'queue_left':
        this.safeCall(() => this.onQueueLeftHandler?.());
        break;

      case 'opponent_moved':
        this.safeCall(() => this.onOpponentMovedHandler?.(msg as unknown as OpponentMovedEvent));
        break;

      case 'challenge_created':
        this.safeCall(() => this.onChallengeCreatedHandler?.(msg as unknown as ChallengeCreatedEvent));
        break;

      case 'challenge_accepted':
        this.safeCall(() => this.onChallengeAcceptedHandler?.(msg as unknown as ChallengeAcceptedEvent));
        break;

      case 'challenge_cancelled':
        this.safeCall(() => this.onChallengeCancelledHandler?.(msg as unknown as ChallengeCancelledEvent));
        break;

      case 'taunt_received':
        this.safeCall(() => this.onTauntReceivedHandler?.(msg as unknown as TauntReceivedEvent));
        break;

      case 'pong':
        // Heartbeat response — connection alive
        break;

      default:
        this.log.debug('Unknown message type', { type: msg.type });
        break;
    }
  }

  // ── Heartbeat ─────────────────────────────────────────────────────

  private startPing(): void {
    this.stopPing();
    this._pingTimer = setInterval(() => {
      this.rawSend({ type: 'ping' });
    }, this._pingIntervalMs);
  }

  private stopPing(): void {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  // ── Reconnection with Exponential Backoff + Jitter ──────────────

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const baseDelay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), this._maxReconnectDelay);
    // Add jitter: +-25% to prevent thundering herd
    const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1);
    const delay = Math.max(500, Math.round(baseDelay + jitter));
    this._reconnectAttempts++;
    this.log.info(`Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts})...`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect().catch(() => {
        // connect() rejection will trigger another close -> scheduleReconnect
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }
}

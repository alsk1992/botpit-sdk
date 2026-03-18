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

export interface BotpitOptions {
  apiKey: string;
  url?: string;
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Ping interval in ms (default: 25000) */
  pingIntervalMs?: number;
  /** Max reconnect delay in ms (default: 30000) */
  maxReconnectDelayMs?: number;
}

export type EventHandler<T> = (event: T) => void;

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

  // Reconnection state
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectAttempts = 0;
  private _maxReconnectDelay: number;
  private _intentionalDisconnect = false;

  // Heartbeat
  private _pingTimer: ReturnType<typeof setInterval> | null = null;

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
    this.apiKey = options.apiKey;
    this.url = options.url || 'wss://api.botpitgame.com/api/v1/ws';
    this._autoReconnect = options.autoReconnect !== false;
    this._pingIntervalMs = options.pingIntervalMs ?? 25_000;
    this._maxReconnectDelay = options.maxReconnectDelayMs ?? 30_000;
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
      try {
        this.ws = new WebSocket(this.url);
      } catch (err) {
        reject(err);
        return;
      }

      this.ws.on('open', () => {
        // Authenticate immediately
        this.rawSend({ type: 'authenticate', api_key: this.apiKey });
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const msg: ServerMessage = JSON.parse(data.toString());
          this.handleMessage(msg, resolve, reject);
        } catch {
          // Ignore unparseable messages
        }
      });

      this.ws.on('close', () => {
        const wasConnected = this._connected;
        this._connected = false;
        this.stopPing();

        if (wasConnected) {
          this.onDisconnectHandler?.();
        }

        if (!this._intentionalDisconnect && this._autoReconnect) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        if (!this._connected) {
          reject(err);
        }
        this.onErrorHandler?.({ code: 'ws_error', message: err.message });
      });
    });
  }

  disconnect(): void {
    this._intentionalDisconnect = true;
    this.stopPing();
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
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

  makeMove(matchId: string, moveData: any): void {
    this.send({ type: 'make_move', match_id: matchId, move_data: moveData });
  }

  resign(matchId: string): void {
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

  private send(msg: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      // Warn instead of silently dropping
      console.warn(`[BotpitClient] Cannot send '${msg.type}': WebSocket not open (state=${this.ws?.readyState})`);
    }
  }

  private rawSend(msg: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleMessage(
    msg: ServerMessage,
    resolveConnect?: (value: void) => void,
    rejectConnect?: (reason: any) => void,
  ): void {
    switch (msg.type) {
      case 'authenticated':
        this._agentId = msg.agent_id;
        this._agentName = msg.agent_name;
        this._connected = true;
        this._reconnectAttempts = 0; // Reset backoff on success
        this.startPing();
        this.onConnectedHandler?.({ agent_id: msg.agent_id, agent_name: msg.agent_name });
        resolveConnect?.();
        break;

      case 'error':
        this.onErrorHandler?.({ code: msg.code, message: msg.message });
        if (!this._agentId && rejectConnect) {
          rejectConnect(new Error(msg.message));
        }
        break;

      case 'match_found':
        this.onMatchFoundHandler?.(msg as unknown as MatchFoundEvent);
        break;

      case 'game_start':
        this._side = msg.your_side;
        this.onGameStartHandler?.(msg as unknown as GameStartEvent);
        break;

      case 'your_turn':
        this.onYourTurnHandler?.(msg as unknown as YourTurnEvent);
        break;

      case 'round_result':
        this.onRoundResultHandler?.(msg as unknown as RoundResultEvent);
        break;

      case 'game_over':
        this._side = null;
        this.onGameOverHandler?.(msg as unknown as GameOverEvent);
        break;

      case 'queue_update':
        this.onQueueUpdateHandler?.(msg as unknown as QueueUpdateEvent);
        break;

      case 'queue_joined':
        this.onQueueJoinedHandler?.(msg as unknown as QueueJoinedEvent);
        break;

      case 'queue_left':
        this.onQueueLeftHandler?.();
        break;

      case 'opponent_moved':
        this.onOpponentMovedHandler?.(msg as unknown as OpponentMovedEvent);
        break;

      case 'challenge_created':
        this.onChallengeCreatedHandler?.(msg as unknown as ChallengeCreatedEvent);
        break;

      case 'challenge_accepted':
        this.onChallengeAcceptedHandler?.(msg as unknown as ChallengeAcceptedEvent);
        break;

      case 'challenge_cancelled':
        this.onChallengeCancelledHandler?.(msg as unknown as ChallengeCancelledEvent);
        break;

      case 'taunt_received':
        this.onTauntReceivedHandler?.(msg as unknown as TauntReceivedEvent);
        break;

      case 'pong':
        // Heartbeat response — connection alive
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

  // ── Reconnection with Exponential Backoff ─────────────────────────

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), this._maxReconnectDelay);
    this._reconnectAttempts++;
    console.log(`[BotpitClient] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts})...`);
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

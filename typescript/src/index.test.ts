import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { WebSocketServer } from 'ws';
import { BotpitClient } from './index';

const TEST_PORT_BASE = 19200;
let portCounter = 0;

function nextPort(): number {
  return TEST_PORT_BASE + (portCounter++);
}

/** Spin up a tiny WS server that auto-authenticates. */
function createTestServer(port: number, opts?: {
  onMessage?: (msg: any, send: (data: any) => void) => void;
  delayAuth?: number;
  rejectAuth?: boolean;
}) {
  const wss = new WebSocketServer({ port });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'authenticate') {
        if (opts?.rejectAuth) {
          ws.send(JSON.stringify({ type: 'error', code: 'auth_failed', message: 'Invalid API key' }));
          return;
        }
        const reply = () => ws.send(JSON.stringify({
          type: 'authenticated',
          agent_id: 'test-agent-id',
          agent_name: 'TestAgent',
        }));
        if (opts?.delayAuth) {
          setTimeout(reply, opts.delayAuth);
        } else {
          reply();
        }
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      } else {
        opts?.onMessage?.(msg, (data: any) => ws.send(JSON.stringify(data)));
      }
    });
  });
  return wss;
}

describe('BotpitClient', () => {

  describe('constructor', () => {
    it('throws if apiKey is empty', () => {
      assert.throws(() => new BotpitClient({ apiKey: '' }), /apiKey is required/);
    });

    it('accepts valid options', () => {
      const client = new BotpitClient({ apiKey: 'bp_sk_test' });
      assert.strictEqual(client.connected, false);
      assert.strictEqual(client.agentId, null);
    });
  });

  describe('connect / auth', () => {
    let server: WebSocketServer;
    let port: number;

    afterEach(() => {
      server?.close();
    });

    it('connects and authenticates', async () => {
      port = nextPort();
      server = createTestServer(port);
      const client = new BotpitClient({
        apiKey: 'bp_sk_test',
        url: `ws://localhost:${port}`,
        autoReconnect: false,
        logLevel: 'none',
      });
      await client.connect();
      assert.strictEqual(client.connected, true);
      assert.strictEqual(client.agentId, 'test-agent-id');
      assert.strictEqual(client.agentName, 'TestAgent');
      client.disconnect();
    });

    it('rejects on auth failure', async () => {
      port = nextPort();
      server = createTestServer(port, { rejectAuth: true });
      const client = new BotpitClient({
        apiKey: 'bp_sk_bad',
        url: `ws://localhost:${port}`,
        autoReconnect: false,
        logLevel: 'none',
      });
      await assert.rejects(() => client.connect(), /Invalid API key/);
    });

    it('rejects on auth timeout', async () => {
      port = nextPort();
      server = createTestServer(port, { delayAuth: 5000 });
      const client = new BotpitClient({
        apiKey: 'bp_sk_test',
        url: `ws://localhost:${port}`,
        autoReconnect: false,
        authTimeoutMs: 200,
        logLevel: 'none',
      });
      await assert.rejects(() => client.connect(), /timed out/);
    });

    it('fires onConnected handler', async () => {
      port = nextPort();
      server = createTestServer(port);
      const client = new BotpitClient({
        apiKey: 'bp_sk_test',
        url: `ws://localhost:${port}`,
        autoReconnect: false,
        logLevel: 'none',
      });
      let receivedInfo: any = null;
      client.onConnected((info) => { receivedInfo = info; });
      await client.connect();
      assert.deepStrictEqual(receivedInfo, { agent_id: 'test-agent-id', agent_name: 'TestAgent' });
      client.disconnect();
    });
  });

  describe('event dispatch', () => {
    let server: WebSocketServer;
    let port: number;

    afterEach(() => {
      server?.close();
    });

    it('dispatches match_found, game_start, your_turn, round_result, game_over', async () => {
      port = nextPort();
      const events: string[] = [];
      server = createTestServer(port, {
        onMessage: (msg, send) => {
          if (msg.type === 'join_queue') {
            send({ type: 'queue_joined', game_type: 'rps', position: 1 });
            send({ type: 'match_found', match_id: 'm1', game_type: 'rps', opponent_id: 'opp', opponent_name: 'Opp', wager_lamports: 0, server_seed_hash: 'abc' });
            send({ type: 'game_start', match_id: 'm1', your_side: 'a' });
            send({ type: 'your_turn', match_id: 'm1', round: 1, game_state: {}, timeout_ms: 5000 });
          } else if (msg.type === 'make_move') {
            send({ type: 'round_result', match_id: 'm1', round: 1, result: {}, score: [1, 0] });
            send({ type: 'game_over', match_id: 'm1', winner: 'test-agent-id', final_score: [2, 0], server_seed: 'seed', payout_lamports: 100 });
          }
        },
      });

      const client = new BotpitClient({ apiKey: 'bp_sk_test', url: `ws://localhost:${port}`, autoReconnect: false, logLevel: 'none' });
      client.onQueueJoined(() => events.push('queue_joined'));
      client.onMatchFound(() => events.push('match_found'));
      client.onGameStart((e) => {
        events.push('game_start');
        assert.strictEqual(client.side, 'a');
      });
      client.onYourTurn((e) => {
        events.push('your_turn');
        client.makeMove(e.match_id, { choice: 'rock' });
      });
      client.onRoundResult(() => events.push('round_result'));
      client.onGameOver((e) => {
        events.push('game_over');
        assert.strictEqual(client.side, null);
        client.disconnect();
      });

      await client.connect();
      client.joinQueue('rps', 0);

      // Wait for all events to flow through
      await new Promise(r => setTimeout(r, 300));
      assert.deepStrictEqual(events, ['queue_joined', 'match_found', 'game_start', 'your_turn', 'round_result', 'game_over']);
    });
  });

  describe('handler error safety', () => {
    let server: WebSocketServer;
    let port: number;

    afterEach(() => {
      server?.close();
    });

    it('catches sync handler exceptions without crashing', async () => {
      port = nextPort();
      server = createTestServer(port, {
        onMessage: (msg, send) => {
          if (msg.type === 'join_queue') {
            send({ type: 'queue_joined', game_type: 'rps', position: 1 });
          }
        },
      });

      const client = new BotpitClient({ apiKey: 'bp_sk_test', url: `ws://localhost:${port}`, autoReconnect: false, logLevel: 'none' });
      client.onQueueJoined(() => { throw new Error('handler explosion'); });
      await client.connect();
      client.joinQueue('rps', 0);
      // Should not crash — wait a bit to confirm
      await new Promise(r => setTimeout(r, 200));
      assert.strictEqual(client.connected, true);
      client.disconnect();
    });

    it('catches async handler rejections without crashing', async () => {
      port = nextPort();
      server = createTestServer(port, {
        onMessage: (msg, send) => {
          if (msg.type === 'join_queue') {
            send({ type: 'queue_joined', game_type: 'rps', position: 1 });
          }
        },
      });

      const client = new BotpitClient({ apiKey: 'bp_sk_test', url: `ws://localhost:${port}`, autoReconnect: false, logLevel: 'none' });
      client.onQueueJoined(async () => { throw new Error('async handler explosion'); });
      await client.connect();
      client.joinQueue('rps', 0);
      await new Promise(r => setTimeout(r, 200));
      assert.strictEqual(client.connected, true);
      client.disconnect();
    });
  });

  describe('message queuing', () => {
    it('queues messages when disconnected and warns', () => {
      const warnings: string[] = [];
      const client = new BotpitClient({
        apiKey: 'bp_sk_test',
        autoReconnect: false,
        logLevel: 'none',
        logger: {
          debug: () => {},
          info: () => {},
          warn: (msg) => { warnings.push(msg); },
          error: () => {},
        },
      });
      // Not connected — these should queue
      client.joinQueue('rps', 0);
      client.makeMove('m1', { choice: 'rock' });
      assert.strictEqual(warnings.length, 2);
      assert.ok(warnings[0].includes("Queued 'join_queue'"));
      assert.ok(warnings[1].includes("Queued 'make_move'"));
    });
  });

  describe('move deadline tracking', () => {
    let server: WebSocketServer;
    let port: number;

    afterEach(() => {
      server?.close();
    });

    it('warns when move submitted after deadline', async () => {
      port = nextPort();
      const warnings: string[] = [];
      server = createTestServer(port, {
        onMessage: (msg, send) => {
          if (msg.type === 'join_queue') {
            // Send your_turn with very short timeout
            send({ type: 'your_turn', match_id: 'm1', round: 1, game_state: {}, timeout_ms: 50 });
          }
        },
      });

      const client = new BotpitClient({
        apiKey: 'bp_sk_test',
        url: `ws://localhost:${port}`,
        autoReconnect: false,
        logLevel: 'none',
        logger: {
          debug: () => {},
          info: () => {},
          warn: (msg) => { warnings.push(msg); },
          error: () => {},
        },
      });

      client.onYourTurn(async (e) => {
        // Wait longer than timeout before submitting
        await new Promise(r => setTimeout(r, 100));
        client.makeMove(e.match_id, { choice: 'rock' });
      });

      await client.connect();
      client.joinQueue('rps', 0);
      await new Promise(r => setTimeout(r, 300));
      assert.ok(warnings.some(w => w.includes('after timeout deadline')));
      client.disconnect();
    });
  });

  describe('session_replaced', () => {
    let server: WebSocketServer;
    let port: number;

    afterEach(() => {
      server?.close();
    });

    it('disables auto-reconnect on session_replaced', async () => {
      port = nextPort();
      server = createTestServer(port, {
        onMessage: (msg, send) => {
          if (msg.type === 'join_queue') {
            send({ type: 'session_replaced' });
          }
        },
      });

      const errors: any[] = [];
      const client = new BotpitClient({
        apiKey: 'bp_sk_test',
        url: `ws://localhost:${port}`,
        autoReconnect: true,
        logLevel: 'none',
      });
      client.onError((e) => { errors.push(e); });
      await client.connect();
      client.joinQueue('rps', 0);
      await new Promise(r => setTimeout(r, 200));
      assert.ok(errors.some(e => e.code === 'session_replaced'));
      client.disconnect();
    });
  });
});

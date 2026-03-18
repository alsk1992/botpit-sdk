"""BOTPIT Python SDK - Agent client for the BOTPIT gaming arena."""

import asyncio
import json
import logging
import random
import time
from typing import Any, Callable, Optional

import websockets
from websockets.asyncio.client import ClientConnection

logger = logging.getLogger("botpit")


class BotpitClient:
    """WebSocket client for connecting agents to the BOTPIT arena.

    Usage:
        client = BotpitClient(api_key="bp_sk_...", url="wss://api.botpitgame.com/api/v1/ws")

        @client.on_connected
        def on_connected(info):
            client.join_queue("rps", 0.01)

        @client.on_your_turn
        async def on_turn(turn):
            await client.make_move(turn["match_id"], {"choice": "rock"})

        asyncio.run(client.run())
    """

    def __init__(
        self,
        api_key: str,
        url: str = "wss://api.botpitgame.com/api/v1/ws",
        auto_reconnect: bool = True,
        ping_interval: float = 25.0,
        max_reconnect_delay: float = 30.0,
        auth_timeout: float = 10.0,
    ):
        if not api_key:
            raise ValueError("api_key is required")
        self.api_key = api_key
        self.url = url
        self.ws: Optional[ClientConnection] = None
        self.agent_id: Optional[str] = None
        self.agent_name: Optional[str] = None
        self.side: Optional[str] = None  # 'a' or 'b' in current match
        self._handlers: dict[str, Callable] = {}
        self._running = False
        self._auto_reconnect = auto_reconnect
        self._reconnect_attempts = 0
        self._max_reconnect_delay = max_reconnect_delay
        self._auth_timeout = auth_timeout
        self._ping_task: Optional[asyncio.Task] = None
        self._ping_interval = ping_interval
        # Move deadline tracking
        self._turn_deadlines: dict[str, float] = {}  # match_id -> deadline timestamp

    # ── Event Registration ──────────────────────────────────────────

    def on_connected(self, handler: Callable) -> "BotpitClient":
        self._handlers["authenticated"] = handler
        return self

    def on_match_found(self, handler: Callable) -> "BotpitClient":
        self._handlers["match_found"] = handler
        return self

    def on_game_start(self, handler: Callable) -> "BotpitClient":
        self._handlers["game_start"] = handler
        return self

    def on_your_turn(self, handler: Callable) -> "BotpitClient":
        self._handlers["your_turn"] = handler
        return self

    def on_round_result(self, handler: Callable) -> "BotpitClient":
        self._handlers["round_result"] = handler
        return self

    def on_game_over(self, handler: Callable) -> "BotpitClient":
        self._handlers["game_over"] = handler
        return self

    def on_error(self, handler: Callable) -> "BotpitClient":
        self._handlers["error"] = handler
        return self

    def on_queue_update(self, handler: Callable) -> "BotpitClient":
        self._handlers["queue_update"] = handler
        return self

    def on_disconnect(self, handler: Callable) -> "BotpitClient":
        self._handlers["disconnect"] = handler
        return self

    def on_queue_joined(self, handler: Callable) -> "BotpitClient":
        self._handlers["queue_joined"] = handler
        return self

    def on_queue_left(self, handler: Callable) -> "BotpitClient":
        self._handlers["queue_left"] = handler
        return self

    def on_opponent_moved(self, handler: Callable) -> "BotpitClient":
        self._handlers["opponent_moved"] = handler
        return self

    def on_challenge_created(self, handler: Callable) -> "BotpitClient":
        self._handlers["challenge_created"] = handler
        return self

    def on_challenge_accepted(self, handler: Callable) -> "BotpitClient":
        self._handlers["challenge_accepted"] = handler
        return self

    def on_challenge_cancelled(self, handler: Callable) -> "BotpitClient":
        self._handlers["challenge_cancelled"] = handler
        return self

    def on_taunt_received(self, handler: Callable) -> "BotpitClient":
        self._handlers["taunt_received"] = handler
        return self

    # ── Actions ─────────────────────────────────────────────────────

    async def connect(self) -> None:
        """Connect to the BOTPIT server and authenticate."""
        self.ws = await websockets.connect(self.url)
        await self._send({"type": "authenticate", "api_key": self.api_key})

        # Wait for auth response with timeout
        try:
            raw = await asyncio.wait_for(self.ws.recv(), timeout=self._auth_timeout)
        except asyncio.TimeoutError:
            await self.ws.close()
            self.ws = None
            raise ConnectionError(f"Authentication timed out after {self._auth_timeout}s")

        msg = json.loads(raw)
        if msg.get("type") == "authenticated":
            self.agent_id = msg["agent_id"]
            self.agent_name = msg["agent_name"]
            self._reconnect_attempts = 0
            self._start_ping()
            logger.info("Authenticated as %s (%s)", self.agent_name, self.agent_id)
            await self._dispatch("authenticated", msg)
        elif msg.get("type") == "error":
            await self.ws.close()
            self.ws = None
            raise ConnectionError(f"Auth failed: {msg.get('message', 'unknown error')}")
        else:
            await self.ws.close()
            self.ws = None
            raise ConnectionError(f"Unexpected auth response: {msg.get('type')}")

    async def join_queue(self, game_type: str, wager_sol: float, sandbox: bool = False) -> None:
        """Join the matchmaking queue. wager_sol is in SOL (e.g. 0.01). Use 0 for free play.
        Set sandbox=True for practice mode (no real SOL, no ELO changes)."""
        wager_lamports = int(wager_sol * 1_000_000_000)
        msg = {
            "type": "join_queue",
            "game_type": game_type,
            "wager_lamports": wager_lamports,
        }
        if sandbox:
            msg["sandbox"] = True
        await self._send(msg)

    async def leave_queue(self) -> None:
        """Leave the matchmaking queue."""
        await self._send({"type": "leave_queue"})

    async def make_move(self, match_id: str, move_data: Any) -> None:
        """Submit a move for a match. Warns if past the server's timeout deadline."""
        deadline = self._turn_deadlines.pop(match_id, None)
        if deadline is not None:
            now = time.monotonic()
            if now > deadline:
                late_ms = int((now - deadline) * 1000)
                logger.warning("Move submitted %dms after timeout deadline (match=%s)", late_ms, match_id)
        await self._send({
            "type": "make_move",
            "match_id": match_id,
            "move_data": move_data,
        })

    async def resign(self, match_id: str) -> None:
        """Resign from a match."""
        self._turn_deadlines.pop(match_id, None)
        await self._send({"type": "resign", "match_id": match_id})

    async def create_challenge(self, game_type: str, wager_sol: float) -> None:
        """Create an open challenge."""
        wager_lamports = int(wager_sol * 1_000_000_000)
        await self._send({
            "type": "create_challenge",
            "game_type": game_type,
            "wager_lamports": wager_lamports,
        })

    async def accept_challenge(self, challenge_id: str) -> None:
        """Accept an open challenge."""
        await self._send({"type": "accept_challenge", "challenge_id": challenge_id})

    async def cancel_challenge(self, challenge_id: str) -> None:
        """Cancel an open challenge you created."""
        await self._send({"type": "cancel_challenge", "challenge_id": challenge_id})

    async def send_taunt(self, match_id: str, taunt_id: str) -> None:
        """Send a taunt to your opponent during a match.
        Valid taunt_ids: nice_move, going_down, gg, lucky, calculated, too_easy,
        bring_it, not_bad, oops, gl_hf, rematch, wp"""
        await self._send({"type": "send_taunt", "match_id": match_id, "taunt_id": taunt_id})

    async def run(self) -> None:
        """Run the event loop with auto-reconnection. Blocks until stop() is called."""
        self._running = True
        while self._running:
            try:
                if not self.ws:
                    await self.connect()

                async for raw in self.ws:
                    if not self._running:
                        break
                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError as e:
                        logger.error("Failed to parse server message: %s (raw: %s)", e, str(raw)[:200])
                        continue

                    msg_type = msg.get("type")
                    if not msg_type:
                        logger.warning("Received message without type field: %s", str(raw)[:200])
                        continue

                    # Track side for game_start
                    if msg_type == "game_start":
                        self.side = msg.get("your_side")
                    elif msg_type == "game_over":
                        self.side = None
                        self._turn_deadlines.pop(msg.get("match_id", ""), None)
                    elif msg_type == "your_turn":
                        # Track move deadline
                        timeout_ms = msg.get("timeout_ms")
                        if timeout_ms:
                            self._turn_deadlines[msg["match_id"]] = time.monotonic() + timeout_ms / 1000.0
                    elif msg_type == "session_replaced":
                        logger.error("Session replaced by another connection — disabling reconnect")
                        self._auto_reconnect = False
                        await self._dispatch("error", msg)
                        break

                    await self._dispatch(msg_type, msg)

            except websockets.exceptions.ConnectionClosed as e:
                self._stop_ping()
                logger.info("Connection closed: %s", e)
                await self._dispatch("disconnect", None)
            except ConnectionError as e:
                self._stop_ping()
                logger.warning("Connection failed: %s", e)
            except Exception as e:
                self._stop_ping()
                logger.warning("Unexpected error: %s", e, exc_info=True)
                await self._dispatch("disconnect", None)

            self.ws = None

            if not self._running or not self._auto_reconnect:
                break

            # Exponential backoff with jitter to prevent thundering herd
            base_delay = min(2 ** self._reconnect_attempts, self._max_reconnect_delay)
            jitter = base_delay * 0.25 * (random.random() * 2 - 1)
            delay = max(0.5, base_delay + jitter)
            self._reconnect_attempts += 1
            logger.info("Reconnecting in %.1fs (attempt %d)...", delay, self._reconnect_attempts)
            await asyncio.sleep(delay)

    def stop(self) -> None:
        """Stop the event loop."""
        self._running = False
        self._stop_ping()

    async def disconnect(self) -> None:
        """Close the connection."""
        self._running = False
        self._auto_reconnect = False
        self._stop_ping()
        self._turn_deadlines.clear()
        if self.ws:
            await self.ws.close()
            self.ws = None

    # ── Async Context Manager ────────────────────────────────────────

    async def __aenter__(self) -> "BotpitClient":
        await self.connect()
        return self

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        await self.disconnect()

    # ── Internal ────────────────────────────────────────────────────

    async def _send(self, msg: dict) -> None:
        if self.ws:
            try:
                await self.ws.send(json.dumps(msg))
            except websockets.exceptions.ConnectionClosed:
                logger.warning("Cannot send '%s': connection closed", msg.get("type"))
        else:
            logger.warning("Cannot send '%s': not connected", msg.get("type"))

    async def _dispatch(self, msg_type: str, msg: Any) -> None:
        handler = self._handlers.get(msg_type)
        if not handler:
            return
        try:
            result = handler(msg)
            if asyncio.iscoroutine(result):
                await result
        except Exception as e:
            logger.error(
                "Unhandled error in '%s' handler: %s",
                msg_type, e,
                exc_info=True,
            )

    def _start_ping(self) -> None:
        self._stop_ping()
        loop = asyncio.get_event_loop()
        self._ping_task = loop.create_task(self._ping_loop())

    def _stop_ping(self) -> None:
        if self._ping_task:
            self._ping_task.cancel()
            self._ping_task = None

    async def _ping_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(self._ping_interval)
                await self._send({"type": "ping"})
        except asyncio.CancelledError:
            pass
        except Exception:
            pass

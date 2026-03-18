"""Tests for BotpitClient."""

import asyncio
import json
import time

import pytest
import websockets
from websockets.asyncio.server import serve

from botpit import BotpitClient


@pytest.fixture
def unused_port():
    """Get an unused TCP port."""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        return s.getsockname()[1]


async def _run_server(port, handler, ready_event):
    """Run a test WS server."""
    async with serve(handler, "localhost", port):
        ready_event.set()
        await asyncio.Future()  # run forever


def _start_server(port, handler):
    """Start a test server and return (task, ready_event)."""
    ready = asyncio.Event()
    task = asyncio.get_event_loop().create_task(_run_server(port, handler, ready))
    return task, ready


async def auto_auth_handler(ws):
    """Handler that auto-authenticates and echoes."""
    async for raw in ws:
        msg = json.loads(raw)
        if msg["type"] == "authenticate":
            await ws.send(json.dumps({
                "type": "authenticated",
                "agent_id": "test-id",
                "agent_name": "TestAgent",
            }))
        elif msg["type"] == "ping":
            await ws.send(json.dumps({"type": "pong"}))


# ── Tests ──────────────────────────────────────────────────────────


class TestConstructor:
    def test_rejects_empty_api_key(self):
        with pytest.raises(ValueError, match="api_key is required"):
            BotpitClient(api_key="")

    def test_defaults(self):
        c = BotpitClient(api_key="bp_sk_test")
        assert c.agent_id is None
        assert c.agent_name is None
        assert c.side is None


@pytest.mark.asyncio
class TestConnect:
    async def test_connects_and_authenticates(self, unused_port):
        task, ready = _start_server(unused_port, auto_auth_handler)
        await ready.wait()

        client = BotpitClient(api_key="bp_sk_test", url=f"ws://localhost:{unused_port}", auto_reconnect=False)
        await client.connect()
        assert client.agent_id == "test-id"
        assert client.agent_name == "TestAgent"
        await client.disconnect()
        task.cancel()

    async def test_rejects_bad_auth(self, unused_port):
        async def reject_handler(ws):
            async for raw in ws:
                msg = json.loads(raw)
                if msg["type"] == "authenticate":
                    await ws.send(json.dumps({"type": "error", "message": "Invalid API key"}))

        task, ready = _start_server(unused_port, reject_handler)
        await ready.wait()

        client = BotpitClient(api_key="bad", url=f"ws://localhost:{unused_port}", auto_reconnect=False)
        with pytest.raises(ConnectionError, match="Invalid API key"):
            await client.connect()
        task.cancel()

    async def test_auth_timeout(self, unused_port):
        async def slow_handler(ws):
            async for raw in ws:
                await asyncio.sleep(10)  # never responds

        task, ready = _start_server(unused_port, slow_handler)
        await ready.wait()

        client = BotpitClient(api_key="bp_sk_test", url=f"ws://localhost:{unused_port}", auto_reconnect=False, auth_timeout=0.2)
        with pytest.raises(ConnectionError, match="timed out"):
            await client.connect()
        task.cancel()


@pytest.mark.asyncio
class TestEventDispatch:
    async def test_dispatches_game_events(self, unused_port):
        events = []

        async def game_handler(ws):
            async for raw in ws:
                msg = json.loads(raw)
                if msg["type"] == "authenticate":
                    await ws.send(json.dumps({"type": "authenticated", "agent_id": "a1", "agent_name": "A"}))
                elif msg["type"] == "join_queue":
                    await ws.send(json.dumps({"type": "queue_joined", "game_type": "rps", "position": 1}))
                    await ws.send(json.dumps({"type": "match_found", "match_id": "m1", "game_type": "rps", "opponent_id": "o1", "opponent_name": "O", "wager_lamports": 0, "server_seed_hash": "h"}))
                    await ws.send(json.dumps({"type": "game_start", "match_id": "m1", "your_side": "a"}))
                    await ws.send(json.dumps({"type": "your_turn", "match_id": "m1", "round": 1, "game_state": {}, "timeout_ms": 5000}))
                elif msg["type"] == "make_move":
                    await ws.send(json.dumps({"type": "round_result", "match_id": "m1", "round": 1, "result": {}, "score": [1, 0]}))
                    await ws.send(json.dumps({"type": "game_over", "match_id": "m1", "winner": "a1", "final_score": [2, 0], "server_seed": "s", "payout_lamports": 100}))
                elif msg["type"] == "ping":
                    await ws.send(json.dumps({"type": "pong"}))

        task, ready = _start_server(unused_port, game_handler)
        await ready.wait()

        client = BotpitClient(api_key="bp_sk_test", url=f"ws://localhost:{unused_port}", auto_reconnect=False)

        @client.on_queue_joined
        def _(msg): events.append("queue_joined")

        @client.on_match_found
        def _(msg): events.append("match_found")

        @client.on_game_start
        def _(msg):
            events.append("game_start")
            assert client.side == "a"

        @client.on_your_turn
        async def _(msg):
            events.append("your_turn")
            await client.make_move(msg["match_id"], {"choice": "rock"})

        @client.on_round_result
        def _(msg): events.append("round_result")

        @client.on_game_over
        async def _(msg):
            events.append("game_over")
            assert client.side is None
            client.stop()

        await client.connect()
        await client.join_queue("rps", 0)

        # Run briefly to process events
        run_task = asyncio.get_event_loop().create_task(client.run())
        try:
            await asyncio.wait_for(run_task, timeout=2.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            pass

        assert events == ["queue_joined", "match_found", "game_start", "your_turn", "round_result", "game_over"]
        await client.disconnect()
        task.cancel()


@pytest.mark.asyncio
class TestHandlerSafety:
    async def test_sync_handler_exception_caught(self, unused_port):
        async def handler(ws):
            async for raw in ws:
                msg = json.loads(raw)
                if msg["type"] == "authenticate":
                    await ws.send(json.dumps({"type": "authenticated", "agent_id": "a1", "agent_name": "A"}))
                elif msg["type"] == "join_queue":
                    await ws.send(json.dumps({"type": "queue_joined", "game_type": "rps", "position": 1}))
                elif msg["type"] == "ping":
                    await ws.send(json.dumps({"type": "pong"}))

        task, ready = _start_server(unused_port, handler)
        await ready.wait()

        client = BotpitClient(api_key="bp_sk_test", url=f"ws://localhost:{unused_port}", auto_reconnect=False)

        @client.on_queue_joined
        def _(msg):
            raise RuntimeError("boom!")

        await client.connect()
        await client.join_queue("rps", 0)

        # Run briefly — should not crash
        run_task = asyncio.get_event_loop().create_task(client.run())
        await asyncio.sleep(0.3)
        client.stop()
        try:
            await asyncio.wait_for(run_task, timeout=1.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            pass
        # If we got here without exception, the test passes
        await client.disconnect()
        task.cancel()

    async def test_async_handler_exception_caught(self, unused_port):
        async def handler(ws):
            async for raw in ws:
                msg = json.loads(raw)
                if msg["type"] == "authenticate":
                    await ws.send(json.dumps({"type": "authenticated", "agent_id": "a1", "agent_name": "A"}))
                elif msg["type"] == "join_queue":
                    await ws.send(json.dumps({"type": "queue_joined", "game_type": "rps", "position": 1}))
                elif msg["type"] == "ping":
                    await ws.send(json.dumps({"type": "pong"}))

        task, ready = _start_server(unused_port, handler)
        await ready.wait()

        client = BotpitClient(api_key="bp_sk_test", url=f"ws://localhost:{unused_port}", auto_reconnect=False)

        @client.on_queue_joined
        async def _(msg):
            raise RuntimeError("async boom!")

        await client.connect()
        await client.join_queue("rps", 0)

        run_task = asyncio.get_event_loop().create_task(client.run())
        await asyncio.sleep(0.3)
        client.stop()
        try:
            await asyncio.wait_for(run_task, timeout=1.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            pass
        await client.disconnect()
        task.cancel()


@pytest.mark.asyncio
class TestMoveDeadline:
    async def test_warns_on_late_move(self, unused_port, caplog):
        async def handler(ws):
            async for raw in ws:
                msg = json.loads(raw)
                if msg["type"] == "authenticate":
                    await ws.send(json.dumps({"type": "authenticated", "agent_id": "a1", "agent_name": "A"}))
                elif msg["type"] == "join_queue":
                    await ws.send(json.dumps({"type": "your_turn", "match_id": "m1", "round": 1, "game_state": {}, "timeout_ms": 50}))
                elif msg["type"] == "ping":
                    await ws.send(json.dumps({"type": "pong"}))

        task, ready = _start_server(unused_port, handler)
        await ready.wait()

        client = BotpitClient(api_key="bp_sk_test", url=f"ws://localhost:{unused_port}", auto_reconnect=False)

        @client.on_your_turn
        async def _(msg):
            await asyncio.sleep(0.15)  # exceed 50ms timeout
            await client.make_move(msg["match_id"], {"choice": "rock"})
            client.stop()

        await client.connect()
        await client.join_queue("rps", 0)

        import logging
        with caplog.at_level(logging.WARNING, logger="botpit"):
            run_task = asyncio.get_event_loop().create_task(client.run())
            try:
                await asyncio.wait_for(run_task, timeout=2.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass

        assert any("after timeout deadline" in r.message for r in caplog.records)
        await client.disconnect()
        task.cancel()


@pytest.mark.asyncio
class TestContextManager:
    async def test_async_with(self, unused_port):
        task, ready = _start_server(unused_port, auto_auth_handler)
        await ready.wait()

        async with BotpitClient(api_key="bp_sk_test", url=f"ws://localhost:{unused_port}", auto_reconnect=False) as client:
            assert client.agent_id == "test-id"

        # After exiting, should be disconnected
        assert client.ws is None
        task.cancel()


@pytest.mark.asyncio
class TestSessionReplaced:
    async def test_disables_reconnect(self, unused_port):
        async def handler(ws):
            async for raw in ws:
                msg = json.loads(raw)
                if msg["type"] == "authenticate":
                    await ws.send(json.dumps({"type": "authenticated", "agent_id": "a1", "agent_name": "A"}))
                elif msg["type"] == "join_queue":
                    await ws.send(json.dumps({"type": "session_replaced"}))
                elif msg["type"] == "ping":
                    await ws.send(json.dumps({"type": "pong"}))

        task, ready = _start_server(unused_port, handler)
        await ready.wait()

        errors = []
        client = BotpitClient(api_key="bp_sk_test", url=f"ws://localhost:{unused_port}", auto_reconnect=True)

        @client.on_error
        def _(msg): errors.append(msg)

        await client.connect()
        await client.join_queue("rps", 0)

        run_task = asyncio.get_event_loop().create_task(client.run())
        await asyncio.sleep(0.3)
        client.stop()
        try:
            await asyncio.wait_for(run_task, timeout=1.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            pass

        assert any(e.get("type") == "session_replaced" for e in errors)
        assert client._auto_reconnect is False
        await client.disconnect()
        task.cancel()


@pytest.mark.asyncio
class TestSendWhenDisconnected:
    async def test_warns_not_connected(self, caplog):
        client = BotpitClient(api_key="bp_sk_test", auto_reconnect=False)
        import logging
        with caplog.at_level(logging.WARNING, logger="botpit"):
            await client.make_move("m1", {"choice": "rock"})
        assert any("not connected" in r.message for r in caplog.records)

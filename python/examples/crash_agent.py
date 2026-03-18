"""
Example: Crash Agent for BOTPIT

Game Mechanics:
    - A multiplier starts at 1.0x and rises over time.
    - You set a cashout multiplier between 1.01 and 10.0.
    - If the crash point >= your cashout, you win (payout = wager * cashout).
    - If the crash point < your cashout, you lose your wager.
    - Both players lock in their cashout value simultaneously.
    - The player who cashes out at a higher multiplier WITHOUT crashing wins.

Strategy:
    Conservative approach. The probability of surviving to multiplier M is
    approximately 1/M (provably fair). Expected value for any cashout is
    roughly break-even, so we use a moderate target of 1.5x (~66% survival).

    We mix in occasional aggressive cashouts (2.0-3.0x) 20% of the time
    to exploit opponents who always pick the same conservative target.

Usage:
    BOTPIT_API_KEY=bp_sk_... python examples/crash_agent.py
"""

import asyncio
import os
import random

from botpit import BotpitClient

API_KEY = os.environ.get("BOTPIT_API_KEY")
if not API_KEY:
    print("Set BOTPIT_API_KEY environment variable")
    exit(1)

WAGER_SOL = 0.01

# Strategy parameters
CONSERVATIVE_CASHOUT = 1.5   # ~66% survival rate
AGGRESSIVE_MIN = 2.0         # ~50% survival rate
AGGRESSIVE_MAX = 3.0         # ~33% survival rate
AGGRESSIVE_PROBABILITY = 0.2  # 20% of the time, go aggressive


def pick_cashout() -> float:
    """Select a cashout multiplier using our mixed strategy."""
    if random.random() < AGGRESSIVE_PROBABILITY:
        # Aggressive play: random between 2.0 and 3.0
        cashout = AGGRESSIVE_MIN + random.random() * (AGGRESSIVE_MAX - AGGRESSIVE_MIN)
        return round(cashout, 2)
    # Conservative play: steady 1.5x
    return CONSERVATIVE_CASHOUT


async def main():
    client = BotpitClient(
        api_key=API_KEY,
        url=os.environ.get("BOTPIT_URL", "wss://api.botpitgame.com/api/v1/ws"),
    )

    stats = {"wins": 0, "losses": 0}

    async def on_connected(msg):
        print(f"Connected as {msg['agent_name']} ({msg['agent_id']})")
        print(
            f"Strategy: {CONSERVATIVE_CASHOUT}x conservative, "
            f"{AGGRESSIVE_MIN}-{AGGRESSIVE_MAX}x aggressive "
            f"({AGGRESSIVE_PROBABILITY * 100:.0f}% of time)"
        )
        print(f"Joining crash queue with {WAGER_SOL} SOL wager...")
        await client.join_queue("crash", WAGER_SOL)

    async def on_match_found(msg):
        print(f"\nMatch found! vs {msg['opponent_name']}")
        print(f"Match ID: {msg['match_id']}")

    async def on_your_turn(msg):
        cashout = pick_cashout()
        is_aggressive = cashout > CONSERVATIVE_CASHOUT
        label = "aggressive" if is_aggressive else "conservative"
        print(f"Round {msg['round']}: setting cashout at {cashout}x ({label})")
        await client.make_move(msg["match_id"], {"cashout": cashout})

    def on_round_result(msg):
        print(f"Round {msg['round']} result: {msg['result']}")
        print(f"Score: {msg['score'][0]} - {msg['score'][1]}")

    async def on_game_over(msg):
        won = msg["winner"] is not None
        if won:
            stats["wins"] += 1
            print(f"WON! Payout: {msg['payout_lamports'] / 1e9:.4f} SOL")
        else:
            stats["losses"] += 1
            print("Lost!")
        print(f"Final: {msg['final_score'][0]} - {msg['final_score'][1]}")
        print(f"Server seed: {msg['server_seed']}")
        total = stats["wins"] + stats["losses"]
        winrate = (stats["wins"] / total * 100) if total > 0 else 0
        print(f"Session: {stats['wins']}W - {stats['losses']}L ({winrate:.1f}%)")

        print("\nQueuing for next match...")
        await client.join_queue("crash", WAGER_SOL)

    def on_error(msg):
        print(f"Error [{msg['code']}]: {msg['message']}")

    client.on_connected(on_connected)
    client.on_match_found(on_match_found)
    client.on_your_turn(on_your_turn)
    client.on_round_result(on_round_result)
    client.on_game_over(on_game_over)
    client.on_error(on_error)

    await client.connect()
    await client.run()


if __name__ == "__main__":
    asyncio.run(main())

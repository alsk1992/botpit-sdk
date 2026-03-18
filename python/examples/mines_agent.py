"""
Example: Mines Agent for BOTPIT

Game Mechanics:
    - 5x5 grid with 5 hidden mines (20 safe tiles out of 25).
    - You choose how many tiles to reveal (1-20).
    - If all revealed tiles are safe, you score based on how many you chose.
    - More tiles = higher reward but higher risk of hitting a mine.
    - Both players pick independently; the one who reveals more safely wins.

Strategy:
    Risk-calibrated tile selection based on current score:
    - Leading: play safe with 2 tiles (~63% survival)
    - Tied: moderate risk with 3 tiles (~50% survival)
    - Behind: aggressive with 5 tiles (~25% survival) to catch up

    Survival probability for N tiles from 20 safe / 25 total:
        P(N safe) = C(20,N) / C(25,N)

Usage:
    BOTPIT_API_KEY=bp_sk_... python examples/mines_agent.py
"""

import asyncio
import os

from botpit import BotpitClient

API_KEY = os.environ.get("BOTPIT_API_KEY")
if not API_KEY:
    print("Set BOTPIT_API_KEY environment variable")
    exit(1)

WAGER_SOL = 0.01

# Strategy tiers
SAFE_TILES = 2        # ~63% survival, low reward
MODERATE_TILES = 3    # ~50% survival, decent reward
AGGRESSIVE_TILES = 5  # ~25% survival, high reward


async def main():
    client = BotpitClient(
        api_key=API_KEY,
        url=os.environ.get("BOTPIT_URL", "wss://api.botpitgame.com/api/v1/ws"),
    )

    current_score = [0, 0]

    async def on_connected(msg):
        print(f"Connected as {msg['agent_name']} ({msg['agent_id']})")
        print(
            f"Strategy: {SAFE_TILES} tiles (safe), {MODERATE_TILES} (moderate), "
            f"{AGGRESSIVE_TILES} (aggressive when behind)"
        )
        print(f"Joining mines queue with {WAGER_SOL} SOL wager...")
        await client.join_queue("mines", WAGER_SOL)

    async def on_match_found(msg):
        print(f"\nMatch found! vs {msg['opponent_name']}")
        print(f"Match ID: {msg['match_id']}")
        current_score[0] = 0
        current_score[1] = 0

    async def on_your_turn(msg):
        my_score, op_score = current_score

        if my_score < op_score:
            # Behind -- take more risk to catch up
            tiles = AGGRESSIVE_TILES
            print(
                f"Round {msg['round']}: behind {my_score}-{op_score}, "
                f"going aggressive with {tiles} tiles"
            )
        elif my_score > op_score:
            # Ahead -- play safe to protect lead
            tiles = SAFE_TILES
            print(
                f"Round {msg['round']}: leading {my_score}-{op_score}, "
                f"playing safe with {tiles} tiles"
            )
        else:
            # Tied -- moderate risk
            tiles = MODERATE_TILES
            print(
                f"Round {msg['round']}: tied {my_score}-{op_score}, "
                f"moderate risk with {tiles} tiles"
            )

        await client.make_move(msg["match_id"], {"tiles": tiles})

    def on_round_result(msg):
        print(f"Round {msg['round']} result: {msg['result']}")
        print(f"Score: {msg['score'][0]} - {msg['score'][1]}")
        current_score[0] = msg["score"][0]
        current_score[1] = msg["score"][1]

    async def on_game_over(msg):
        won = msg["winner"] is not None
        if won:
            print(f"WON! Payout: {msg['payout_lamports'] / 1e9:.4f} SOL")
        else:
            print("Lost!")
        print(f"Final: {msg['final_score'][0]} - {msg['final_score'][1]}")
        print(f"Server seed: {msg['server_seed']}")

        print("\nQueuing for next match...")
        await client.join_queue("mines", WAGER_SOL)

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

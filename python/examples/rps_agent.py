"""
Example: Rock-Paper-Scissors Agent for BOTPIT

Game Mechanics:
    - Best-of series: each round, both players pick rock, paper, or scissors.
    - Rock beats scissors, scissors beats paper, paper beats rock.
    - No game_state is provided (simultaneous moves, no info to exploit).

Strategy:
    Frequency-based counter-picking. Tracks opponent's previous choices from
    round results and counter-picks their most frequent move. Falls back to
    uniform random on round 1. Adds 30% randomness to avoid being predictable.

Usage:
    BOTPIT_API_KEY=bp_sk_... python examples/rps_agent.py
"""

import asyncio
import os
import random
from collections import Counter

from botpit import BotpitClient

API_KEY = os.environ.get("BOTPIT_API_KEY")
if not API_KEY:
    print("Set BOTPIT_API_KEY environment variable")
    exit(1)

WAGER_SOL = 0.01

# What beats what: key is beaten by value
COUNTER = {
    "rock": "paper",
    "paper": "scissors",
    "scissors": "rock",
}


async def main():
    client = BotpitClient(
        api_key=API_KEY,
        url=os.environ.get("BOTPIT_URL", "wss://api.botpit.tech/api/v1/ws"),
    )

    # Track opponent moves across rounds within a match
    opponent_history: list[str] = []

    async def on_connected(msg):
        print(f"Connected as {msg['agent_name']} ({msg['agent_id']})")
        print(f"Joining rps queue with {WAGER_SOL} SOL wager...")
        await client.join_queue("rps", WAGER_SOL)

    async def on_match_found(msg):
        print(f"Match found! vs {msg['opponent_name']}")
        print(f"Match ID: {msg['match_id']}")
        # Reset history for new match
        opponent_history.clear()

    async def on_your_turn(msg):
        choices = ["rock", "paper", "scissors"]

        if not opponent_history:
            # Round 1: no data, pick randomly
            choice = random.choice(choices)
        else:
            # Count opponent's moves and counter the most frequent
            counts = Counter(opponent_history)
            most_common_move = counts.most_common(1)[0][0]

            # 70% counter-pick, 30% random to stay unpredictable
            if random.random() < 0.7:
                choice = COUNTER[most_common_move]
            else:
                choice = random.choice(choices)

        print(f"Round {msg['round']}: choosing {choice}")
        await client.make_move(msg["match_id"], {"choice": choice})

    def on_round_result(msg):
        print(f"Round {msg['round']} result: {msg['result']}")
        print(f"Score: {msg['score'][0]} - {msg['score'][1]}")

        # Track opponent's choice for future counter-play
        result = msg.get("result", {})
        if isinstance(result, dict) and "opponent_choice" in result:
            opponent_history.append(result["opponent_choice"])

    async def on_game_over(msg):
        won = msg["winner"] is not None
        if won:
            print(f"WON! Payout: {msg['payout_lamports'] / 1e9:.4f} SOL")
        else:
            print("Lost!")
        print(f"Final: {msg['final_score'][0]} - {msg['final_score'][1]}")
        print(f"Server seed: {msg['server_seed']}")

        print("\nQueuing for next match...")
        await client.join_queue("rps", WAGER_SOL)

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

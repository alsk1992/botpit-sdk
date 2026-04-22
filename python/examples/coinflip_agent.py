"""
Example: Simple Coinflip Agent for BOTPIT

This agent joins the coinflip queue and picks heads/tails randomly.

Usage:
    BOTPIT_API_KEY=bp_sk_... python examples/coinflip_agent.py
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


async def main():
    client = BotpitClient(
        api_key=API_KEY,
        url=os.environ.get("BOTPIT_URL", "wss://api.botpit.tech/api/v1/ws"),
    )

    async def on_connected(msg):
        print(f"Connected as {msg['agent_name']} ({msg['agent_id']})")
        print(f"Joining coinflip queue with {WAGER_SOL} SOL wager...")
        await client.join_queue("coinflip", WAGER_SOL)

    async def on_match_found(msg):
        print(f"Match found! vs {msg['opponent_name']}")
        print(f"Match ID: {msg['match_id']}")

    async def on_your_turn(msg):
        choice = random.choice(["heads", "tails"])
        print(f"Round {msg['round']}: choosing {choice}")
        await client.make_move(msg["match_id"], {"choice": choice})

    def on_round_result(msg):
        print(f"Round {msg['round']} result: {msg['result']}")
        print(f"Score: {msg['score'][0]} - {msg['score'][1]}")

    async def on_game_over(msg):
        won = msg["winner"] is not None
        if won:
            print(f"WON! Payout: {msg['payout_lamports'] / 1e9:.4f} SOL")
        else:
            print("Lost!")
        print(f"Final: {msg['final_score'][0]} - {msg['final_score'][1]}")
        print(f"Server seed: {msg['server_seed']}")

        # Queue for next match
        print("\nQueuing for next match...")
        await client.join_queue("coinflip", WAGER_SOL)

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

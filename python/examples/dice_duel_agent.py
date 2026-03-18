"""
Example: Dice Duel Agent for BOTPIT

Game Mechanics:
    - Pure luck game: both players roll dice simultaneously.
    - Move is simply {"action": "roll"} -- no strategy decisions.
    - The server generates roll results from the provably-fair seed.
    - Higher roll wins the round. Best-of series determines winner.

Strategy:
    There is no strategic element -- this is a pure chance game.
    The agent simply rolls every turn. This example demonstrates
    how to handle a game type with no decision-making and track
    session statistics.

Usage:
    BOTPIT_API_KEY=bp_sk_... python examples/dice_duel_agent.py
"""

import asyncio
import os

from botpit import BotpitClient

API_KEY = os.environ.get("BOTPIT_API_KEY")
if not API_KEY:
    print("Set BOTPIT_API_KEY environment variable")
    exit(1)

WAGER_SOL = 0.01


async def main():
    client = BotpitClient(
        api_key=API_KEY,
        url=os.environ.get("BOTPIT_URL", "wss://api.botpitgame.com/api/v1/ws"),
    )

    stats = {"wins": 0, "losses": 0}

    async def on_connected(msg):
        print(f"Connected as {msg['agent_name']} ({msg['agent_id']})")
        print(f"Joining dice_duel queue with {WAGER_SOL} SOL wager...")
        await client.join_queue("dice_duel", WAGER_SOL)

    async def on_match_found(msg):
        print(f"\nMatch found! vs {msg['opponent_name']}")
        print(f"Match ID: {msg['match_id']}")

    async def on_your_turn(msg):
        # No decision to make -- just roll the dice
        print(f"Round {msg['round']}: rolling dice...")
        await client.make_move(msg["match_id"], {"action": "roll"})

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
        print(f"Session record: {stats['wins']}W - {stats['losses']}L")

        print("\nQueuing for next match...")
        await client.join_queue("dice_duel", WAGER_SOL)

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

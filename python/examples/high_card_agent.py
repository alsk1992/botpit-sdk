"""
Example: High Card Duel Agent for BOTPIT

Game Mechanics:
    - Pure luck game: both players draw a card from the deck.
    - Move is simply {"action": "draw"} -- no strategy decisions.
    - Higher card wins the round. Best-of series determines winner.
    - Similar to dice_duel but with cards (1-13) instead of dice.

Strategy:
    No strategic element -- just draw every turn. This example shows
    proper handling of a draw-based game and tracks PnL over the session.

Usage:
    BOTPIT_API_KEY=bp_sk_... python examples/high_card_agent.py
"""

import asyncio
import os

from botpit import BotpitClient

API_KEY = os.environ.get("BOTPIT_API_KEY")
if not API_KEY:
    print("Set BOTPIT_API_KEY environment variable")
    exit(1)

WAGER_SOL = 0.01

CARD_NAMES = {
    1: "Ace", 11: "Jack", 12: "Queen", 13: "King",
}


def card_name(value: int) -> str:
    return CARD_NAMES.get(value, str(value))


async def main():
    client = BotpitClient(
        api_key=API_KEY,
        url=os.environ.get("BOTPIT_URL", "wss://api.botpit.tech/api/v1/ws"),
    )

    session = {"games": 0, "pnl_lamports": 0}

    async def on_connected(msg):
        print(f"Connected as {msg['agent_name']} ({msg['agent_id']})")
        print(f"Joining high_card_duel queue with {WAGER_SOL} SOL wager...")
        await client.join_queue("high_card_duel", WAGER_SOL)

    async def on_match_found(msg):
        print(f"\nMatch found! vs {msg['opponent_name']}")
        print(f"Match ID: {msg['match_id']}")

    async def on_your_turn(msg):
        # No decision needed -- just draw a card
        print(f"Round {msg['round']}: drawing a card...")
        await client.make_move(msg["match_id"], {"action": "draw"})

    def on_round_result(msg):
        result = msg.get("result", {})
        if isinstance(result, dict) and "your_card" in result and "opponent_card" in result:
            print(
                f"Round {msg['round']}: drew {card_name(result['your_card'])} "
                f"vs {card_name(result['opponent_card'])}"
            )
        else:
            print(f"Round {msg['round']} result: {result}")
        print(f"Score: {msg['score'][0]} - {msg['score'][1]}")

    async def on_game_over(msg):
        session["games"] += 1
        won = msg["winner"] is not None
        if won:
            session["pnl_lamports"] += msg["payout_lamports"]
            print(f"WON! Payout: {msg['payout_lamports'] / 1e9:.4f} SOL")
        else:
            session["pnl_lamports"] -= msg.get("payout_lamports", 0)
            print("Lost!")
        print(f"Final: {msg['final_score'][0]} - {msg['final_score'][1]}")
        print(f"Server seed: {msg['server_seed']}")
        print(f"Session: {session['games']} games, PnL: {session['pnl_lamports'] / 1e9:.4f} SOL")

        print("\nQueuing for next match...")
        await client.join_queue("high_card_duel", WAGER_SOL)

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

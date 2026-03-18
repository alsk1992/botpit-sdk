"""
Example: Hi-Lo Agent for BOTPIT

Game Mechanics:
    - The dealer shows a card (value 1-13, where 1=Ace, 11=J, 12=Q, 13=K).
    - You guess whether the next card will be "higher" or "lower".
    - game_state contains `dealer_card` with the visible card value.
    - Multiple rounds; player with more correct guesses wins.

Strategy:
    Use the midpoint of the card range (7). If the dealer card is below 7,
    the next card is statistically more likely to be higher. If above 7,
    more likely lower. At exactly 7, pick randomly.

Usage:
    BOTPIT_API_KEY=bp_sk_... python examples/hilo_agent.py
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

CARD_NAMES = {
    1: "Ace", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7",
    8: "8", 9: "9", 10: "10", 11: "Jack", 12: "Queen", 13: "King",
}


async def main():
    client = BotpitClient(
        api_key=API_KEY,
        url=os.environ.get("BOTPIT_URL", "wss://api.botpitgame.com/api/v1/ws"),
    )

    async def on_connected(msg):
        print(f"Connected as {msg['agent_name']} ({msg['agent_id']})")
        print(f"Joining hi_lo queue with {WAGER_SOL} SOL wager...")
        await client.join_queue("hi_lo", WAGER_SOL)

    async def on_match_found(msg):
        print(f"Match found! vs {msg['opponent_name']}")
        print(f"Match ID: {msg['match_id']}")

    async def on_your_turn(msg):
        dealer_card = msg["game_state"]["dealer_card"]
        card_name = CARD_NAMES.get(dealer_card, str(dealer_card))

        # Card range is 1-13. Midpoint is 7.
        # Below 7: more cards above -> guess higher
        # Above 7: more cards below -> guess lower
        # At 7: true coin flip
        if dealer_card < 7:
            guess = "higher"
        elif dealer_card > 7:
            guess = "lower"
        else:
            guess = random.choice(["higher", "lower"])

        print(f"Round {msg['round']}: dealer shows {card_name} ({dealer_card}), guessing {guess}")
        await client.make_move(msg["match_id"], {"guess": guess})

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

        print("\nQueuing for next match...")
        await client.join_queue("hi_lo", WAGER_SOL)

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

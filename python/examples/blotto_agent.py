"""
Example: Blotto Agent for BOTPIT

Game Mechanics:
    - Colonel Blotto game: multi-round resource allocation battle.
    - Each round, you bid troops from your remaining budget: {"bid": N}.
    - game_state contains:
        - `your_budget`: your remaining troops to allocate
        - `terrain_bonus_a`: terrain multiplier bonus for player A this round
    - The player who bids more (adjusted for terrain) wins the round.
    - Budget management is key: spending everything early leaves you defenseless.
    - The player who wins the most rounds wins the match.

Strategy:
    Adaptive proportional allocation with terrain awareness:
    1. Divide budget evenly across estimated remaining rounds.
    2. If terrain favors us (bonus > 1.0), bid less (our troops are amplified).
    3. If terrain is against us (bonus < 1.0), bid more to compensate,
       or concede if budget is too low to contest effectively.
    4. Adjust aggression based on score differential.

Usage:
    BOTPIT_API_KEY=bp_sk_... python examples/blotto_agent.py
"""

import asyncio
import os

from botpit import BotpitClient

API_KEY = os.environ.get("BOTPIT_API_KEY")
if not API_KEY:
    print("Set BOTPIT_API_KEY environment variable")
    exit(1)

WAGER_SOL = 0.01
ESTIMATED_TOTAL_ROUNDS = 5  # Typical game length


async def main():
    client = BotpitClient(
        api_key=API_KEY,
        url=os.environ.get("BOTPIT_URL", "wss://api.botpit.tech/api/v1/ws"),
    )

    current_score = [0, 0]

    async def on_connected(msg):
        print(f"Connected as {msg['agent_name']} ({msg['agent_id']})")
        print("Strategy: adaptive proportional allocation with terrain awareness")
        print(f"Joining blotto queue with {WAGER_SOL} SOL wager...")
        await client.join_queue("blotto", WAGER_SOL)

    async def on_match_found(msg):
        print(f"\nMatch found! vs {msg['opponent_name']}")
        print(f"Match ID: {msg['match_id']}")
        current_score[0] = 0
        current_score[1] = 0

    async def on_your_turn(msg):
        budget = msg["game_state"]["your_budget"]
        terrain_bonus = msg["game_state"].get("terrain_bonus_a", 1.0)
        round_num = msg["round"]
        my_score, op_score = current_score

        # Estimate remaining rounds
        rounds_played = round_num - 1
        estimated_remaining = max(1, ESTIMATED_TOTAL_ROUNDS - rounds_played)

        # Base allocation: even split across remaining rounds
        base_bid = budget // estimated_remaining

        # Terrain adjustment
        if terrain_bonus > 1.0:
            # We have advantage -- can win with less
            base_bid = int(base_bid * 0.8)
        elif terrain_bonus < 1.0:
            # Opponent has advantage
            if budget > base_bid * 1.5:
                # Enough to contest -- bid extra
                base_bid = int(base_bid * 1.3)
            else:
                # Low budget + bad terrain = concede (bid minimal)
                base_bid = min(1, budget)

        # Score-based aggression
        score_diff = my_score - op_score
        if score_diff < 0:
            # Behind -- increase bid by 30%
            base_bid = int(base_bid * 1.3)
        elif score_diff > 0:
            # Ahead -- conserve resources
            base_bid = int(base_bid * 0.8)

        # Clamp to valid range
        bid = max(0, min(budget, base_bid))

        print(
            f"Round {round_num}: budget={budget}, terrain={terrain_bonus:.2f}, "
            f"score={my_score}-{op_score}, bidding {bid}"
        )
        await client.make_move(msg["match_id"], {"bid": bid})

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
        await client.join_queue("blotto", WAGER_SOL)

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

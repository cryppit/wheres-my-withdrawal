# Where's My Withdrawal

Paste the L2 transaction that started a withdrawal to Ethereum. It tells you, from public RPCs only:

- whether the withdrawal is done, waiting (and until when), or missing a step;
- which step is missing (prove or finalize) and the exact contract call;
- who may take that step. On OP Mainnet and Base that is **anyone**, and the money still goes only to the withdrawal's
  recipient;
- who proved it, if someone else did. Third parties now prove and finish old withdrawals for others, and some then ask
  the owner for a tip. Nothing is owed: the funds arrive at the recipient either way.

It never asks for keys, never connects a wallet and never signs anything.

Supported now: **OP Mainnet** and **Base**. Arbitrum One is next.

## Use it

Node 22 or later, no dependencies.

```sh
node cli.js 0x<L2 tx hash>                 # finds the chain itself
node cli.js 0x<L2 tx hash> --chain base    # or name it: op, base
node cli.js 0x<L2 tx hash> --json          # every fact behind the answer
npm test                                   # replays recorded real withdrawals, no network
```

## How it decides (October 2026)

Both chains changed their proof systems in 2026, and checks written for the 2024 layout get both wrong.

| | OP Mainnet | Base |
|---|---|---|
| Dispute game | Super root game, type 9 (since Upgrade 20, 24 Sep 2026) | AggregateVerifier, type 621, TEE + ZK proofs (since Azul, 26 May 2026) |
| A game covers a withdrawal when | its L2 timestamp ≥ the withdrawal's block timestamp | its L2 block number ≥ the withdrawal's block |
| Wait after proving | 7 days (portal), and the game must resolve plus a 3.5-day air gap | 1 day (portal), but the game itself takes 5 days with one proof |
| Retired games | created on or before 24 Jul 2025 | created on or before 26 May 2026 19:59:59 UTC |

For each withdrawal it reads, at the latest **finalized** Ethereum block:

1. the `MessagePassed` log in the L2 receipt (the withdrawal hash, recipient, amount; standard-bridge ETH and ERC-20
   transfers are decoded);
2. `finalizedWithdrawals(hash)` on the portal; if finalized, whether the L1 messenger relayed the message or recorded
   it as failed (then anyone can replay it);
3. **every** proof submitter (`numProofSubmitters`, `proofSubmitters`, `provenWithdrawals`), not just the latest, and
   each proof's game: status, resolution, and whether the anchor state registry still treats it as proper, retired,
   blacklisted or valid;
4. the newest dispute game, to tell whether the withdrawal can be proven yet.

The anchor state registry and the dispute game factory are read from the portal each time, because upgrades move them.

Anyone can finalize with anyone's valid proof: `finalizeWithdrawalTransactionExternalProof(tx, proofSubmitter)` has no
caller check in the deployed portals.

## Data sources

Public JSON-RPC endpoints without keys, tried in order: the chains' own RPCs and PublicNode for L2, PublicNode and
MEV Blocker for Ethereum. They are rate limited and offered as is; for heavy use, run your own node.

## Licence

MIT. Maintained by [Cryppit](https://github.com/cryppit).

# Where's My Withdrawal

Paste the L2 transaction that started a withdrawal to Ethereum. It tells you, from public RPCs only:

- whether the withdrawal is done, waiting (and until when), or missing a step;
- which step is missing (prove or finalize on OP Mainnet and Base, claim on Arbitrum One) and the exact contract call;
- who may take that step. On all three chains that is **anyone**, and the money still goes only to the withdrawal's
  recipient;
- who proved or claimed it, if someone else did. Third parties now prove and finish old withdrawals for others, and some
  then ask the owner for a tip. Nothing is owed: the funds arrive at the recipient either way.

It never asks for keys, never connects a wallet and never signs anything.

Supported now: **OP Mainnet**, **Base** and **Arbitrum One** (Nitro withdrawals, since 31 Aug 2022).

## Use it

Node 22 or later, no dependencies.

```sh
node cli.js 0x<L2 tx hash>                 # finds the chain itself
node cli.js 0x<L2 tx hash> --chain base    # or name it: op, base, arb
node cli.js 0x<L2 tx hash> --json          # every fact behind the answer
npm test                                   # replays recorded real withdrawals, no network
```

## How it decides (October 2026)

OP Mainnet and Base changed their proof systems in 2026, and checks written for the 2024 layout get both wrong.
Arbitrum One has run BoLD since February 2025, and its window has stayed at 45,818 L1 blocks.

| | Proof system | A proposal covers a withdrawal when | Wait | Old proofs |
|---|---|---|---|---|
| OP Mainnet | Super root game, type 9 (since Upgrade 20, 24 Sep 2026) | its L2 timestamp ≥ the withdrawal's block timestamp | 7 days after proving (portal), and the game must resolve plus a 3.5-day air gap | games created on or before 24 Jul 2025 are retired |
| Base | AggregateVerifier, type 621, TEE + ZK proofs (since Azul, 26 May 2026) | its L2 block number ≥ the withdrawal's block | 1 day after proving (portal), but the game itself takes 5 days with one proof | games created on or before 26 May 2026 19:59:59 UTC are retired |
| Arbitrum One | BoLD assertions on the rollup contract (no prove step) | the assertion's L2 block has `sendCount` > the withdrawal's `position` | `confirmPeriodBlocks` = 45,818 L1 blocks (about 6.4 days) after the assertion is created; up to about 12 days 17 hours if challenged | none: a confirmed send root stays claimable indefinitely |

For each OP Mainnet or Base withdrawal it reads, at the latest **finalized** Ethereum block:

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

For each Arbitrum One withdrawal it reads, at the latest finalized Ethereum block:

1. the `L2ToL1Tx` log from ArbSys (`0x64`) in the L2 receipt: the `position`, sender, destination, value and data.
   Plain ETH (`withdrawEth`) has empty data. A token withdrawal is labelled ERC-20 only when the L1 gateway router maps
   the token to the destination gateway and that gateway's L2 counterpart sent the message; anything else is shown as
   a message;
2. `Outbox.isSpent(position)` (the Outbox is read from the rollup each time). If it is spent, the withdrawal is done,
   and the tool looks for who sent the claim. Every claim emits `OutBoxTransactionExecuted(to, l2Sender, 0,
   transactionIndex)` with `transactionIndex` = `position`, and a position is spent only once, so the claim is the log
   with this withdrawal's `to`, `l2Sender` and position. It lies between the withdrawal's L1 block plus one confirm
   period and the finalized block. The first round reads the logs at both ends of that range (most claims come when
   the window opens, or recently from third parties) while `isSpent` on historical state at 15 points narrows the
   range 16-fold per round, until it fits one log query of 10,000 blocks. That needs an archive endpoint; when none
   answers, or the log is not where it must be, the verdict says it could not tell and names nobody. The page shows
   the verdict first and fills in the claimer when the search ends ("Finding who claimed it…");
3. `latestConfirmed()` on the rollup, the `AssertionConfirmed` log that carries its L2 block hash, and that block's
   `sendCount` from the L2. If `sendCount > position`, anyone can claim: the tool fetches the Merkle proof from
   NodeInterface (`0xc8`) `constructOutboxProof(sendCount, position)` and checks that its leaf is this withdrawal's hash
   and that `Outbox.roots(root)` is set, then prints `Outbox.executeTransaction(...)` with every argument;
4. otherwise the first `AssertionCreated` log after the withdrawal whose L2 block includes it. The claim opens when that
   assertion's creation block plus its confirm period has passed and it is confirmed (validators normally confirm
   within the hour; on Arbitrum One anyone may). With no such assertion yet, the estimate is one assertion interval
   (about an hour) plus the window.

A claim whose call to the recipient fails reverts and leaves the position unspent, so Arbitrum has no "failed relay"
state. Rival assertions are not told apart: the first one that includes the withdrawal sets the estimate.

## Data sources

Public JSON-RPC endpoints without keys, tried in order: the chains' own RPCs and PublicNode for OP Mainnet and Base;
arb1.arbitrum.io, Blast's public endpoint and Nodies for Arbitrum One; PublicNode and MEV Blocker for Ethereum. The
Arbitrum lookups that reach back more than about a day (an assertion created about 6.4 days ago, the block a claim
happened in) need historical logs and state, which PublicNode's free tier refuses; they go straight to MEV Blocker,
then Tenderly's public gateway. With "Find chain", all three L2s are asked at once and the one that has the
transaction answers. The endpoints are rate limited and offered as is; for heavy use, run your own node.

## Licence

MIT. Maintained by [Cryppit](https://github.com/cryppit).

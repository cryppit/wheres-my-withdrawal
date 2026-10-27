# Where's My Withdrawal

Paste the L2 transaction that started a withdrawal to Ethereum. It tells you, from public RPCs only:

- whether the withdrawal is done, waiting (and until when), or missing a step;
- which step is missing (prove or finalize on the OP Stack chains and Blast, claim on Arbitrum One, Robinhood Chain and
  Linea, finalize on ZKsync Era) and the exact contract call;
- who may take that step. On all thirteen chains that is **anyone**, and the money still goes only to the withdrawal's
  recipient. On ZKsync Era a batch finalizer usually takes it without the owner doing anything;
- who proved or claimed it, if someone else did. Third parties now prove and finish old withdrawals for others, and some
  then ask the owner for a tip. Nothing is owed: the funds arrive at the recipient either way.

It never asks for keys, never connects a wallet and never signs anything.

Supported now: **OP Mainnet** (including withdrawals started before the Bedrock upgrade of 6 June 2023), **Base**,
**Unichain**, **Ink**, **Soneium**, **World Chain**, **Mode**, **Zora**, **Blast** (its own portal, below), **Arbitrum One**
(Nitro withdrawals, since 31 Aug 2022), **Robinhood Chain** (since its mainnet, 1 Jul 2026), **Linea** and **ZKsync Era**
(withdrawals through the ZKsync bridge).

Blast keeps the OP Stack's older portal (1.10.0): withdrawals are proven against an L2OutputOracle output, finalize one
day later, and only one proof per withdrawal counts. ETH withdrawals also pass through Blast's ETH yield manager:
finalize needs the queue's checkpoint hint, which the check reads and puts in the call. USDB comes back as a DAI claim
that only the recipient can collect after finalize, and the check says so.

## Use it

Node 22 or later, no dependencies.

```sh
node cli.js 0x<L2 tx hash>                 # finds the chain itself
node cli.js 0x<L2 tx hash> --chain base    # or name it: op, base, unichain, ink, soneium, worldchain, mode, zora,
                                           # blast, arb, robinhood, linea, zksync
node cli.js 0x<L2 tx hash> --json          # every fact behind the answer
npm test                                   # replays recorded real withdrawals, no network
```

## Build the prove step yourself (OP Stack)

`node cli.js <L2 tx hash> --prove [--chain op|base|unichain|ink|soneium|worldchain|mode|zora|blast] [--from 0x…]` builds the whole `proveWithdrawalTransaction` call
from public data and rehearses it, read-only:

- picks the newest dispute game of the respected type that is proper, not lost and covers the withdrawal (for super-root
  games the portal checks `rootClaimByChainId`, so the proof is the chain's own output root);
- reads that L2 block and `eth_getProof` of `L2ToL1MessagePasser`, checks that the output root matches the game's claim
  and that the withdrawal is stored (pre-Bedrock withdrawals in their migrated form);
- encodes the call and rehearses it with `eth_call` (and estimates its gas). Nothing is signed or sent.

On Blast it proves against the newest L2OutputOracle output instead of a dispute game. It refuses to build a proof for a
withdrawal that is already finalized (the portal would accept it and waste the gas) or, on Blast, already proven.

Anyone can send the printed call (to the OptimismPortal, value 0, with that data) from their own wallet; the funds go
only to the withdrawal's recipient. Whoever proves must also finalize it later (the portal keys proofs by sender), with
`finalizeWithdrawalTransaction`, once the proof is 7 days old and the game has resolved and passed its finality delay.
Public L2 endpoints serve proofs only for recent blocks (mainnet.optimism.io: 10,000), which is why it proves against a
recent game rather than an old resolved one; the proof stays valid after that window.

## How it decides (October 2026)

OP Mainnet and Base changed their proof systems in 2026, and checks written for the 2024 layout get both wrong.
Arbitrum One has run BoLD since February 2025, and its window has stayed at 45,818 L1 blocks. Robinhood Chain (an
Arbitrum chain on Ethereum since 1 Jul 2026) runs the same BoLD contracts and window, but only whitelisted validators
may post and confirm assertions. Linea and ZKsync Era are
ZK rollups: there is no challenge window, only the wait for the L1 to finalize or execute the withdrawal's block.

| | Proof system | A proposal covers a withdrawal when | Wait | Old proofs |
|---|---|---|---|---|
| OP Mainnet | Super root game, type 9 (since Upgrade 20, 24 Sep 2026) | its L2 timestamp ≥ the withdrawal's block timestamp | 7 days after proving (portal), and the game must resolve plus a 3.5-day air gap | games created on or before 24 Jul 2025 are retired |
| Base | AggregateVerifier, type 621, TEE + ZK proofs (since Azul, 26 May 2026) | its L2 block number ≥ the withdrawal's block | 1 day after proving (portal), but the game itself takes 5 days with one proof | games created on or before 26 May 2026 19:59:59 UTC are retired |
| Arbitrum One | BoLD assertions on the rollup contract (no prove step) | the assertion's L2 block has `sendCount` > the withdrawal's `position` | `confirmPeriodBlocks` = 45,818 L1 blocks (about 6.4 days) after the assertion is created; up to about 12 days 17 hours if challenged | none: a confirmed send root stays claimable indefinitely |
| Robinhood Chain | BoLD assertions, as on Arbitrum One, from a validator whitelist (`validatorWhitelistDisabled()` is false) | as on Arbitrum One | 45,818 L1 blocks (about 6.4 days) after the assertion; assertions come about every 30 minutes (measured 26 Oct 2026) | none |
| Linea | ZK validity proofs; the L1 rollup finalizes L2 blocks (no prove step for the user) | the rollup's `currentL2BlockNumber()` ≥ the withdrawal's L2 block | until that block is finalized: 1.8 to 3.3 hours in reads on 24 Oct 2026 | messages from before L2 block 2,242,568 (Feb 2024) use the legacy `claimMessage`; nothing expires on chain, but the bridge app stops listing a withdrawal after 90 days |
| ZKsync Era | ZK validity proofs; batches are committed, proven and executed on L1 | the withdrawal's batch is ≤ `getTotalBatchesExecuted()` on the Era diamond | until the batch is executed: 3 hours at least (`executionDelay`), about 24 hours after commit in October 2026 | withdrawals finalized before the shared bridge (2024) are recorded on the Era diamond or the legacy ERC-20 bridge |

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

**Withdrawals started before Bedrock (OP Mainnet, before 6 June 2023).** These have no `MessagePassed` log, only the old
messenger's `SentMessage`, so bridge apps don't list them. The upgrade carried every one over into the
L2ToL1MessagePasser as a new-style withdrawal. The tool rebuilds it the way `op-chain-ops/crossdomain/migrate.go`
(v1.1.4, `MigrateWithdrawal`) did:
- the old nonce, kept as version 0;
- sender = the L2 messenger, target = the L1 messenger;
- value = the amount, only for an ETH withdrawal through the L2 standard bridge;
- data = `relayMessage(nonce, old sender, old target, value, 0, old message)`;
- gas limit = 16 per data byte + 1,300,873.

It then checks that `sentMessages(hash)` is true on OP Mainnet. If the L1 messenger has the old message hash in
`successfulMessages`, it was relayed (before or after the upgrade) and is done. Otherwise it is read like any other
withdrawal (prove, wait, finalize). Example: a 0.01798 ETH withdrawal from 11 Dec 2022 (`fixtures/op-2022-pre-bedrock.json`).

Anyone can finalize with anyone's valid proof: `finalizeWithdrawalTransactionExternalProof(tx, proofSubmitter)` has no
caller check in the deployed portals.

For each Arbitrum One or Robinhood Chain withdrawal it reads, at the latest finalized Ethereum block (the two share
this reader; each has its own rollup, gateway router and assertion interval):

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
   within the hour; on Arbitrum One anyone may, on Robinhood Chain only its whitelisted validators may, unless they have
   been idle for weeks). With no such assertion yet, the estimate is one assertion interval (about an hour on Arbitrum
   One, 30 minutes on Robinhood Chain) plus the window.

A claim whose call to the recipient fails reverts and leaves the position unspent, so Arbitrum has no "failed relay"
state. Rival assertions are not told apart: the first one that includes the withdrawal sets the estimate.

For each Linea withdrawal it reads, at the latest finalized Ethereum block:

1. the `MessageSent` log from the L2 message service (`0x508c…44ec`) in the L2 receipt: the message number, sender,
   destination, fee, value and calldata. Plain ETH has empty calldata. A token withdrawal is labelled ERC-20 only when
   the L2 TokenBridge sent it to the L1 TokenBridge with `completeBridging(...)`; the token is named on L1 (an L1 token
   comes home as itself, a Linea-native token as its L1 bridged copy);
2. `isMessageClaimed(messageNumber)` on the L1 rollup, or for a message from before L2 block 2,242,568,
   `inboxL2L1MessageStatus(messageHash)` (1 means claimable; claiming deletes it). If claimed, the `MessageClaimed`
   log for this message hash on L1 and its transaction's sender say who claimed it;
3. `currentL2BlockNumber()`. If it has not reached the withdrawal's block, the estimate is the withdrawal's time plus
   how far finalization trails the L2 right now (the age of the last finalized L2 block);
4. otherwise the claim is open to anyone. Nothing claims Linea withdrawals automatically. The tool rebuilds the Merkle
   proof the way the Linea SDK does: the `L2MessagingBlockAnchored` log for this L2 block leads to the finalization
   transaction, whose `L2MerkleRootAdded` and anchored-block logs give the tree depth and the L2 block range; the message
   hashes sent in that range fill trees of 2^depth leaves. The rebuilt root must be one that finalization added, and
   `l2MerkleRootsDepths(root)` on L1 must match. It then prints `claimMessageWithProof(...)` (or the legacy
   `claimMessage(...)`) with every argument.

It also reads the L1 claim limit (10,000 ETH a day, shared by all claims) and the pause flags, and says when a claim
would revert. A fee paid on L2 goes to whoever sends the claim (for plain ETH to a wallet, only the claim's gas cost).

For each ZKsync Era withdrawal it reads, at the latest finalized Ethereum block:

1. the `L1MessageSent` log from the L1 messenger (`0x8008`) in the L2 receipt, from one of the three bridge senders the
   L1Nullifier accepts: L2BaseToken (`0x800a`, ETH), the L2 asset router (`0x10003`) or the legacy L2 bridge. The
   message format decides the asset; an asset-router token is named through the native token vault on L1. Messages
   from other contracts are not bridge withdrawals and are refused as unsupported;
2. `getTotalBatchesExecuted()` on the Era diamond. If the withdrawal's batch is not executed yet, the estimate is its
   commit time plus how long the latest executed batch took from commit to execution (`zks_getL1BatchDetails`);
3. once executed, `zks_getL2ToL1LogProof` gives the message's index in the batch and the proof, and
   `isWithdrawalFinalized(324, batch, index)` on the L1Nullifier (`0xd7f9…b2cb`), plus the Era diamond's
   `isEthWithdrawalFinalized` and the legacy bridge's `isWithdrawalFinalized` for withdrawals finished before the shared
   bridge, say whether it is done. If it is, the tool finds the first L1 block where the flag turned true (a four-way
   search on historical state, which needs an archive endpoint) and the one transaction in that block whose bridge logs
   name this recipient and amount: its sender, and whether it went through the WithdrawalFinalizer contract
   (`0xf8a1…315e`) that finishes most ZKsync withdrawals in batches. The page shows the verdict first and fills in
   the sender when the search ends ("Finding who finalized it…");
4. otherwise anyone can finalize: the tool dry-runs `L1Nullifier.finalizeDeposit(...)` with that proof as an `eth_call`
   at the finalized block (nothing is sent) and prints the call with every argument.

Era settled its batches through Gateway (chain 9075) from mid-2025 until early 2026: batch 505,000 (25 Dec 2025) was
executed there, batch 506,000 (1 Feb 2026) on Ethereum, where it still settles. The proof the RPC returns covers either
path (34 hashes instead of 16 for a Gateway batch), and the dry run checks it on L1.

## Data sources

Public JSON-RPC endpoints without keys, tried in order: the chains' own RPCs and PublicNode for OP Mainnet and Base;
arb1.arbitrum.io, Blast's public endpoint and Nodies for Arbitrum One; rpc.mainnet.chain.robinhood.com for Robinhood
Chain (the only keyless one); rpc.linea.build and PublicNode for Linea;
mainnet.era.zksync.io for ZKsync Era (the `zks_` methods have no other keyless endpoint); PublicNode and MEV Blocker for
Ethereum. All of them answer browsers (CORS). The lookups that reach back days or years (an Arbitrum assertion created
about 6.4 days ago, the block a claim or finalization happened in, a Linea finalization from 2024) need historical logs
and state, which PublicNode's free tier refuses. Arbitrum and ZKsync send those straight to MEV Blocker, then Tenderly's
public gateway; Linea reaches MEV Blocker after PublicNode refuses. With "Find chain", every L2 is asked at once and
the one that has the transaction answers. The endpoints are rate limited and offered as is; for heavy use, run your own
node.

## Licence

MIT. Maintained by [Cryppit](https://github.com/cryppit).

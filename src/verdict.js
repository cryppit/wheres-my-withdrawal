// From the facts read on chain to one answer: the state, when the next step opens, who may take it, and the exact call.
// Pure: no clock, no network. Every condition is judged at the finalized L1 block the facts were read at (facts.l1).
import { sameAddress } from "./abi.js";

const CHALLENGER_WINS = 1;
const DEFENDER_WINS = 2;

/** Why a proof no longer counts, or null if it still does (OptimismPortal2.checkWithdrawal and AnchorStateRegistry rules). */
function deadReason(p) {
  const g = p.game;
  if (g.retired) return "its dispute game was retired by an upgrade";
  if (g.blacklisted) return "its dispute game was blacklisted";
  if (g.status === CHALLENGER_WINS) return "its dispute game was lost by the proposer";
  if (!g.proper) return "its dispute game is no longer valid";
  if (p.provenAt <= g.createdAt) return "it was sent in the same block the game was created";
  return null;
}

/** When the proof's game becomes valid for withdrawals (0 if it already is). */
function gameReadyAt(g, config) {
  if (g.claimValid) return 0;
  if (g.resolvedAt > 0 && g.status === DEFENDER_WINS) return g.resolvedAt + config.finalityDelaySec;
  if (g.expectedResolution) return g.expectedResolution + config.finalityDelaySec; // Base AggregateVerifier
  return g.createdAt + (config.maxClockSec ?? 0) + config.finalityDelaySec; // OP fault game, unchallenged
}

export function verdict(f) {
  if (f.stack === "arbitrum") return arbitrumVerdict(f);
  const t = f.l1.timestamp;
  const notes = [];
  if (f.feeVault) notes.push("This is a fee vault withdrawal: protocol revenue moving to L1, not a user's funds.");
  const tx = `(${f.withdrawal.hash})`;

  if (f.finalized) {
    if (f.relay === "failed") {
      return {
        state: "RELAY_FAILED", eta: null, who: "anyone", notes,
        action: `L1CrossDomainMessenger.relayMessage with the original message ${tx}`,
        summary: "Finalized on L1, but the messenger's call to the recipient failed. The funds sit in the L1 messenger and anyone can replay the message.",
      };
    }
    return { state: "FINALIZED", eta: null, who: null, action: null, notes, summary: "Finalized on L1. Nothing is left to do." };
  }

  const live = [];
  for (const p of f.proofs) {
    const why = deadReason(p);
    if (why) notes.push(`A proof by ${p.submitter} no longer counts: ${why}.`);
    else live.push({ ...p, readyAt: Math.max(p.provenAt + f.config.maturitySec + 1, gameReadyAt(p.game, f.config)) });
  }

  const ready = live.find((p) => p.game.claimValid && t - p.provenAt > f.config.maturitySec);
  if (ready) {
    return {
      state: "READY_TO_FINALIZE", eta: null, who: "anyone", notes, proof: { submitter: ready.submitter, provenAt: ready.provenAt },
      action: `OptimismPortal.finalizeWithdrawalTransactionExternalProof(withdrawal ${tx}, ${ready.submitter})`,
      summary: "Ready to finalize. Anyone can send the finalize transaction; the funds go to the withdrawal's recipient, never to the sender of the transaction.",
    };
  }

  if (live.length) {
    const next = live.reduce((a, b) => (b.readyAt < a.readyAt ? b : a));
    return {
      state: "WAITING_TO_FINALIZE", eta: next.readyAt, who: null, notes, proof: { submitter: next.submitter, provenAt: next.provenAt },
      action: null,
      summary: "Proven. Waiting for the proof window and the dispute game to finish before anyone can finalize.",
    };
  }

  if (!f.coverage.covered) {
    return {
      state: "WAITING_FOR_GAME", eta: t + f.config.cadenceSec, who: null, notes, action: null,
      summary: "Waiting for the next state proposal on L1 to include this withdrawal. Then anyone can prove it.",
    };
  }

  return {
    state: "READY_TO_PROVE", eta: null, who: "anyone", notes,
    action: `OptimismPortal.proveWithdrawalTransaction(withdrawal ${tx}, game index, output root proof, storage proof)`,
    summary: f.proofs.length
      ? "Must be proven again: no earlier proof still counts. Anyone can prove it; the funds still go only to the recipient."
      : "Ready to prove. Anyone can prove it; the funds go only to the withdrawal's recipient.",
  };
}

/**
 * Arbitrum One. A withdrawal can be claimed once a confirmed assertion's L2 block has sendCount > position, and it is
 * done once the Outbox marks the position spent. A claim whose call to the recipient fails reverts and leaves the
 * position unspent, so there is no "relay failed" state here.
 */
function arbitrumVerdict(f) {
  const t = f.l1.timestamp;
  const { config: c, withdrawal: w } = f;
  const notes = [];
  const windowText = `${((c.confirmPeriodBlocks * c.l1BlockSec) / 86400).toFixed(1)}-day`;

  if (f.spent) {
    const claim = f.claim;
    if (claim && !sameAddress(claim.by, f.asset.to) && !sameAddress(claim.by, f.asset.from)) {
      notes.push("Someone other than the sender or the recipient sent the claim. The Outbox paid the recipient regardless; nothing is owed to whoever sent it.");
    }
    // "pending" means the page is still looking (check() with deferExtras); it fills in the claimer when done.
    if (!claim && f.claimLookup && f.claimLookup !== "pending") notes.push("Could not find who sent the claim: that needs historical state the free RPCs did not serve.");
    return {
      state: "CLAIMED", eta: null, who: null, action: null, notes, claim,
      summary: "Claimed on L1. The funds went to the recipient; nothing is left to do.",
    };
  }

  if (f.confirmed.covered) {
    const n = f.proof ? `${f.proof.hashes.length}-hash proof` : "proof";
    if (f.proof && !(f.proof.leafMatches && f.proof.rootConfirmed)) {
      notes.push("The proof the L2 RPC returned did not check out against this withdrawal and the Outbox's confirmed roots. Build it again before sending the claim.");
    }
    return {
      state: "READY_TO_CLAIM", eta: null, who: "anyone", notes,
      action: `Outbox.executeTransaction(${n} from NodeInterface.constructOutboxProof(${f.proof?.size ?? f.confirmed.sendCount}, ${w.position}), ${w.position}, ${w.sender}, ${w.target}, ${w.arbBlockNum}, ${w.ethBlockNum}, ${w.timestamp}, ${w.value}, ${w.data === "0x" ? "0x" : "data"})`,
      summary: "Confirmed and ready to claim. Anyone can send the claim; the funds go only to the withdrawal's recipient.",
    };
  }

  if (!f.covering) {
    return {
      state: "WAITING_FOR_CONFIRMATION", eta: t + c.cadenceSec + c.confirmPeriodBlocks * c.l1BlockSec, who: null, notes, action: null,
      summary: `Waiting for the next assertion on L1 to include this withdrawal, then for its ${windowText} challenge window. Then anyone can claim it.`,
    };
  }

  const left = f.covering.deadlineBlock - f.l1.block;
  if (left <= 0) {
    if (c.anyoneCanConfirm) notes.push("On Arbitrum One anyone may confirm the assertion (RollupUserLogic.confirmAssertion); validators normally do it within the hour.");
    return {
      state: "WAITING_FOR_CONFIRMATION", eta: t, who: null, notes, action: null,
      summary: "The challenge window is over. The assertion that includes this withdrawal only waits to be confirmed; then anyone can claim it.",
    };
  }
  return {
    state: "WAITING_FOR_CONFIRMATION", eta: t + left * c.l1BlockSec, who: null, notes, action: null,
    summary: `Included in an assertion on L1 (created at block ${f.covering.createdAtBlock}). Waiting for its ${windowText} challenge window to end; then anyone can claim it.`,
  };
}

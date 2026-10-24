// From the facts read on chain to one answer: the state, when the next step opens, who may take it, and the exact call.
// Pure: no clock, no network. Every condition is judged at the finalized L1 block the facts were read at (facts.l1).

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

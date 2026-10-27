// From the facts read on chain to one answer: the state, when the next step opens, who may take it, and the exact call.
// Pure: no clock, no network. Every condition is judged at the finalized L1 block the facts were read at (facts.l1).
import { sameAddress } from "./abi.js";
import { ZKSYNC } from "./chains.js";

const CHALLENGER_WINS = 1;
const DEFENDER_WINS = 2;

/** Why a proof no longer counts, or null if it still does (OptimismPortal2.checkWithdrawal and AnchorStateRegistry rules). */
function deadReason(p) {
  const g = p.game;
  if (g.retired) return "a network upgrade cancelled the state report it was checked against";
  if (g.blacklisted) return "the state report it was checked against was thrown out";
  if (g.status === CHALLENGER_WINS) return "the state report it was checked against was proven wrong";
  if (!g.proper) return "the state report it was checked against no longer counts";
  if (p.provenAt <= g.createdAt) return "it was sent too early, in the same moment as the state report";
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
  if (f.stack === "linea") return lineaVerdict(f);
  if (f.stack === "zksync") return zksyncVerdict(f);
  if (f.stack === "blast") return blastVerdict(f);
  const t = f.l1.timestamp;
  const notes = [];
  if (f.feeVault) notes.push("This is a fee withdrawal: the network moving its own earnings to Ethereum, not a person's money.");
  if (f.legacy) notes.push("This withdrawal started before OP Mainnet's big upgrade of 6 June 2023, which is why bridge apps don't show it. It still finishes the normal way: prove, wait 7 days, finalize.");
  const tx = `(${f.withdrawal.hash})`;

  if (f.finalized) {
    if (f.relay === "failed") {
      return {
        state: "RELAY_FAILED", eta: null, who: "anyone", notes,
        action: `L1CrossDomainMessenger.relayMessage with the original message ${tx}`,
        summary: "Finalized on Ethereum, but the final payment to the recipient failed. The money is held safely on Ethereum and anyone can send the payment again.",
      };
    }
    return { state: "FINALIZED", eta: null, who: null, action: null, notes, summary: "Finalized on Ethereum. Nothing is left to do." };
  }

  const live = [];
  for (const p of f.proofs) {
    const why = deadReason(p);
    if (why) notes.push(`An earlier prove step (sent by ${p.submitter}) no longer counts: ${why}.`);
    else live.push({ ...p, readyAt: Math.max(p.provenAt + f.config.maturitySec + 1, gameReadyAt(p.game, f.config)) });
  }

  const ready = live.find((p) => p.game.claimValid && t - p.provenAt > f.config.maturitySec);
  if (ready) {
    return {
      state: "READY_TO_FINALIZE", eta: null, who: "anyone", notes, proof: { submitter: ready.submitter, provenAt: ready.provenAt },
      action: `OptimismPortal.finalizeWithdrawalTransactionExternalProof(withdrawal ${tx}, ${ready.submitter})`,
      summary: "Ready to finalize. Anyone can send the finalize transaction; the money goes to the withdrawal's recipient, never to whoever sends it.",
    };
  }

  if (live.length) {
    const next = live.reduce((a, b) => (b.readyAt < a.readyAt ? b : a));
    return {
      state: "WAITING_TO_FINALIZE", eta: next.readyAt, who: null, notes, proof: { submitter: next.submitter, provenAt: next.provenAt },
      action: null,
      summary: "Proven. Waiting out the safety period before anyone can finalize.",
    };
  }

  if (!f.coverage.covered) {
    return {
      state: "WAITING_FOR_GAME", eta: t + f.config.cadenceSec, who: null, notes, action: null,
      summary: "Waiting for the network's next state report on Ethereum to include this withdrawal. Then anyone can prove it.",
    };
  }

  return {
    state: "READY_TO_PROVE", eta: null, who: "anyone", notes,
    action: `OptimismPortal.proveWithdrawalTransaction(withdrawal ${tx}, game index, output root proof, storage proof)`,
    summary: f.proofs.length
      ? "Must be proven again: the earlier prove step no longer counts. Anyone can prove it; the money still goes only to the recipient."
      : "Ready to prove. Anyone can prove it; the money goes only to the withdrawal's recipient.",
  };
}

/**
 * Blast keeps the pre-fault-proof OptimismPortal (1.10.0) with an L2OutputOracle. A proof counts while its output is
 * still the oracle's output at that index; finalizing needs the finalization period to pass after both the proof and
 * that output. An ETH withdrawal is also a request in the ETH yield manager's queue, proven as `requestId`: it can be
 * finalized once the queue has finalized that request, with the queue's checkpoint hint (OptimismPortal.sol and
 * WithdrawalQueue.sol, verified source). Only one proof per withdrawal, unless its output was replaced.
 */
function blastVerdict(f) {
  const t = f.l1.timestamp;
  const notes = [];
  if (f.feeVault) notes.push("This is a fee withdrawal: the network moving its own earnings to Ethereum, not a person's money.");
  if (f.usdb) notes.push("This is USDB. Finalizing doesn't pay it out yet: Blast turns it into DAI that only the recipient can claim, in Blast's bridge app.");
  const tx = `(${f.withdrawal.hash})`;
  if (f.finalized) {
    if (f.relay === "failed") {
      return {
        state: "RELAY_FAILED", eta: null, who: "anyone", notes,
        action: `L1CrossDomainMessenger.relayMessage with the original message ${tx}`,
        summary: "Finalized on Ethereum, but the final payment to the recipient failed. The money is held safely on Ethereum and anyone can send the payment again.",
      };
    }
    return { state: "FINALIZED", eta: null, who: null, action: null, notes, summary: "Finalized on Ethereum. Nothing is left to do." };
  }

  const p = f.proven;
  if (p && p.currentRoot === p.outputRoot) {
    const period = f.config.maturitySec;
    const opensAt = Math.max(p.provenAt, p.outputTimestamp) + period + 1;
    const needsQueue = f.withdrawal.value > 0n;
    const queued = !needsQueue || (f.queue && p.requestId > 0n && p.requestId <= f.queue.lastFinalizedRequestId);
    if (t >= opensAt && queued) {
      const hint = needsQueue ? f.queue.hint : 0n;
      return {
        state: "READY_TO_FINALIZE", eta: null, who: "anyone", notes, proof: { provenAt: p.provenAt },
        action: `OptimismPortal.finalizeWithdrawalTransaction(hintId ${hint}, withdrawal ${tx})`,
        summary: "Ready to finalize. Anyone can send the finalize transaction; the money goes to the withdrawal's recipient, never to whoever sends it.",
      };
    }
    if (!queued) notes.push("This ETH is waiting in Blast's payout queue, which Blast fills as funds come back from where it earns yield. Finalize opens once Blast releases it; there is nothing to do until then.");
    return {
      state: "WAITING_TO_FINALIZE", eta: queued ? opensAt : null, who: null, notes, proof: { provenAt: p.provenAt },
      action: null,
      summary: "Proven. Waiting out the one-day safety period before anyone can finalize.",
    };
  }
  if (p) notes.push("Its earlier prove step no longer counts: the state report it was checked against was replaced.");

  if (!f.coverage.covered) {
    return {
      state: "WAITING_FOR_GAME", eta: t + f.config.cadenceSec, who: null, notes, action: null,
      summary: "Waiting for Blast's next state report on Ethereum to include this withdrawal. Then anyone can prove it.",
    };
  }
  return {
    state: "READY_TO_PROVE", eta: null, who: "anyone", notes,
    action: `OptimismPortal.proveWithdrawalTransaction(withdrawal ${tx}, output index, output root proof, storage proof)`,
    summary: p
      ? "Must be proven again: its earlier prove step no longer counts. Anyone can prove it; the money still goes only to the recipient."
      : "Ready to prove. Anyone can prove it; the money goes only to the withdrawal's recipient.",
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
      notes.push(thirdPartyNote("claim"));
    }
    // "pending" means the page is still looking (check() with deferExtras); it fills in the claimer when done.
    if (!claim && f.claimLookup && f.claimLookup !== "pending") notes.push("We couldn't find who sent the claim: the free data sources didn't return that part of history. The money still went to the recipient.");
    return {
      state: "CLAIMED", eta: null, who: null, action: null, notes, claim,
      summary: "Claimed on Ethereum. The money went to the recipient; nothing is left to do.",
    };
  }

  if (f.confirmed.covered) {
    const n = f.proof ? `${f.proof.hashes.length}-hash proof` : "proof";
    if (f.proof && !(f.proof.leafMatches && f.proof.rootConfirmed)) {
      notes.push("The claim details we got from the free data sources didn't check out. Check again before anyone sends the claim.");
    }
    return {
      state: "READY_TO_CLAIM", eta: null, who: "anyone", notes,
      action: `Outbox.executeTransaction(${n} from NodeInterface.constructOutboxProof(${f.proof?.size ?? f.confirmed.sendCount}, ${w.position}), ${w.position}, ${w.sender}, ${w.target}, ${w.arbBlockNum}, ${w.ethBlockNum}, ${w.timestamp}, ${w.value}, ${w.data === "0x" ? "0x" : "data"})`,
      summary: "Confirmed and ready to claim. Anyone can send the claim; the money goes only to the withdrawal's recipient.",
    };
  }

  if (!f.covering) {
    return {
      state: "WAITING_FOR_CONFIRMATION", eta: t + c.cadenceSec + c.confirmPeriodBlocks * c.l1BlockSec, who: null, notes, action: null,
      summary: `Waiting for the network's next state report on Ethereum to include this withdrawal, then for its ${windowText} safety wait. Then anyone can claim it.`,
    };
  }

  const left = f.covering.deadlineBlock - f.l1.block;
  if (left <= 0) {
    if (c.anyoneCanConfirm) notes.push("The safety wait is over; the report only needs confirming on Ethereum, which usually happens within the hour.");
    else notes.push(`The safety wait is over; the report only needs confirming. On this chain the network's own operators confirm it, about every ${Math.round(c.cadenceSec / 60)} minutes, so it normally comes soon.`);
    return {
      state: "WAITING_FOR_CONFIRMATION", eta: t, who: null, notes, action: null,
      summary: "The safety wait is over. The state report that includes this withdrawal only needs confirming; then anyone can claim it.",
    };
  }
  return {
    state: "WAITING_FOR_CONFIRMATION", eta: t + left * c.l1BlockSec, who: null, notes, action: null,
    summary: `Included in a state report on Ethereum (block ${f.covering.createdAtBlock}). Waiting for its ${windowText} safety wait to end; then anyone can claim it.`,
  };
}

const isThirdParty = (claim, asset) => !!claim && !sameAddress(claim.by, asset.to) && !sameAddress(claim.by, asset.from);
const thirdPartyNote = (step) =>
  `Someone other than the sender or the recipient sent the ${step}. That's allowed: the money still went to the recipient, and nothing is owed to whoever sent it.`;

const LINEA_APP_DAYS = 90;
const eth = (wei) => {
  const s = wei.toString().padStart(19, "0");
  const frac = s.slice(-18).replace(/0+$/, "");
  return `${s.slice(0, -18)}${frac ? "." + frac.slice(0, 6) : ""} ETH`;
};

/**
 * Linea. A withdrawal is a MessageSent on L2; it can be claimed once the L1 rollup has finalized its L2 block
 * (currentL2BlockNumber >= block), and nothing claims L2-to-L1 messages automatically. Messages from before L2 block
 * 2,242,568 use the legacy claimMessage and need no proof.
 */
function lineaVerdict(f) {
  const t = f.l1.timestamp;
  const { withdrawal: w, config: c } = f;
  const notes = [];

  if (f.claimed) {
    if (isThirdParty(f.claim, f.asset)) notes.push(thirdPartyNote("claim"));
    if (!f.claim && f.claimLookup) notes.push("We couldn't find who sent the claim: the free data sources didn't return it. The money still went to the recipient.");
    return {
      state: "CLAIMED", eta: null, who: null, action: null, notes, claim: f.claim,
      summary: "Claimed on Ethereum. The money went to the recipient; nothing is left to do.",
    };
  }

  if (!f.finalized) {
    const lag = c.finalizedL2Timestamp != null ? t - c.finalizedL2Timestamp : 0;
    return {
      state: "WAITING_FOR_FINALIZATION", eta: Math.max(t, f.l2.timestamp + lag), who: null, notes, action: null,
      summary: "Waiting for Linea to confirm this withdrawal on Ethereum. Then anyone can claim it there; nothing claims it automatically.",
    };
  }

  if (w.fee > 0n) {
    notes.push(`A ${eth(w.fee)} fee was paid on Linea for the claim. Whoever sends the claim gets it (for plain ETH to a wallet, only enough to cover the claim's cost; the rest goes back to the recipient).`);
  }
  if (t - f.l2.timestamp > LINEA_APP_DAYS * 86400) {
    notes.push(`The Linea bridge app stops showing unclaimed withdrawals after ${LINEA_APP_DAYS} days, but the claim still works when sent another way.`);
  }
  const r = c.rateLimit;
  const used = r.periodEnd >= t ? r.usedWei : 0n;
  if (w.value + w.fee > r.limitWei - used) {
    notes.push(`Linea limits how much can be claimed per day (${eth(r.limitWei)}); ${eth(used)} is used so far, so a claim this size can't go through until the limit resets.`);
  }
  if (c.paused) notes.push("Linea has paused claims right now. The claim will work again once they resume.");
  if (!w.legacy && !f.proof) notes.push("We couldn't build the claim details from the free data sources. Try again later, or claim it in the Linea bridge app.");
  if (f.proof && !f.proof.rootConfirmed) {
    notes.push("The claim details we built didn't check out. Check again before anyone sends the claim.");
  }

  const data = w.data === "0x" ? "0x" : "data";
  const action = w.legacy
    ? `LineaRollup.claimMessage(${w.from}, ${w.to}, ${w.fee}, ${w.value}, feeRecipient (any address, or 0x0 for the sender), ${data}, ${w.nonce})`
    : `LineaRollup.claimMessageWithProof({proof: ${f.proof ? `${f.proof.hashes.length} hashes` : "the Merkle proof"}, messageNumber: ${w.nonce}, leafIndex: ${f.proof?.leafIndex ?? "?"}, from: ${w.from}, to: ${w.to}, fee: ${w.fee}, value: ${w.value}, feeRecipient: any address (0x0 pays the sender), merkleRoot: ${f.proof?.root ?? "?"}, data: ${data}})`;
  return {
    state: "READY_TO_CLAIM", eta: null, who: "anyone", notes, action,
    summary: "Confirmed on Ethereum and ready to claim. Anyone can send the claim; the money goes only to the withdrawal's recipient. Nothing claims it automatically.",
  };
}

/**
 * ZKsync Era. A withdrawal is an L2-to-L1 message from a bridge contract in batch N. Once N is executed on L1, anyone
 * can finalize it on the L1Nullifier; a batch finalizer finishes most of them automatically.
 */
function zksyncVerdict(f) {
  const t = f.l1.timestamp;
  const { withdrawal: w, batch: b, latest: l } = f;
  const notes = [];

  if (f.finalized) {
    const claim = f.claim;
    if (claim && sameAddress(claim.via, ZKSYNC.finalizer)) {
      notes.push("ZKsync's automatic service finished it, as it does for most ZKsync withdrawals.");
    } else if (isThirdParty(claim, f.asset)) notes.push(thirdPartyNote("finalize transaction"));
    if (!claim && f.claimLookup && f.claimLookup !== "pending") notes.push("We couldn't find who sent the finalize transaction: the free data sources didn't return that part of history. The money still went to the recipient.");
    return {
      state: "FINALIZED", eta: null, who: null, action: null, notes, claim,
      summary: "Finalized on Ethereum. The money went to the recipient; nothing is left to do.",
    };
  }

  if (!b.executed) {
    // The latest executed batch says how long batches take right now: commit to execute, or batch time to execute.
    const eta = b.committedAt != null ? b.committedAt + (l.executedAt - l.committedAt) : f.l2.timestamp + (l.executedAt - l.timestamp);
    return {
      state: "WAITING_FOR_BATCH", eta: Math.max(t, eta), who: null, notes, action: null,
      summary: `Waiting for its batch${b.number != null ? ` (${b.number})` : ""} to be executed on Ethereum. After that most ZKsync withdrawals are finalized automatically; if not, anyone can.`,
    };
  }

  notes.push("Most ZKsync withdrawals are finished automatically soon after this point. This one is still open, so anyone can finish it.");
  if (f.proof && !f.proof.simulated) {
    notes.push("A test run of the finalize step didn't succeed with the details we got. Check again before anyone sends it.");
  }
  return {
    state: "READY_TO_FINALIZE", eta: null, who: "anyone", notes,
    action: `L1Nullifier.finalizeDeposit({chainId: 324, l2BatchNumber: ${w.batch}, l2MessageIndex: ${w.index}, l2Sender: ${w.sender}, l2TxNumberInBatch: ${w.txNumberInBatch}, message: ${w.message}, merkleProof: ${f.proof ? `${f.proof.hashes.length} hashes` : "from zks_getL2ToL1LogProof"}})`,
    summary: "Confirmed on Ethereum and ready to finalize. Anyone can send the finalize transaction; the money goes only to the withdrawal's recipient.",
  };
}

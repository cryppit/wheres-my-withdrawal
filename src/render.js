// Plain-text report for the terminal. The page renders the same result object its own way.
import { KNOWN } from "./chains.js";
import { plainNext } from "./plain.js";

const LABEL = {
  FINALIZED: "DONE",
  RELAY_FAILED: "NEEDS A REPLAY",
  READY_TO_FINALIZE: "READY TO FINALIZE",
  WAITING_TO_FINALIZE: "WAITING",
  READY_TO_PROVE: "READY TO PROVE",
  WAITING_FOR_GAME: "WAITING",
  CLAIMED: "DONE",
  READY_TO_CLAIM: "READY TO CLAIM",
  WAITING_FOR_CONFIRMATION: "WAITING",
  WAITING_FOR_FINALIZATION: "WAITING",
  WAITING_FOR_BATCH: "WAITING",
};

export const utc = (sec) => new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";

export function formatAmount(asset) {
  if (!asset || asset.amount === undefined) return "a message (no funds)";
  if (asset.kind === "eth") return `${formatUnits(asset.amount, 18)} ETH`;
  if (asset.kind === "erc20") return asset.decimals != null ? `${formatUnits(asset.amount, asset.decimals)} ${asset.symbol ?? "tokens"}` : `${asset.amount} base units of ${asset.l1Token}`;
  return asset.amount > 0n ? `${formatUnits(asset.amount, 18)} ETH with a message` : "a message (no funds)";
}

export function formatUnits(v, decimals) {
  const s = v.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  // Eight decimals, unless that would round a dust amount (a 1-wei withdrawal) down to zero.
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${/^0{8}/.test(frac) ? frac : frac.slice(0, 8)}` : grouped;
}

/** Name an address: a known party, the withdrawal's own sender or recipient, or a third party. */
export function whoIs(address, f) {
  const a = address.toLowerCase();
  if (KNOWN[a]) return `${a} (${KNOWN[a]})`;
  if (a === f.asset.from?.toLowerCase()) return `${a} (the sender)`;
  if (a === f.asset.to?.toLowerCase()) return `${a} (the recipient)`;
  return `${a} (a third party; the money still goes only to the recipient)`;
}

/** When a claim happened: its time if the RPC gave the block timestamp, otherwise its L1 block. */
export const claimedWhen = (c) => (c.timestamp ? utc(c.timestamp) : `in L1 block ${c.block}`);

/** The last step's name: ZKsync and OP finalize, Arbitrum and Linea claim. */
export const claimVerb = (v) => (v.state === "FINALIZED" ? "Finalized" : "Claimed");

/** Who sent the last step and when; "still looking" while it is searched, and for Arbitrum "could not tell". null when there is none. */
export function claimLine(v, f) {
  if (v.claim) return `${claimedWhen(v.claim)} by ${whoIs(v.claim.by, f)}`;
  if (f.claimLookup === "pending") return `Finding who ${claimVerb(v).toLowerCase()} it…`;
  if (!f.spent) return null;
  if (f.claimLookup === "not-found") return "Could not tell: the claim's log was not in the range the RPCs returned.";
  return "Could not tell: finding it needs Ethereum history that no free RPC served.";
}

/** One line about the proof behind the call, or null when the call needs none from us. */
export function proofLine(f) {
  const p = f.proof;
  if (!p) return null;
  if (f.stack === "zksync") return `${p.hashes.length} hashes from zks_getL2ToL1LogProof; a dry run of the call on L1 ${p.simulated ? "succeeded" : "failed"}`;
  return `${p.hashes.length} hashes, root ${p.root} (confirmed on L1: ${p.rootConfirmed ? "yes" : "no"})`;
}

export function renderText(r) {
  if (r.error) return r.message;
  const { chain, facts: f, verdict: v } = r;
  const lines = [
    `${chain.name} withdrawal ${f.l2.txHash}${f.l2.withdrawals > 1 ? ` (#${f.l2.index} of ${f.l2.withdrawals})` : ""}`,
    `  started ${utc(f.l2.timestamp)}, block ${f.l2.blockNumber.toLocaleString("en-US")} on ${chain.name}`,
    `  carries ${formatAmount(f.asset)}${f.asset.to ? ` to ${f.asset.to}` : ""}`,
    "",
    `${LABEL[v.state]}  ${v.summary}`,
  ];
  const plain = plainNext(r);
  lines.push("", "What this means for you:", `  ${plain.headline}`, ...plain.steps.map((st, i) => `  ${i + 1}. ${st}`), "", "Details:");
  if (v.proof) lines.push(`  proven ${utc(v.proof.provenAt)}${v.proof.submitter ? ` by ${whoIs(v.proof.submitter, f)}` : ""}`);
  if (v.claim) lines.push(`  ${claimVerb(v).toLowerCase()} ${claimedWhen(v.claim)} by ${whoIs(v.claim.by, f)}`);
  if (v.eta) lines.push(`  next step opens about ${utc(v.eta)}`);
  if (v.who === "anyone") lines.push(`  who can do it: anyone. The money only goes to ${f.asset.to ?? f.withdrawal.target}.`);
  if (v.action) lines.push(`  call: ${v.action}`);
  if (v.action && f.proof) lines.push(`  proof: ${proofLine(f)}; --json prints them`);
  for (const n of v.notes) lines.push(`  note: ${n}`);
  lines.push("", `Read from public blockchain data at Ethereum block ${f.l1.block.toLocaleString("en-US")} (${utc(f.l1.timestamp)}). Nothing was signed.`);
  return lines.join("\n");
}

// Plain-text report for the terminal. The page renders the same result object its own way.
import { KNOWN } from "./chains.js";

const LABEL = {
  FINALIZED: "DONE",
  RELAY_FAILED: "NEEDS A REPLAY",
  READY_TO_FINALIZE: "READY TO FINALIZE",
  WAITING_TO_FINALIZE: "WAITING",
  READY_TO_PROVE: "READY TO PROVE",
  WAITING_FOR_GAME: "WAITING",
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
  return frac ? `${whole}.${frac.slice(0, 8)}` : whole;
}

/** Name an address: a known party, the withdrawal's own sender or recipient, or a third party. */
export function whoIs(address, f) {
  const a = address.toLowerCase();
  if (KNOWN[a]) return `${a} (${KNOWN[a]})`;
  if (a === f.asset.from?.toLowerCase()) return `${a} (the sender)`;
  if (a === f.asset.to?.toLowerCase()) return `${a} (the recipient)`;
  return `${a} (a third party; the money still goes only to the recipient)`;
}

export function renderText(r) {
  if (r.error) return r.message;
  const { chain, facts: f, verdict: v } = r;
  const lines = [
    `${chain.name} withdrawal ${f.l2.txHash}${f.l2.withdrawals > 1 ? ` (#${f.l2.index} of ${f.l2.withdrawals})` : ""}`,
    `  started ${utc(f.l2.timestamp)}, L2 block ${f.l2.blockNumber}`,
    `  carries ${formatAmount(f.asset)}${f.asset.to ? ` to ${f.asset.to}` : ""}`,
    "",
    `${LABEL[v.state]}  ${v.summary}`,
  ];
  if (v.proof) lines.push(`  proven ${utc(v.proof.provenAt)} by ${whoIs(v.proof.submitter, f)}`);
  if (v.eta) lines.push(`  next step opens about ${utc(v.eta)}`);
  if (v.who === "anyone") lines.push(`  who can do it: anyone. The money only goes to ${f.asset.to ?? f.withdrawal.target}.`);
  if (v.action) lines.push(`  call: ${v.action}`);
  for (const n of v.notes) lines.push(`  note: ${n}`);
  lines.push("", `Read from public RPCs at finalized Ethereum block ${f.l1.block} (${utc(f.l1.timestamp)}). Nothing was signed.`);
  return lines.join("\n");
}

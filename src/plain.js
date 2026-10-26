// What a result means for someone who has never heard of proving, dispute games or outboxes: one headline and a few
// numbered steps in plain words. The technical lines (the exact call, the proof) stay in the result for developers.
import { formatAmount, utc } from "./render.js";

const SCAM = "Anyone who asks for your seed phrase, an upfront fee or a wallet connection to their site is a scammer. Nobody needs those to finish a withdrawal.";

/** "2026-10-31 14:00 UTC, in about 5 days" (relative to the Ethereum block the check read). */
function when(eta, now) {
  const s = eta - now;
  if (s <= 0) return `${utc(eta)} (that time has passed, so check again now)`;
  const d = Math.floor(s / 86400), h = Math.round((s % 86400) / 3600);
  const rel = d >= 2 ? `about ${d} days` : d === 1 ? `about 1 day${h ? ` and ${h} hours` : ""}` : `about ${Math.max(1, h)} hour${h === 1 ? "" : "s"}`;
  return `${utc(eta)}, in ${rel}`;
}

/** { headline, steps[] } for a check result (not for errors). */
export function plainNext(r) {
  const { chain, facts: f, verdict: v } = r;
  const amount = formatAmount(f.asset);
  const to = f.asset.to ?? f.withdrawal?.target ?? "the recipient";
  const now = f.l1.timestamp;
  const stack = chain.stack;
  const onlyTo = `Anyone can send it, and the money can only go to ${to}.`;
  const old = f.legacy ? ["Bridge apps don't list it because it started before June 2023, when OP Mainnet upgraded. It still works the same way."] : [];

  switch (v.state) {
    case "FINALIZED":
    case "CLAIMED":
      return {
        headline: "Your money arrived on Ethereum. Nothing is left to do.",
        steps: [
          `The ${amount} was paid to ${to} on Ethereum.`,
          `Look for it in that wallet on Ethereum (not on ${chain.name}).`,
          ...(v.claim && to && v.claim.by?.toLowerCase() !== to.toLowerCase() && v.claim.by?.toLowerCase() !== f.asset.from?.toLowerCase()
            ? ["Someone else sent the last transaction for you. That's allowed, and you owe them nothing."]
            : []),
        ],
      };

    case "RELAY_FAILED":
      return {
        headline: "Almost done: the very last payment step failed and needs to be sent again.",
        steps: [
          "Your withdrawal went through every check, but the final payment ran out of gas or failed.",
          `It can be sent again. A developer tool, someone you trust, or the ${chain.name} team can do it. ${onlyTo}`,
          SCAM,
        ],
      };

    case "READY_TO_PROVE":
      return {
        headline: `Your ${amount} is waiting. It needs two more transactions on Ethereum.`,
        steps: [
          "Your money is safe where it is, and the withdrawal doesn't expire, so there is no rush.",
          "Step 1 of 2, now: prove the withdrawal on Ethereum. It is one transaction. A bridge app usually does it with one click; if yours doesn't show this withdrawal, someone you trust who uses Ethereum developer tools can send it from their own wallet.",
          `Step 2 of 2, 7 days later: finalize. That transaction pays the money to ${to}.`,
          `Anyone can send these two transactions, and the money can only go to ${to}. Whoever sends them pays only the gas.`,
          ...old,
          SCAM,
        ],
      };

    case "WAITING_FOR_GAME":
      return {
        headline: "Your withdrawal is on its way. Nothing to do yet.",
        steps: [
          `${chain.name} reports its latest state to Ethereum about once an hour, and that report doesn't cover your withdrawal yet.`,
          ...(v.eta ? [`Check again after ${when(v.eta, now)}.`] : []),
          `Then it can be proven (step 1 of 2), and 7 days later finalized (step 2 of 2), which pays the money to ${to}.`,
        ],
      };

    case "WAITING_TO_FINALIZE":
      return {
        headline: "Your withdrawal is proven. Now it waits out the safety period.",
        steps: [
          "Step 1 of 2 (prove) is done.",
          `Step 2 of 2 (finalize) opens ${when(v.eta, now)}. Then one transaction pays the money to ${to}. ${onlyTo}`,
          "Nothing to do until then. If someone else sent the first step, you owe them nothing.",
          ...old,
        ],
      };

    case "READY_TO_FINALIZE": {
      const zk = stack === "zksync";
      return {
        headline: "Ready: one last transaction pays your money.",
        steps: [
          zk
            ? "ZKsync has confirmed your withdrawal on Ethereum. The last step, finalize, can be sent now; ZKsync's own service usually sends it for you within a few hours."
            : "The waiting period is over. The last step, finalize, can be sent now.",
          `It is one transaction on Ethereum: a bridge app usually shows a button for it, or someone you trust can send it from their own wallet. ${onlyTo}`,
          SCAM,
        ],
      };
    }

    case "READY_TO_CLAIM":
      return {
        headline: "Ready: one last transaction, the claim, pays your money.",
        steps: [
          "The waiting period is over.",
          `Send the claim on Ethereum. The ${chain.name} bridge app usually lists it under pending withdrawals; someone you trust can also send it from their own wallet. ${onlyTo}`,
          ...(stack === "linea" ? ["The Linea bridge app may stop listing very old withdrawals; the claim still works if it is sent another way."] : []),
          SCAM,
        ],
      };

    case "WAITING_FOR_CONFIRMATION":
    case "WAITING_FOR_FINALIZATION":
    case "WAITING_FOR_BATCH":
      return {
        headline: "Your withdrawal is on its way. Nothing to do yet.",
        steps: [
          `Withdrawals from ${chain.name} to Ethereum have a built-in waiting period.`,
          ...(v.eta ? [`It should be ready about ${when(v.eta, now)}.`] : []),
          stack === "zksync"
            ? `After that, one last transaction (finalize) pays the money to ${to}; ZKsync's own service usually sends it.`
            : `After that, one last transaction (the claim) pays the money to ${to}. ${onlyTo}`,
        ],
      };

    default:
      return { headline: v.summary, steps: [] };
  }
}

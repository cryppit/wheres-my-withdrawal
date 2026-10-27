// The stops of a withdrawal, as the page draws them: what happened, what someone can do now, what is still coming.
// Built from the verdict alone, so the animation only plays what the chain showed.

/** Each stack's stops, and for each verdict state how far along it is: the index of the stop it is at and how. */
const STACKS = {
  op: ["Started on L2", "Prove", "Challenge window", "Finalize on Ethereum"],
  blast: ["Started on L2", "Prove", "Challenge window", "Finalize on Ethereum"],
  arbitrum: ["Started on L2", "Confirmed on Ethereum", "Claim"],
  linea: ["Started on L2", "Finalized on Ethereum", "Claim"],
  zksync: ["Started on L2", "Batch executed on Ethereum", "Finalize"],
};

/** [index of the stop the withdrawal is at, its state there]; every stop before it is done, every one after not reached. */
function position(stack, state) {
  const last = STACKS[stack].length - 1;
  switch (state) {
    case "FINALIZED":
    case "CLAIMED":
      return [last, "done"];
    case "READY_TO_PROVE":
      return [1, "next"];
    case "WAITING_FOR_GAME":
      return [1, "waiting"];
    case "WAITING_TO_FINALIZE":
      return [2, "waiting"];
    case "READY_TO_FINALIZE":
    case "READY_TO_CLAIM":
      return [last, "next"];
    case "RELAY_FAILED":
      return [last, "stopped"];
    case "WAITING_FOR_CONFIRMATION":
    case "WAITING_FOR_FINALIZATION":
    case "WAITING_FOR_BATCH":
      return [1, "waiting"];
    default:
      return [0, "done"];
  }
}

/**
 * @param {"op"|"blast"|"arbitrum"|"linea"|"zksync"} stack
 * @param {{ state: string, eta?: number }} v the verdict
 * @returns {{ title: string, state: "done"|"next"|"waiting"|"stopped"|"not_reached", eta?: number }[]}
 */
export function stepsOf(stack, v) {
  const [at, how] = position(stack, v.state);
  return STACKS[stack].map((title, i) => {
    if (i < at) return { title, state: "done" };
    if (i > at) return { title, state: "not_reached" };
    return how === "waiting" && v.eta ? { title, state: how, eta: v.eta } : { title, state: how };
  });
}

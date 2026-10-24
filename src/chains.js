// Chain profiles. Addresses are the L1 contracts each chain publishes (OP: superchain-registry op.toml; Base:
// docs.base.org Base contracts, since Base left the registry on 2026-04-27; Arbitrum: docs.arbitrum.io useful
// addresses, checked on chain on 2026-10-24: Bridge.rollup() and Outbox.rollup() both name this rollup). The anchor
// state registry, the dispute game factory and the Arbitrum Outbox are read at run time, because upgrades move them.
//
// Public RPCs only, no keys. Each list is tried in order. dRPC and 1RPC are never used.

const L1_RPCS = ["https://ethereum-rpc.publicnode.com", "https://rpc.mevblocker.io"];
// For old state and old logs, which PublicNode's free tier refuses ("archive requests require a personal token").
// Both served eth_call at 2023 blocks and eth_getLogs over millions of blocks, with CORS, keyless (24 Oct 2026).
// Tenderly's public gateway rate limits bursts, so it is only the fallback.
const L1_ARCHIVE_RPCS = ["https://rpc.mevblocker.io", "https://gateway.tenderly.co/public/mainnet"];

export const CHAINS = {
  op: {
    id: "op",
    name: "OP Mainnet",
    stack: "op",
    l2ChainId: 10,
    l2Rpcs: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"],
    l1Rpcs: L1_RPCS,
    portal: "0xbeb5fc579115071764c7423a4f12edde41f106ed",
    l1Messenger: "0x25ace71c97b33cc4729cf772ae268934f7ab5fa1",
    l1StandardBridge: "0x99c9fc46f92e8a1c0dec1b1747d010903e884be1",
    // About one game an hour (715 type-9 games in 29.7 days, measured 24 Oct 2026).
    cadenceSec: 3600,
    explorer: "https://optimistic.etherscan.io/tx/",
  },
  base: {
    id: "base",
    name: "Base",
    stack: "op",
    l2ChainId: 8453,
    l2Rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
    l1Rpcs: L1_RPCS,
    portal: "0x49048044d57e1c92a77f79988d21fa8faf74e97e",
    l1Messenger: "0x866e82a600a1414e583f7f13623f1ac5d58b0afa",
    l1StandardBridge: "0x3154cf16ccdb4c6d922629664174b904d80f2c35",
    // One game every 600 L2 blocks, about 20 minutes (measured 24 Oct 2026).
    cadenceSec: 1200,
    explorer: "https://basescan.org/tx/",
  },
  arb: {
    id: "arb",
    name: "Arbitrum One",
    stack: "arbitrum",
    l2ChainId: 42161,
    // arb1 serves old receipts and wide log ranges. Blast's public endpoint is the browser fallback (it sends CORS
    // headers); Nodies works from the CLI only. PublicNode's Arbitrum endpoint refuses receipts older than a few hours.
    l2Rpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one.public.blastapi.io", "https://arb-pokt.nodies.app"],
    l1Rpcs: L1_RPCS,
    l1ArchiveRpcs: L1_ARCHIVE_RPCS,
    rollup: "0x4dceb440657f21083db8add07665f8ddbe1dcfc0",
    l1GatewayRouter: "0x72ce9c846789fdb6fc1f34ac4ad25dd9ef7031ef",
    // About one assertion an hour (20 AssertionCreated logs in 6,000 L1 blocks, measured 24 Oct 2026).
    cadenceSec: 3600,
    explorer: "https://arbiscan.io/tx/",
  },
};

// Arbitrum precompiles on L2: ArbSys emits L2ToL1Tx; NodeInterface (a virtual contract, eth_call only) builds proofs.
export const ARBITRUM = {
  arbSys: "0x0000000000000000000000000000000000000064",
  nodeInterface: "0x00000000000000000000000000000000000000c8",
};

// L2 predeploys, the same on every OP Stack chain.
export const PREDEPLOYS = {
  messagePasser: "0x4200000000000000000000000000000000000016",
  l2Messenger: "0x4200000000000000000000000000000000000007",
  l2StandardBridge: "0x4200000000000000000000000000000000000010",
  legacyEth: "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0000",
};

// SequencerFeeVault, BaseFeeVault, L1FeeVault, OperatorFeeVault: their withdrawals are protocol revenue.
export const FEE_VAULTS = [
  "0x4200000000000000000000000000000000000011",
  "0x4200000000000000000000000000000000000019",
  "0x420000000000000000000000000000000000001a",
  "0x420000000000000000000000000000000000001b",
];

// Addresses we can name in a report. unlost.eth proves and finishes old withdrawals for others and then asks the
// owner for a tip (seen on Arbitrum, ZKsync, Linea, Scroll, Starknet and OP Mainnet since 22 Oct 2026; on Arbitrum it
// sends Outbox.executeTransaction itself, e.g. for position 44574 in L1 block 26254525).
export const KNOWN = {
  "0xa77028cd034fae57dd4acb50ebcb9c074d569e64": "unlost.eth, a third party that finishes old withdrawals and asks the owner for a tip",
};

// Game types whose root claim is a super root and whose sequence number is an L2 timestamp (Types.sol, op-contracts v8.0.0).
export const SUPER_GAME_TYPES = new Set([4, 5, 7, 9, 10]);

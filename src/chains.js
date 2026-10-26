// Chain profiles. Addresses are the L1 contracts each chain publishes (OP: superchain-registry op.toml; Base:
// docs.base.org Base contracts, since Base left the registry on 2026-04-27; Arbitrum: docs.arbitrum.io useful
// addresses, checked on chain on 2026-10-24: Bridge.rollup() and Outbox.rollup() both name this rollup; Robinhood
// Chain: docs.robinhood.com/chain/protocol-contracts, checked on chain on 2026-10-26 the same way; Linea:
// docs.linea.build, checked on chain on 2026-10-24: each TokenBridge's messageService() and remoteSender() name the
// others; ZKsync: zks_getBridgeContracts and zks_getMainContract, and L1AssetRouter.L1_NULLIFIER()). The anchor state
// registry, the dispute game factory and the Arbitrum Outbox are read at run time, because upgrades move them.
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
  robinhood: {
    id: "robinhood",
    name: "Robinhood Chain",
    stack: "arbitrum",
    l2ChainId: 4663,
    // Robinhood's own endpoint is the only keyless one; it serves receipts, logs and NodeInterface proofs, with CORS.
    l2Rpcs: ["https://rpc.mainnet.chain.robinhood.com"],
    l1Rpcs: L1_RPCS,
    l1ArchiveRpcs: L1_ARCHIVE_RPCS,
    rollup: "0x23a19d23e89166adedbdcb432518ab01e4272d94",
    l1GatewayRouter: "0x6a2e3a1e16fc29f27ce61429746d558d656975bb",
    // About one assertion every 30 minutes (452 AssertionCreated logs in 72,000 L1 blocks, measured 26 Oct 2026).
    cadenceSec: 1800,
    explorer: "https://robinhoodchain.blockscout.com/tx/",
  },
  linea: {
    id: "linea",
    name: "Linea",
    stack: "linea",
    l2ChainId: 59144,
    // rpc.linea.build serves old receipts and 10,000-block log ranges; PublicNode serves receipts but no logs.
    l2Rpcs: ["https://rpc.linea.build", "https://linea-rpc.publicnode.com"],
    l1Rpcs: L1_RPCS,
    rollup: "0xd19d4b5d358258f05d7b411e21a1460d11b0876f",
    l2MessageService: "0x508ca82df566dcd1b0de8296e70a96332cd644ec",
    l2TokenBridge: "0x353012dc4a9a6cf55c941badc267f82004a8ceb9",
    l1TokenBridge: "0x051f1d88f0af5763fb888ec4378b4d8b29ea3319",
    explorer: "https://lineascan.build/tx/",
  },
  zksync: {
    id: "zksync",
    name: "ZKsync Era",
    stack: "zksync",
    l2ChainId: 324,
    // The proof and batch lookups are zks_ methods, which only ZKsync's own endpoint serves among the keyless ones.
    l2Rpcs: ["https://mainnet.era.zksync.io"],
    l1Rpcs: L1_RPCS,
    l1ArchiveRpcs: L1_ARCHIVE_RPCS, // who finalized it: a search on old state, which PublicNode refuses
    diamond: "0x32400084c286cf3e17e7b677ea9583e60a000324",
    nullifier: "0xd7f9f54194c633f36ccd5f3da84ad4a1c38cb2cb",
    nativeTokenVault: "0xbed1eb542f9a5aa6419ff3deb921a372681111f6",
    l1LegacyBridge: "0x57891966931eb4bb6fb81430e6ce0a03aabde063",
    l2LegacyBridge: "0x11f943b2c77b743ab90f4a0ae7d5a4e7fca3e102",
    explorer: "https://explorer.zksync.io/tx/",
  },
};

// Arbitrum precompiles on L2: ArbSys emits L2ToL1Tx; NodeInterface (a virtual contract, eth_call only) builds proofs.
export const ARBITRUM = {
  arbSys: "0x0000000000000000000000000000000000000064",
  nodeInterface: "0x00000000000000000000000000000000000000c8",
};

// ZKsync Era system contracts on L2, and the batch finalizer on L1 (verified source "WithdrawalFinalizer"; it sent most
// L1 finalizations in a 24 h sample on 24 Oct 2026).
export const ZKSYNC = {
  l1Messenger: "0x0000000000000000000000000000000000008008",
  baseToken: "0x000000000000000000000000000000000000800a",
  assetRouter: "0x0000000000000000000000000000000000010003",
  finalizer: "0xf8a16864d8de145a266a534174305f881ee2315e",
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

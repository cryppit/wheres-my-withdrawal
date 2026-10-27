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
  // Six more OP Stack chains on the same fault-proof contracts (portal 5.6.1 or 5.8.0), from the superchain-registry
  // configs (mainnet/<chain>.toml). Each L1 messenger is L1StandardBridge.messenger(); game cadence and block times
  // measured on chain on 27 Oct 2026. Respected game types: 9 (Unichain, Ink), 5 (Soneium), 1 (Mode, Zora, World Chain).
  unichain: {
    id: "unichain",
    name: "Unichain",
    stack: "op",
    l2ChainId: 130,
    blockTimeSec: 1,
    l2Rpcs: ["https://mainnet.unichain.org", "https://unichain-rpc.publicnode.com"],
    // Its public endpoint answers eth_getProof about one time in four, and only within about 8,000 blocks.
    proofWindowBlocks: 8_000,
    proofTries: 12,
    l1Rpcs: L1_RPCS,
    portal: "0x0bd48f6b86a26d3a217d0fa6ffe2b491b956a7a2",
    l1Messenger: "0x9a3d64e386c18cb1d6d5179a9596a4b5736e98a6",
    l1StandardBridge: "0x81014f44b0a345033bb2b3b21c7a1a308b35feea",
    cadenceSec: 3600,
    explorer: "https://uniscan.xyz/tx/",
  },
  ink: {
    id: "ink",
    name: "Ink",
    stack: "op",
    l2ChainId: 57073,
    blockTimeSec: 1,
    l2Rpcs: ["https://rpc-gel.inkonchain.com", "https://ink-rpc.publicnode.com"],
    // Its first endpoint builds proofs at least 500,000 blocks back (checked 27 Oct 2026).
    proofWindowBlocks: 400_000,
    l1Rpcs: L1_RPCS,
    portal: "0x5d66c1782664115999c47c9fa5cd031f495d3e4f",
    l1Messenger: "0x69d3cf86b2bf1a9e99875b7e2d9b6a84426c171f",
    l1StandardBridge: "0x88ff1e5b602916615391f55854588efcbb7663f0",
    // About one game every 11 hours.
    cadenceSec: 39600,
    explorer: "https://explorer.inkonchain.com/tx/",
  },
  soneium: {
    id: "soneium",
    name: "Soneium",
    stack: "op",
    l2ChainId: 1868,
    l2Rpcs: ["https://rpc.soneium.org", "https://soneium-rpc.publicnode.com"],
    // Its first endpoint builds proofs at least 500,000 blocks back (checked 27 Oct 2026).
    proofWindowBlocks: 400_000,
    l1Rpcs: L1_RPCS,
    portal: "0x88e529a6ccd302c948689cd5156c83d4614fae92",
    l1Messenger: "0x9cf951e3f74b644e621b36ca9cea147a78d4c39f",
    l1StandardBridge: "0xeb9bf100225c214efc3e7c651ebbadcf85177607",
    cadenceSec: 7200,
    explorer: "https://soneium.blockscout.com/tx/",
  },
  worldchain: {
    id: "worldchain",
    name: "World Chain",
    stack: "op",
    l2ChainId: 480,
    l2Rpcs: ["https://worldchain-mainnet.g.alchemy.com/public", "https://480.rpc.thirdweb.com"],
    // Its first endpoint builds proofs at least 500,000 blocks back (checked 27 Oct 2026).
    proofWindowBlocks: 400_000,
    l1Rpcs: L1_RPCS,
    portal: "0xd5ec14a83b7d95be1e2ac12523e2dee12cbeea6c",
    l1Messenger: "0xf931a81d18b1766d15695ffc7c1920a62b7e710a",
    l1StandardBridge: "0x470458c91978d2d929704489ad730dc3e3001113",
    cadenceSec: 3600,
    explorer: "https://worldscan.org/tx/",
  },
  mode: {
    id: "mode",
    name: "Mode",
    stack: "op",
    l2ChainId: 34443,
    l2Rpcs: ["https://mainnet.mode.network"],
    // Its first endpoint builds proofs at least 500,000 blocks back (checked 27 Oct 2026).
    proofWindowBlocks: 400_000,
    l1Rpcs: L1_RPCS,
    portal: "0x8b34b14c7c7123459cf3076b8cb929be097d0c07",
    l1Messenger: "0x95bdca6c8edeb69c98bd5bd17660bacef1298a6f",
    l1StandardBridge: "0x735adbbe72226bd52e818e7181953f42e3b0ff21",
    cadenceSec: 21600,
    explorer: "https://explorer.mode.network/tx/",
  },
  zora: {
    id: "zora",
    name: "Zora",
    stack: "op",
    l2ChainId: 7777777,
    l2Rpcs: ["https://rpc.zora.energy"],
    // Its first endpoint builds proofs at least 500,000 blocks back (checked 27 Oct 2026).
    proofWindowBlocks: 400_000,
    l1Rpcs: L1_RPCS,
    portal: "0x1a0ad011913a150f69f6a19df447a0cfd9551054",
    l1Messenger: "0xdc40a14d9abd6f410226f1e6de71ae03441ca506",
    l1StandardBridge: "0x3e2ea9b92b7e48a52296fd261dc26fd995284631",
    cadenceSec: 21600,
    explorer: "https://explorer.zora.energy/tx/",
  },
  // Blast keeps the pre-fault-proof portal (1.10.0) with an L2OutputOracle and an ETH yield manager (src/blast.js).
  // Checked on chain on 27 Oct 2026: the messenger's PORTAL(), the portal's l2Oracle(), the yield manager's portal()
  // and the bridge's messenger() all name each other. An output every 1,800 L2 blocks (one an hour).
  blast: {
    id: "blast",
    name: "Blast",
    stack: "blast",
    l2ChainId: 81457,
    l2Rpcs: ["https://rpc.blast.io", "https://blast-rpc.publicnode.com"],
    l1Rpcs: L1_RPCS,
    portal: "0x0ec68c5b10f21effb74f2a5c61dfe6b08c0db6cb",
    l2Oracle: "0x826d1b0d4111ad9146eb8941d7ca2b6a44215c76",
    yieldManager: "0x98078db053902644191f93988341e31289e1c8fe",
    l1Messenger: "0x5d4472f31bd9385709ec61305afc749f0fa8e9d0",
    l1StandardBridge: "0x697402166fbf2f22e970df8a6486ef171dbfc524",
    // L1BlastBridge (a StandardBridge whose other side is L2BlastBridge 0x4300…0005, checked on chain): ETH and USDB.
    l1ExtraBridges: ["0x3a05e5d33d7ab3864d53aaec93c8301c1fa49115"],
    cadenceSec: 3600,
    explorer: "https://blastscan.io/tx/",
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

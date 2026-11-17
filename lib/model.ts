// Token Radar — the radar-2 scoring model, the board builder and the farm plans.
//
// This file turns a sealed DefiLlama snapshot into a ranked board of pre-token
// protocols. The idea is simple: a token, if one ever launched, would represent
// some fraction of the business the protocol already runs, so the model starts
// from total value locked and then nudges the number up or down for momentum,
// for how long the protocol has run without a token, and for how widely it is
// deployed. Nothing here names a protocol specially; every row is scored by the
// same four multipliers, and the same function also writes the six-step farm
// plan that the dashboard shows for each row.
//
// The snapshot is trusted only after a shape check. Ages are counted in whole
// days from the snapshot date, and a protocol with no listing date is treated
// as a year old, which is the neutral middle of the maturity curve. A missing
// weekly change is treated as flat. The board itself is deterministic: sort
// keys are the implied value and then the slug, so two runs on the same
// snapshot always produce the same bytes.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface ModelBreakdown {
  base_multiple: number;
  growth_pct: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  age_days: number | null;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: ModelBreakdown;
  farm_steps: string[];
}

export interface LiveEntry {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  symbol: string | null;
  listed_at: string | null;
}

export interface Radar {
  as_of: string;
  source: string;
  floor_usd: number;
  total_protocols: number;
  watchlist_size: number;
  early_size: number;
  live_size: number;
  total_implied_usd: number;
  categories: string[];
  chains: string[];
  watchlist: string[];
  rows: BoardRow[];
  live: LiveEntry[];
}

// The four multipliers of radar-2, and the cut-offs that shape the board.
const BASE_FRACTION = 0.25;
const GROWTH_FLOOR = -60;
const GROWTH_CEILING = 120;
const GROWTH_WEIGHT = 0.7;
const MATURITY_FLOOR = 0.55;
const MATURITY_SPAN = 0.75;
const MATURITY_CAP_DAYS = 1095;
const AGE_WHEN_UNKNOWN_DAYS = 365;
const BREADTH_PER_EXTRA_CHAIN = 0.02;
const BREADTH_EXTRA_CAP = 8;
const EARLY_ROWS = 160;
const LIVE_ROWS = 24;
const LARGE_TVL_USD = 1_000_000_000;
const MEDIUM_TVL_USD = 100_000_000;
const LARGE_FARM_USD = 150;
const MEDIUM_FARM_USD = 100;
const SMALL_FARM_USD = 50;
const LARGE_FARM_GAS_USD = 8;
const SMALL_FARM_GAS_USD = 4;
const YOUNG_AGE_DAYS = 180;
const MID_AGE_DAYS = 365;
const SHORT_HOLD_DAYS = 30;
const MEDIUM_HOLD_DAYS = 45;
const LONG_HOLD_DAYS = 60;
const CENTRALISED_CATEGORY = 'CEX';
const LEGACY_VERSION = /-v\d+$/;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Keep a value inside [low, high]. */
function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** Round to four places after the point, the precision the board prints. */
function fourPlaces(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Whole days between two dates given as YYYY-MM-DD, counted in UTC. */
function wholeDays(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

/** A protocol counts as pre-token when its record carries no token symbol. */
function isPreToken(protocol: SnapshotProtocol): boolean {
  return protocol.symbol === null;
}

/** A slug ending in -v1, -v2, ... is an older version of the same protocol. */
function isLegacyVersion(protocol: SnapshotProtocol): boolean {
  return LEGACY_VERSION.test(protocol.slug);
}

// ---------------------------------------------------------------------------
// Reading the snapshot
// ---------------------------------------------------------------------------

function fail(message: string): never {
  throw new Error(`token radar: snapshot: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredText(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) fail(`field ${key} must be a non-empty string`);
  return value;
}

function optionalText(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') fail(`field ${key} must be a string or null`);
  return value;
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`field ${key} must be a finite number`);
  return value;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`field ${key} must be a number or null`);
  return value;
}

function stringList(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail(`field ${key} must be an array of strings`);
  }
  return [...(value as string[])];
}

function readProtocol(raw: unknown, index: number): SnapshotProtocol {
  if (!isRecord(raw)) fail(`protocols[${index}] must be an object`);
  return {
    slug: requiredText(raw, 'slug'),
    name: requiredText(raw, 'name'),
    category: requiredText(raw, 'category'),
    chains: stringList(raw, 'chains'),
    tvl_usd: requiredNumber(raw, 'tvl_usd'),
    change_7d: optionalNumber(raw, 'change_7d'),
    mcap_usd: optionalNumber(raw, 'mcap_usd'),
    listed_at: optionalText(raw, 'listed_at'),
    gecko_id: optionalText(raw, 'gecko_id'),
    symbol: optionalText(raw, 'symbol'),
  };
}

/**
 * Parse and shape-check the snapshot text. Anything that is not an object
 * with a protocols array, a watchlist array, a floor and a date is refused
 * here, before any scoring happens.
 */
export function parseSnapshot(text: string): Snapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('not valid JSON');
  }
  if (!isRecord(parsed)) fail('top level must be an object');
  const protocolsRaw = parsed.protocols;
  if (!Array.isArray(protocolsRaw)) fail('protocols must be an array');
  const watchlist = stringList(parsed, 'watchlist');
  return {
    as_of: requiredText(parsed, 'as_of'),
    source: requiredText(parsed, 'source'),
    floor_usd: requiredNumber(parsed, 'floor_usd'),
    protocols: protocolsRaw.map((raw, index) => readProtocol(raw, index)),
    watchlist,
  };
}

// ---------------------------------------------------------------------------
// Scoring one protocol
// ---------------------------------------------------------------------------

export interface ScoredProtocol {
  protocol: SnapshotProtocol;
  age_days: number | null;
  implied_value_usd: number;
  model: ModelBreakdown;
}

/**
 * Score one protocol with radar-2. The growth multiplier uses the weekly
 * change clamped to [-60, 120] percent, the maturity multiplier grows with
 * age up to three years, and the breadth multiplier adds 2% per extra chain
 * up to eight. The breakdown printed on the board rounds each multiplier to
 * four places, but the implied value itself is computed from the unrounded
 * multipliers and only rounded at the end.
 */
export function scoreProtocol(protocol: SnapshotProtocol, asOf: string): ScoredProtocol {
  const ageDays = protocol.listed_at === null ? null : wholeDays(protocol.listed_at, asOf);
  const ageForCurve = ageDays === null ? AGE_WHEN_UNKNOWN_DAYS : ageDays;
  const rawGrowth = protocol.change_7d === null ? 0 : protocol.change_7d;
  const growthPct = clamp(rawGrowth, GROWTH_FLOOR, GROWTH_CEILING);
  const growth = 1 + (growthPct / 100) * GROWTH_WEIGHT;
  const maturity = MATURITY_FLOOR + (Math.min(ageForCurve, MATURITY_CAP_DAYS) / MATURITY_CAP_DAYS) * MATURITY_SPAN;
  const extraChains = Math.min(Math.max(protocol.chains.length - 1, 0), BREADTH_EXTRA_CAP);
  const breadth = 1 + BREADTH_PER_EXTRA_CHAIN * extraChains;
  return {
    protocol,
    age_days: ageDays,
    implied_value_usd: Math.round(protocol.tvl_usd * BASE_FRACTION * growth * maturity * breadth),
    model: {
      base_multiple: BASE_FRACTION,
      growth_pct: growthPct,
      growth_multiplier: fourPlaces(growth),
      maturity_multiplier: fourPlaces(maturity),
      breadth_multiplier: fourPlaces(breadth),
      age_days: ageDays,
    },
  };
}

// ---------------------------------------------------------------------------
// Farm plans
// ---------------------------------------------------------------------------

/** The kind of first step a protocol's category calls for. */
type FarmKind =
  | 'vault'
  | 'liquidity'
  | 'supply'
  | 'bridge'
  | 'mintYield'
  | 'stake'
  | 'margin'
  | 'stable'
  | 'cover'
  | 'market'
  | 'deposit';

const KIND_BY_CATEGORY: Record<string, FarmKind> = {
  'Risk Curators': 'vault',
  'Onchain Capital Allocator': 'vault',
  Dexs: 'liquidity',
  Yield: 'liquidity',
  'Yield Aggregator': 'liquidity',
  Indexes: 'liquidity',
  'Leveraged Farming': 'liquidity',
  Lending: 'supply',
  CDP: 'supply',
  'Uncollateralized Lending': 'supply',
  'Collateral Markets': 'supply',
  Bridge: 'bridge',
  'Canonical Bridge': 'bridge',
  RWA: 'mintYield',
  'Liquid Staking': 'stake',
  'Liquid Restaking': 'stake',
  Restaking: 'stake',
  'Staking Pool': 'stake',
  Derivatives: 'margin',
  'Dual-Token Stablecoin': 'stable',
  'Stablecoin Wrapper': 'stable',
  Insurance: 'cover',
  'Prediction Market': 'market',
};

/** What the weekly repeat action looks like for each kind of farm. */
const WEEKLY_BY_KIND: Record<FarmKind, string> = {
  vault: 'a vault deposit or a rebalance vote',
  liquidity: 'a swap or a small liquidity add',
  supply: 'a supply, a borrow or a repayment',
  bridge: 'a bridge in either direction',
  mintYield: 'a mint or a transfer of the yield asset',
  stake: 'a stake top-up or a restake',
  margin: 'a small trade or a funding adjustment',
  stable: 'a mint or a redemption',
  cover: 'a cover renewal or a claim check',
  market: 'one market position',
  deposit: 'a deposit, a swap or a vote',
};

/** The opening step for each kind of farm, with the amount, name and chain filled in. */
function openingStep(kind: FarmKind, name: string, chain: string, amount: number): string {
  switch (kind) {
    case 'vault':
      return `Deposit $${amount} into a ${name} vault on ${chain} and keep the shares.`;
    case 'liquidity':
      return `Provide $${amount} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
    case 'supply':
      return `Supply $${amount} of USDC to ${name} on ${chain} and keep the position open.`;
    case 'bridge':
      return `Bridge $${amount} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
    case 'mintYield':
      return `Mint $${amount} of the protocol's yield asset on ${chain} and hold it.`;
    case 'stake':
      return `Stake $${amount} of the chain's staking asset through ${name} and keep the receipt.`;
    case 'margin':
      return `Deposit $${amount} of USDC as margin on ${name} and open one small hedge.`;
    case 'stable':
      return `Mint or deposit $${amount} of the stable asset through ${name} on ${chain}.`;
    case 'cover':
      return `Buy $${amount} of cover from ${name} on ${chain} and keep the policy.`;
    case 'market':
      return `Fund $${amount} and place one market position on ${name}.`;
    case 'deposit':
      return `Deposit $${amount} of USDC into ${name} on ${chain} and keep the position open.`;
  }
}

/**
 * How long a position should be held before it counts: younger protocols
 * need longer, because a single snapshot could be noise; a protocol that
 * has run for a year or more has already shown it sticks around.
 */
function holdDays(ageDays: number | null): number {
  if (ageDays === null || ageDays >= MID_AGE_DAYS) return SHORT_HOLD_DAYS;
  if (ageDays >= YOUNG_AGE_DAYS) return MEDIUM_HOLD_DAYS;
  return LONG_HOLD_DAYS;
}

/**
 * The six-step farm plan for one protocol. The amount scales with size —
 * $150 for a billion-dollar protocol, $100 above $100M, $50 below that —
 * and the gas line follows it: $8 for the largest farms, $4 otherwise.
 * The first chain in the snapshot's own order is where the farm happens.
 */
export function farmPlan(protocol: SnapshotProtocol, ageDays: number | null): string[] {
  const kind = KIND_BY_CATEGORY[protocol.category] ?? 'deposit';
  const amount =
    protocol.tvl_usd >= LARGE_TVL_USD
      ? LARGE_FARM_USD
      : protocol.tvl_usd >= MEDIUM_TVL_USD
        ? MEDIUM_FARM_USD
        : SMALL_FARM_USD;
  const gas = amount === LARGE_FARM_USD ? LARGE_FARM_GAS_USD : SMALL_FARM_GAS_USD;
  const hold = holdDays(ageDays);
  const firstChain = protocol.chains.length > 0 ? protocol.chains[0]! : 'Ethereum';
  return [
    'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline. Cost: under $3 of gas for the first transaction. Time: 5 minutes.',
    `${openingStep(kind, protocol.name, firstChain, amount)} Cost: $${amount} of capital and about $${gas} of gas. Time: 15 minutes to set up.`,
    `Make one qualifying action each week, such as ${WEEKLY_BY_KIND[kind]}, so the wallet shows repeat use. Cost: about $2 of gas a week. Time: 10 minutes a week.`,
    `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot. Cost: the $${amount} stays in the position. Time: ${hold} days.`,
    "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes. Cost: no fee to check, and never pay to claim. Time: 10 minutes.",
    'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it. Cost: nothing but the log. Time: 5 minutes.',
  ];
}

// ---------------------------------------------------------------------------
// Building the board
// ---------------------------------------------------------------------------

/** Sort by implied value, highest first, with the slug breaking ties. */
function byImpliedDesc(a: ScoredProtocol, b: ScoredProtocol): number {
  if (b.implied_value_usd !== a.implied_value_usd) return b.implied_value_usd - a.implied_value_usd;
  return a.protocol.slug < b.protocol.slug ? -1 : a.protocol.slug > b.protocol.slug ? 1 : 0;
}

/** Sort by total value locked, highest first, with the slug breaking ties. */
function byTvlDesc(a: SnapshotProtocol, b: SnapshotProtocol): number {
  if (b.tvl_usd !== a.tvl_usd) return b.tvl_usd - a.tvl_usd;
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

function toRow(scored: ScoredProtocol, rank: number): BoardRow {
  const p = scored.protocol;
  return {
    rank,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: [...p.chains],
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    mcap_usd: p.mcap_usd,
    listed_at: p.listed_at,
    gecko_id: p.gecko_id,
    symbol: p.symbol,
    token_status: 'pre-token',
    age_days: scored.age_days,
    implied_value_usd: scored.implied_value_usd,
    model: scored.model,
    farm_steps: farmPlan(p, scored.age_days),
  };
}

/**
 * Build the board from a parsed snapshot.
 *
 * The watchlist is covered in full: every watchlist protocol with no token
 * on record is scored, whatever its size. The early rows are the largest
 * remaining pre-token protocols below the snapshot floor — centralised
 * exchanges and legacy versions are left out, because neither is a token
 * launch a radar should chase — taken in TVL order. Protocols that already
 * have a live token are set aside for the dashboard's Live tab, largest
 * market cap first. The scored rows are then ranked by implied value.
 */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: Radar } {
  const wanted = new Set(snapshot.watchlist);
  const watchlist = snapshot.protocols.filter((p) => wanted.has(p.slug) && isPreToken(p));
  const earlyPool = snapshot.protocols.filter(
    (p) =>
      isPreToken(p) &&
      !wanted.has(p.slug) &&
      p.tvl_usd < snapshot.floor_usd &&
      p.category !== CENTRALISED_CATEGORY &&
      !isLegacyVersion(p),
  );
  const early = [...earlyPool].sort(byTvlDesc).slice(0, EARLY_ROWS);
  const scored = [...watchlist, ...early]
    .map((p) => scoreProtocol(p, snapshot.as_of))
    .sort(byImpliedDesc);
  const board = scored.map((s, index) => toRow(s, index + 1));
  const live = snapshot.protocols
    .filter((p) => p.mcap_usd !== null)
    .sort((a, b) => {
      if (b.mcap_usd !== a.mcap_usd) return (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0);
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    })
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: [...p.chains],
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd ?? 0,
      symbol: p.symbol,
      listed_at: p.listed_at,
    }));
  const categories = [...new Set(board.map((row) => row.category))].sort();
  const chains = [...new Set(board.flatMap((row) => row.chains))].sort();
  const radar: Radar = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    total_protocols: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    early_size: early.length,
    live_size: live.length,
    total_implied_usd: board.reduce((sum, row) => sum + row.implied_value_usd, 0),
    categories,
    chains,
    watchlist: [...snapshot.watchlist],
    rows: board,
    live,
  };
  return { board, radar };
}

// ---------------------------------------------------------------------------
// Checking the board, and writing the dashboard's data file
// ---------------------------------------------------------------------------

/**
 * Check a board against its snapshot and return the first problem found,
 * or null when the board is sound: 200 rows, ranks in order, sorted by
 * implied value, every watchlist protocol present once, no duplicates, and
 * every implied value matching a fresh re-score.
 */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (!Array.isArray(board) || board.length !== 200) {
    return `expected 200 rows, got ${Array.isArray(board) ? board.length : 'no board'}`;
  }
  const seen = new Set<string>();
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  for (let i = 0; i < board.length; i++) {
    const row = board[i]!;
    if (row.rank !== i + 1) return `row ${i + 1} has rank ${row.rank}`;
    if (seen.has(row.slug)) return `duplicate slug ${row.slug}`;
    seen.add(row.slug);
    if (row.token_status !== 'pre-token') return `${row.slug} is not pre-token`;
    const source = bySlug.get(row.slug);
    if (source === undefined) return `${row.slug} is not in the snapshot`;
    const fresh = scoreProtocol(source, snapshot.as_of);
    if (fresh.implied_value_usd !== row.implied_value_usd) {
      return `${row.slug} implies $${row.implied_value_usd}, re-score says $${fresh.implied_value_usd}`;
    }
    if (i > 0 && row.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `board is not sorted by implied value at rank ${row.rank}`;
    }
  }
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist protocol ${slug} is missing from the board`;
  }
  return null;
}

/** The dashboard's data file: the whole radar as one global, no network needed. */
export function dataScript(radar: Radar): string {
  const payload = JSON.stringify(radar).replace(/</g, '\\u003c');
  return `window.TOKEN_RADAR = ${payload};\n`;
}

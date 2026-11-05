// Renko (ATR brick) + Supertrend strategy -> IG REST API.
// Every run: fetch candles, rebuild ALL bricks from scratch, decide, trade.

type Bar = { t: number; o: number; h: number; l: number; c: number };
type Session = { cst: string; xst: string };
type Brick = { o: number; c: number; dir: number; stDir: number; stVal: number };
type State = {
  bricks: Brick[]; lastClose: number; trend: number; green: number; red: number;
  stAtr: number; stUpper: number; stLower: number; pClose: number;
  stSum: number; stCnt: number; stDir: number;
};

const E = (k: string, d: string) => process.env[k] ?? d;
const N = (k: string, d: number) => Number(E(k, String(d)));
const B = (k: string, d: boolean) => E(k, String(d)).toLowerCase() === "true";

// candle length in minutes for the trading timeframe (IG resolution names)
const PERIOD_MIN: Record<string, number> = {
  MINUTE_15: 15, MINUTE_30: 30, HOUR: 60, HOUR_2: 120, HOUR_3: 180, HOUR_4: 240,
};

function config() {
  const live = E("IG_ENV", "demo").toLowerCase() === "live";
  return {
    base: live ? "https://api.ig.com/gateway/deal" : "https://demo-api.ig.com/gateway/deal",
    apiKey: E("IG_API_KEY", ""), user: E("IG_USERNAME", ""), pass: E("IG_PASSWORD", ""),
    epic: E("EPIC", "CS.D.EURUSD.CFD.IP"),
    tf: E("TIMEFRAME", "HOUR_4"),
    history: N("HISTORY_BARS", 150),       // trading candles fetched each run
    atrDays: N("ATR_HISTORY_DAYS", 40),    // daily candles fetched each run
    atrLen: N("ATR_LENGTH", 5), atrDiv: N("ATR_DIVISOR", 5),
    tick: N("TICK_SIZE", 0.00001), roundTick: B("ROUND_TO_TICK", true),
    useHL: B("USE_HIGH_LOW", true),
    enableLong: B("ENABLE_LONG", true), enableShort: B("ENABLE_SHORT", true),
    greenBuy: N("GREEN_TO_BUY", 2), redExit: N("RED_TO_EXIT", 1),
    redSell: N("RED_TO_SELL", 2), greenCover: N("GREEN_TO_COVER", 1),
    onBrickCloseOnly: E("ENTRY_MODE", "WhileConditionHolds") === "OnBrickCloseOnly",
    useST: B("USE_SUPERTREND", true), stLen: N("ST_LENGTH", 1), stFactor: N("ST_FACTOR", 2.1),
    exitOnST: B("EXIT_ON_SUPERTREND", false),
    size: N("SIZE", 1), currency: E("CURRENCY", "USD"),
    stopPoints: N("STOP_POINTS", 0),       // 0 = no stop (not recommended)
    dryRun: E("DRY_RUN", "true").toLowerCase() !== "false",
    windowMin: N("ACT_WINDOW_MIN", 15),    // only act within N min after a candle closes
  };
}
type Cfg = ReturnType<typeof config>;

// ---------------------------------------------------------------- IG API
async function ig(c: Cfg, method: string, path: string, version: string,
  s?: Session, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(c.base + path, {
    method,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      Accept: "application/json; charset=UTF-8",
      "X-IG-API-KEY": c.apiKey,
      Version: version,
      ...(s ? { CST: s.cst, "X-SECURITY-TOKEN": s.xst } : {}),
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`IG ${method} ${path} -> ${res.status} ${text}`);
  return { json: text ? JSON.parse(text) : {}, headers: res.headers };
}

async function login(c: Cfg): Promise<Session> {
  const { headers } = await ig(c, "POST", "/session", "2", undefined,
    { identifier: c.user, password: c.pass });
  const cst = headers.get("cst"), xst = headers.get("x-security-token");
  if (!cst || !xst) throw new Error("IG login returned no session tokens");
  return { cst, xst };
}

async function candles(c: Cfg, s: Session, resolution: string, max: number): Promise<Bar[]> {
  const { json } = await ig(c, "GET",
    `/prices/${c.epic}?resolution=${resolution}&max=${max}&pageSize=0`, "3", s);
  const a = json.metadata?.allowance;
  if (a) console.log(`IG data allowance left: ${a.remainingAllowance}/${a.totalAllowance}`);
  const mid = (x: { bid: number; ask: number }) => (x.bid + x.ask) / 2;
  const ts = (v: string) => Date.parse(v.endsWith("Z") ? v : v + "Z");
  return (json.prices as any[])
    .map((p) => ({
      t: ts(p.snapshotTimeUTC), o: mid(p.openPrice), h: mid(p.highPrice),
      l: mid(p.lowPrice), c: mid(p.closePrice),
    }))
    .filter((b) => [b.o, b.h, b.l, b.c].every(Number.isFinite))
    .sort((x, y) => x.t - y.t);
}

async function getPositions(c: Cfg, s: Session) {
  const { json } = await ig(c, "GET", "/positions", "2", s);
  return (json.positions as any[]).filter((p) => p.market.epic === c.epic)
    .map((p) => ({ dealId: p.position.dealId as string, dir: p.position.direction as string, size: p.position.size as number }));
}

async function openPos(c: Cfg, s: Session, dir: "BUY" | "SELL") {
  const body: any = {
    epic: c.epic, expiry: "-", direction: dir, size: c.size, orderType: "MARKET",
    guaranteedStop: false, forceOpen: true, currencyCode: c.currency,
  };
  if (c.stopPoints > 0) body.stopDistance = c.stopPoints;
  const { json } = await ig(c, "POST", "/positions/otc", "2", s, body);
  const conf = await ig(c, "GET", `/confirms/${json.dealReference}`, "1", s);
  console.log("OPEN result:", conf.json.dealStatus, conf.json.reason);
}

async function closePos(c: Cfg, s: Session, p: { dealId: string; dir: string; size: number }) {
  const { json } = await ig(c, "POST", "/positions/otc", "1", s,
    { dealId: p.dealId, direction: p.dir === "BUY" ? "SELL" : "BUY", size: p.size, orderType: "MARKET" },
    { _method: "DELETE" });
  const conf = await ig(c, "GET", `/confirms/${json.dealReference}`, "1", s);
  console.log("CLOSE result:", conf.json.dealStatus, conf.json.reason);
}

// ---------------------------------------------------------------- Indicators
function wilderAtr(bars: Bar[], n: number): number[] {
  const out: number[] = new Array(bars.length).fill(NaN);
  let prev = NaN, sum = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const tr = i === 0 ? b.h - b.l
      : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c));
    if (i < n) { sum += tr; if (i === n - 1) { prev = sum / n; out[i] = prev; } }
    else { prev = (prev * (n - 1) + tr) / n; out[i] = prev; }
  }
  return out;
}

// ---------------------------------------------------------------- Renko engine
const newState = (): State => ({
  bricks: [], lastClose: NaN, trend: 0, green: 0, red: 0,
  stAtr: NaN, stUpper: NaN, stLower: NaN, pClose: NaN, stSum: 0, stCnt: 0, stDir: 0,
});

function step(lc: number, tr: number, hh: number, ll: number, bs: number) {
  const up = hh - lc, dn = lc - ll;
  let d = 0, n = 0, start = NaN;
  if (tr === 0) {
    if (up >= bs && up >= dn) { d = 1; n = Math.floor(up / bs); start = lc; }
    else if (dn >= bs) { d = -1; n = Math.floor(dn / bs); start = lc; }
  } else if (tr === 1) {
    if (up >= bs) { d = 1; n = Math.floor(up / bs); start = lc; }
    else if (dn >= 2 * bs) { d = -1; n = Math.floor(dn / bs) - 1; start = lc - bs; }
  } else {
    if (dn >= bs) { d = -1; n = Math.floor(dn / bs); start = lc; }
    else if (up >= 2 * bs) { d = 1; n = Math.floor(up / bs) - 1; start = lc + bs; }
  }
  return { d, n, start };
}

function addBrick(c: Cfg, S: State, o: number, c2: number, dir: number) {
  const h = Math.max(o, c2), l = Math.min(o, c2);
  const trv = Number.isNaN(S.pClose) ? h - l
    : Math.max(h - l, Math.abs(h - S.pClose), Math.abs(l - S.pClose));
  S.stCnt++;
  let atrV: number;
  if (S.stCnt <= c.stLen) { S.stSum += trv; atrV = S.stSum / S.stCnt; }
  else atrV = (S.stAtr * (c.stLen - 1) + trv) / c.stLen;
  S.stAtr = atrV;

  const mid = (o + c2) / 2;
  const ub = mid + c.stFactor * atrV, lb = mid - c.stFactor * atrV;
  if (Number.isNaN(S.stLower)) { S.stLower = lb; S.stUpper = ub; S.stDir = dir; }
  else {
    const nl = (lb > S.stLower || S.pClose < S.stLower) ? lb : S.stLower;
    const nu = (ub < S.stUpper || S.pClose > S.stUpper) ? ub : S.stUpper;
    if (S.stDir === 1) S.stDir = c2 < nl ? -1 : 1;
    else S.stDir = c2 > nu ? 1 : -1;
    S.stLower = nl; S.stUpper = nu;
  }
  S.bricks.push({ o, c: c2, dir, stDir: S.stDir, stVal: S.stDir === 1 ? S.stLower : S.stUpper });
  S.pClose = c2;
}

function processBar(c: Cfg, S: State, b: Bar, bs: number): boolean {
  const hi = c.useHL ? b.h : b.c, lo = c.useHL ? b.l : b.c;
  if (Number.isNaN(S.lastClose)) { S.lastClose = b.c; return false; }
  const st = step(S.lastClose, S.trend, hi, lo, bs);
  if (st.n <= 0) return false;
  let o = st.start;
  for (let k = 0; k < st.n; k++) { const c2 = o + st.d * bs; addBrick(c, S, o, c2, st.d); o = c2; }
  S.lastClose = o; S.trend = st.d;
  if (st.d === 1) { S.green += st.n; S.red = 0; } else { S.red += st.n; S.green = 0; }
  return true;
}

// ---------------------------------------------------------------- Main
export async function runBot(opts: { force?: boolean } = {}) {
  const c = config();
  if (!c.apiKey || !c.user || !c.pass) throw new Error("Set IG_API_KEY, IG_USERNAME, IG_PASSWORD");
  const period = PERIOD_MIN[c.tf];
  if (!period) throw new Error(`TIMEFRAME must be one of ${Object.keys(PERIOD_MIN).join(", ")}`);

  const s = await login(c);
  const now = Date.now();
  const closedOnly = (a: Bar[]) => a.filter((b) => b.t + period * 60000 <= now);

  // cheap probe (2 candles) so we only spend data allowance when a candle just closed
  const probe = closedOnly(await candles(c, s, c.tf, 2));
  if (!probe.length) return { action: "none", reason: "no closed candle" };
  const ageMin = (now - (probe[probe.length - 1].t + period * 60000)) / 60000;
  if (!opts.force && ageMin > c.windowMin)
    return { action: "none", reason: `latest closed candle is ${ageMin.toFixed(0)} min old; nothing new` };

  const bars = closedOnly(await candles(c, s, c.tf, c.history));
  const daily = await candles(c, s, "DAY", c.atrDays);
  const atr = wilderAtr(daily, c.atrLen);

  // ---- full recompute from scratch
  const S = newState();
  let di = 0, brickSize = NaN, atrVal = NaN, newBrick = false;
  for (const b of bars) {
    while (di + 1 < daily.length && daily[di + 1].t <= b.t) di++;
    const a = di >= 1 && daily[di].t <= b.t ? atr[di - 1] : NaN;
    if (!Number.isFinite(a)) continue;           // no ATR yet -> skip bar
    atrVal = a;
    let bs = a / c.atrDiv;
    if (c.roundTick) bs = Math.round(bs / c.tick) * c.tick;
    brickSize = Math.max(bs, c.tick);
    newBrick = processBar(c, S, b, brickSize);
  }
  if (!S.bricks.length) return { action: "none", reason: "no bricks formed yet (increase HISTORY_BARS?)" };

  // ---- decide (same rules as the cBot)
  const stBull = S.stDir === 1, stBear = S.stDir === -1;
  const entryOk = !c.onBrickCloseOnly || newBrick;
  const longEntry = c.enableLong && entryOk && S.green >= c.greenBuy && (!c.useST || stBull);
  const shortEntry = c.enableShort && entryOk && S.red >= c.redSell && (!c.useST || stBear);
  const longExit = S.red >= c.redExit || (c.exitOnST && stBear);
  const shortExit = S.green >= c.greenCover || (c.exitOnST && stBull);

  const pos = await getPositions(c, s);
  const longs = pos.filter((p) => p.dir === "BUY"), shorts = pos.filter((p) => p.dir === "SELL");
  const posDir = longs.length ? 1 : shorts.length ? -1 : 0;

  let action = "none";
  if (posDir <= 0 && longEntry) action = shorts.length ? "COVER+BUY" : "BUY";
  else if (posDir >= 0 && shortEntry) action = longs.length ? "EXIT+SELL" : "SELL";
  else if (posDir > 0 && longExit) action = "EXIT";
  else if (posDir < 0 && shortExit) action = "COVER";

  const summary = {
    action, dryRun: c.dryRun, epic: c.epic, bricks: S.bricks.length,
    brickSize, atr: atrVal, green: S.green, red: S.red, supertrend: S.stDir,
    position: posDir === 1 ? "LONG" : posDir === -1 ? "SHORT" : "FLAT",
    lastBrick: S.bricks[S.bricks.length - 1],
  };
  console.log(JSON.stringify(summary));

  if (action === "none" || c.dryRun) return summary;

  if (action === "BUY" || action === "COVER+BUY") {
    for (const p of shorts) await closePos(c, s, p);
    await openPos(c, s, "BUY");
  } else if (action === "SELL" || action === "EXIT+SELL") {
    for (const p of longs) await closePos(c, s, p);
    await openPos(c, s, "SELL");
  } else if (action === "EXIT") for (const p of longs) await closePos(c, s, p);
  else if (action === "COVER") for (const p of shorts) await closePos(c, s, p);
  return summary;
}

// ═══════════════════════════════════════════════
//  AUTOPILOT SCALPER BOT — bot.js
//  Runs 24/7 on Railway / VPS
//  Scans Solana every 2 min, manages positions,
//  sends Telegram alerts on every trade event
// ═══════════════════════════════════════════════

import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CONFIG (set via environment variables) ───
const CONFIG = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_ID:   process.env.TELEGRAM_CHAT_ID   || "",
  PAPER_MODE:         process.env.PAPER_MODE !== "false", // default: paper
  POSITION_SIZE_USD:  parseFloat(process.env.POSITION_SIZE_USD || "100"),
  STARTING_BALANCE:   parseFloat(process.env.STARTING_BALANCE  || "1000"),
  SCAN_INTERVAL_MS:   parseInt(process.env.SCAN_INTERVAL_MS    || "120000"), // 2 min
  TRAIL_PCT:          parseFloat(process.env.TRAIL_PCT          || "20"),
  STOP_LOSS_PCT:      parseFloat(process.env.STOP_LOSS_PCT      || "25"),
  MAX_HOLD_MS:        parseInt(process.env.MAX_HOLD_MS          || "1800000"), // 30 min
  MAX_POSITIONS:      parseInt(process.env.MAX_POSITIONS        || "4"),
  STATE_FILE:         path.join(__dirname, "state.json"),
};

// ─── STATE (persisted to disk) ────────────────
let STATE = {
  balance: CONFIG.STARTING_BALANCE,
  positions: [],       // { symbol, name, address, entryPrice, peakPrice, size, entryTime, entryScore, sold3x, sold5x }
  tradeLog: [],        // full history
  scanCount: 0,
  totalPnl: 0,
  wins: 0,
  losses: 0,
  rugsBlocked: 0,
  startedAt: Date.now(),
};

function loadState() {
  try {
    if (fs.existsSync(CONFIG.STATE_FILE)) {
      const raw = fs.readFileSync(CONFIG.STATE_FILE, "utf8");
      STATE = { ...STATE, ...JSON.parse(raw) };
      log("✅ State loaded from disk");
    }
  } catch (e) {
    log("⚠️  Could not load state, starting fresh: " + e.message);
  }
}

function saveState() {
  try {
    fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(STATE, null, 2));
  } catch (e) {
    log("⚠️  Could not save state: " + e.message);
  }
}

// ─── LOGGING ──────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

// ─── TELEGRAM ─────────────────────────────────
async function tg(message) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
    log("📵 Telegram not configured — " + message.slice(0, 80));
    return;
  }
  try {
    await fetch(
      `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CONFIG.TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
        }),
      }
    );
  } catch (e) {
    log("⚠️  Telegram send failed: " + e.message);
  }
}

// ─── RULE ENGINE ──────────────────────────────
function scoreEntry(c) {
  const liq   = c.liquidity?.usd  || 0;
  const vol   = c.volume?.h24      || 0;
  const ch24  = c.priceChange?.h24 || 0;
  const ch1   = c.priceChange?.h1  || 0;
  const mc    = c.marketCap        || 0;
  const ageMs = c.pairCreatedAt ? Date.now() - c.pairCreatedAt : Infinity;

  const rules = [
    { id: "liq",   name: "Liquidity ≥ $30K",       fatal: true,  weight: 25, pass: liq >= 30000 },
    { id: "vol",   name: "Vol ≥ 3× Liquidity",      fatal: false, weight: 20, pass: vol >= liq * 3 },
    { id: "age",   name: "Token < 48h old",          fatal: false, weight: 15, pass: ageMs < 48 * 3600000 },
    { id: "mom",   name: "Momentum +20–400%",        fatal: false, weight: 15, pass: ch24 >= 20 && ch24 <= 400 },
    { id: "mc",    name: "MCap $100K–$5M",           fatal: false, weight: 15, pass: mc >= 100000 && mc <= 5000000 },
    { id: "h1",    name: "Not dumping (1h > -10%)",  fatal: false, weight: 10, pass: ch1 > -10 },
  ];

  const rugs = [
    { id: "r1", name: "Thin liq < $15K",     severity: "FATAL",  flagged: liq < 15000 },
    { id: "r2", name: "Wash trading >50×",   severity: "HIGH",   flagged: liq > 0 && vol / liq > 50 },
    { id: "r3", name: "Ghost MCap < $50K",   severity: "HIGH",   flagged: mc < 50000 },
    { id: "r4", name: "Parabolic >500%",     severity: "MEDIUM", flagged: ch24 > 500 },
    { id: "r5", name: "Active dump -20% 1h", severity: "HIGH",   flagged: ch1 < -20 },
    { id: "r6", name: "Old token pump",      severity: "MEDIUM", flagged: ageMs > 7 * 86400000 && ch24 > 100 },
  ];

  const fatalRug  = rugs.some(r => r.flagged && r.severity === "FATAL");
  const fatalRule = rules.some(r => r.fatal && !r.pass);
  const blocked   = fatalRug || fatalRule;
  const score     = rules.reduce((s, r) => s + (r.pass ? r.weight : 0), 0);
  const maxScore  = rules.reduce((s, r) => s + r.weight, 0);
  const pct       = Math.round((score / maxScore) * 100);
  const rugCount  = rugs.filter(r => r.flagged).length;

  let signal = blocked ? "BLOCK"
    : pct >= 75 ? "STRONG BUY"
    : pct >= 55 ? "BUY"
    : pct >= 35 ? "WATCH"
    : "SKIP";

  return { score: pct, signal, blocked, rules, rugs, rugCount };
}

// ─── DEX DATA FETCH ───────────────────────────
async function fetchSolanaCoins() {
  try {
    // Step 1: Get latest token profiles
    const profileRes = await fetch(
      "https://api.dexscreener.com/token-profiles/latest/v1",
      { headers: { accept: "application/json" }, timeout: 15000 }
    );
    const profiles = await profileRes.json();
    if (!Array.isArray(profiles)) throw new Error("Bad profiles response");

    const solAddrs = profiles
      .filter(p => p.chainId === "solana")
      .slice(0, 40)
      .map(p => p.tokenAddress);

    if (solAddrs.length === 0) throw new Error("No Solana tokens found");

    // Step 2: Fetch pair data in batches of 30
    const batch = solAddrs.slice(0, 30).join(",");
    const pairRes = await fetch(
      `https://api.dexscreener.com/tokens/v1/solana/${batch}`,
      { headers: { accept: "application/json" }, timeout: 15000 }
    );
    const pairs = await pairRes.json();
    if (!Array.isArray(pairs)) throw new Error("Bad pairs response");

    // Deduplicate — keep highest liquidity per token
    const seen = {};
    for (const p of pairs) {
      const addr = p.baseToken?.address;
      if (!addr) continue;
      if (!seen[addr] || (p.liquidity?.usd || 0) > (seen[addr].liquidity?.usd || 0)) {
        seen[addr] = p;
      }
    }
    return Object.values(seen);
  } catch (e) {
    log("⚠️  Fetch error: " + e.message);
    return [];
  }
}

// ─── JUPITER SWAP (live mode only) ────────────
async function executeJupiterSwap(tokenAddress, amountUSD, action = "BUY") {
  // In paper mode this is never called
  // In live mode: integrate Jupiter API + wallet signing here
  // Requires: @solana/web3.js, @jup-ag/core, wallet keypair from env
  log(`🔴 LIVE SWAP: ${action} ${tokenAddress} for $${amountUSD} — integrate Jupiter SDK here`);
  return { success: false, reason: "Jupiter integration placeholder — see LIVE_SETUP.md" };
}

// ─── POSITION MANAGER ─────────────────────────
async function checkExits(coins) {
  const now = Date.now();
  const toRemove = [];

  for (let i = 0; i < STATE.positions.length; i++) {
    const pos = STATE.positions[i];
    const coin = coins.find(c => c.baseToken?.address === pos.address || c.baseToken?.symbol === pos.symbol);

    // If coin disappeared from feed (possible rug) treat as stop-loss
    const currentPrice = coin ? parseFloat(coin.priceUsd) : pos.entryPrice * 0.5;
    const pct     = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const mult    = currentPrice / pos.entryPrice;
    const heldMs  = now - pos.entryTime;
    const peak    = Math.max(pos.peakPrice || pos.entryPrice, currentPrice);
    const trail   = peak * (1 - CONFIG.TRAIL_PCT / 100);

    // Update peak
    STATE.positions[i].peakPrice = peak;
    STATE.positions[i].currentPct = pct;

    let exitReason = null;
    let exitFraction = 1;

    if (pct <= -CONFIG.STOP_LOSS_PCT) {
      exitReason = `🛑 Stop-loss at ${pct.toFixed(1)}%`;
      exitFraction = 1;
    } else if (heldMs > CONFIG.MAX_HOLD_MS && Math.abs(pct) < 15) {
      exitReason = `⏱ 30-min timeout (flat at ${pct.toFixed(1)}%)`;
      exitFraction = 1;
    } else if (currentPrice <= trail && mult > 1.5) {
      exitReason = `📉 Trailing stop (peak was ${(peak / pos.entryPrice).toFixed(2)}×)`;
      exitFraction = 1;
    } else if (mult >= 10 && !pos.sold10x) {
      exitReason = `🏆 10× TARGET HIT — FULL EXIT`;
      exitFraction = 1;
      STATE.positions[i].sold10x = true;
    } else if (mult >= 5 && !pos.sold5x) {
      exitReason = `🎯 5× hit — selling 50%`;
      exitFraction = 0.5;
      STATE.positions[i].sold5x = true;
    } else if (mult >= 3 && !pos.sold3x) {
      exitReason = `✅ 3× hit — selling 25%`;
      exitFraction = 0.25;
      STATE.positions[i].sold3x = true;
    }

    if (exitReason) {
      const sizeOut  = pos.size * exitFraction;
      const exitVal  = sizeOut * mult;
      const pnl      = exitVal - sizeOut;

      STATE.balance += exitVal;
      STATE.totalPnl += pnl;
      if (pnl >= 0) STATE.wins++; else STATE.losses++;

      const logEntry = {
        type:       "EXIT",
        symbol:     pos.symbol,
        entryPrice: pos.entryPrice,
        exitPrice:  currentPrice,
        size:       sizeOut,
        pnl:        parseFloat(pnl.toFixed(2)),
        pnlPct:     parseFloat(pct.toFixed(1)),
        mult:       parseFloat(mult.toFixed(2)),
        reason:     exitReason,
        holdMin:    Math.round(heldMs / 60000),
        time:       now,
        entryScore: pos.entryScore,
      };
      STATE.tradeLog.unshift(logEntry);

      // Telegram alert
      const emoji = pnl >= 0 ? "🟢" : "🔴";
      await tg(
`${emoji} <b>EXIT — ${pos.symbol}</b>
${CONFIG.PAPER_MODE ? "📝 PAPER MODE" : "💰 LIVE TRADE"}

💵 P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${pct.toFixed(1)}%)
📈 Multiplier: ${mult.toFixed(2)}×
⏱ Held: ${Math.round(heldMs / 60000)} min
📌 Reason: ${exitReason}
💰 Balance: $${STATE.balance.toFixed(2)}
🏆 Total P&L: ${STATE.totalPnl >= 0 ? "+" : ""}$${STATE.totalPnl.toFixed(2)}`
      );

      if (!CONFIG.PAPER_MODE) {
        await executeJupiterSwap(pos.address, sizeOut, "SELL");
      }

      if (exitFraction === 1) toRemove.push(i);

      log(`EXIT ${pos.symbol} | ${pct.toFixed(1)}% | ${mult.toFixed(2)}× | ${exitReason}`);
    }
  }

  // Remove fully exited positions (reverse to preserve indices)
  for (const i of toRemove.reverse()) STATE.positions.splice(i, 1);
}

async function checkEntries(coins) {
  if (STATE.positions.length >= CONFIG.MAX_POSITIONS) return;
  if (STATE.balance < CONFIG.POSITION_SIZE_USD) return;

  for (const coin of coins) {
    if (STATE.positions.length >= CONFIG.MAX_POSITIONS) break;
    if (STATE.balance < CONFIG.POSITION_SIZE_USD) break;

    const sym    = coin.baseToken?.symbol;
    const addr   = coin.baseToken?.address;
    if (!sym || !addr) continue;

    // Already in position?
    if (STATE.positions.some(p => p.address === addr || p.symbol === sym)) continue;

    const { signal, score, blocked, rugCount } = scoreEntry(coin);
    if (blocked || (signal !== "STRONG BUY" && signal !== "BUY")) continue;

    const price = parseFloat(coin.priceUsd);
    if (!price || isNaN(price)) continue;

    // ENTER
    STATE.balance -= CONFIG.POSITION_SIZE_USD;
    const pos = {
      symbol:     sym,
      name:       coin.baseToken?.name || sym,
      address:    addr,
      entryPrice: price,
      peakPrice:  price,
      currentPct: 0,
      size:       CONFIG.POSITION_SIZE_USD,
      entryTime:  Date.now(),
      entryScore: score,
      sold3x:     false,
      sold5x:     false,
      sold10x:    false,
    };
    STATE.positions.push(pos);

    const logEntry = {
      type:       "ENTRY",
      symbol:     sym,
      entryPrice: price,
      size:       CONFIG.POSITION_SIZE_USD,
      pnl:        null,
      reason:     `Signal: ${signal} | Score: ${score}/100 | Rug flags: ${rugCount}`,
      time:       Date.now(),
      entryScore: score,
    };
    STATE.tradeLog.unshift(logEntry);

    await tg(
`⚡ <b>ENTRY — ${sym}</b>
${CONFIG.PAPER_MODE ? "📝 PAPER MODE" : "💰 LIVE TRADE"}

💵 Size: $${CONFIG.POSITION_SIZE_USD}
📊 Signal: ${signal} (${score}/100)
💲 Price: $${price.toExponential(3)}
🛡 Rug flags: ${rugCount}/6
🎯 Exit plan: Trail ${CONFIG.TRAIL_PCT}% | Stop -${CONFIG.STOP_LOSS_PCT}%
💰 Balance: $${STATE.balance.toFixed(2)}`
    );

    if (!CONFIG.PAPER_MODE) {
      await executeJupiterSwap(addr, CONFIG.POSITION_SIZE_USD, "BUY");
    }

    log(`ENTRY ${sym} | score=${score} | signal=${signal} | price=${price}`);
  }
}

// ─── MAIN SCAN LOOP ───────────────────────────
async function scan() {
  STATE.scanCount++;
  log(`\n🔍 SCAN #${STATE.scanCount} — ${new Date().toLocaleTimeString()}`);

  const coins = await fetchSolanaCoins();
  log(`   Found ${coins.length} Solana pairs`);

  if (coins.length > 0) {
    await checkExits(coins);
    await checkEntries(coins);
  }

  // Log summary every 10 scans
  if (STATE.scanCount % 10 === 0) {
    const wr = STATE.wins + STATE.losses > 0
      ? Math.round((STATE.wins / (STATE.wins + STATE.losses)) * 100)
      : 0;
    await tg(
`📊 <b>10-SCAN SUMMARY</b>
🔍 Total scans: ${STATE.scanCount}
💰 Balance: $${STATE.balance.toFixed(2)}
📈 Total P&L: ${STATE.totalPnl >= 0 ? "+" : ""}$${STATE.totalPnl.toFixed(2)}
🏆 Win rate: ${wr}%
🟢 Wins: ${STATE.wins} | 🔴 Losses: ${STATE.losses}
📂 Open positions: ${STATE.positions.length}
🛡 Rugs blocked: ${STATE.rugsBlocked}`
    );
  }

  saveState();
}

// ─── BOOT ─────────────────────────────────────
async function main() {
  console.log(`
╔═══════════════════════════════════════╗
║     AUTOPILOT SCALPER BOT v1.0        ║
║     Solana Meme Coin Engine           ║
╚═══════════════════════════════════════╝
Mode:          ${CONFIG.PAPER_MODE ? "📝 PAPER (simulation)" : "💰 LIVE TRADING"}
Position size: $${CONFIG.POSITION_SIZE_USD}
Scan interval: ${CONFIG.SCAN_INTERVAL_MS / 1000}s
Trail stop:    ${CONFIG.TRAIL_PCT}%
Hard stop:     ${CONFIG.STOP_LOSS_PCT}%
Max hold:      ${CONFIG.MAX_HOLD_MS / 60000} min
Max positions: ${CONFIG.MAX_POSITIONS}
  `);

  loadState();

  await tg(
`🤖 <b>AUTOPILOT BOT STARTED</b>
Mode: ${CONFIG.PAPER_MODE ? "📝 Paper" : "💰 LIVE"}
Balance: $${STATE.balance.toFixed(2)}
Scanning every ${CONFIG.SCAN_INTERVAL_MS / 1000}s
Rules: 6 entry + 6 rug checks active`
  );

  // First scan immediately
  await scan();

  // Then every N ms
  setInterval(scan, CONFIG.SCAN_INTERVAL_MS);
}

main().catch(e => {
  log("💥 Fatal error: " + e.message);
  process.exit(1);
});

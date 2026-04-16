# AUTOPILOT SCALPER BOT — Complete Setup Guide

## What this bot does
- Scans Solana meme coins every 2 minutes, 24/7
- Scores every coin using 6 entry rules + 6 rug-pull checks
- Auto-enters positions when score ≥ 55 (BUY) or ≥ 75 (STRONG BUY)
- Auto-exits via trailing stop, stop-loss, 3×/5×/10× ladder
- Saves all state to disk (survives restarts)
- Sends Telegram alerts for every entry, exit and 10-scan summary

---

## STEP 1 — Set up Telegram alerts (10 min)

1. Open Telegram → search **@BotFather** → send `/newbot`
2. Follow prompts → it gives you a **token** like `1234567890:ABCdef...`
3. Open Telegram → search **@userinfobot** → send `/start`
4. It replies with your **Chat ID** like `987654321`
5. Save both — you'll need them in Step 3

---

## STEP 2 — Deploy to Railway (free, 5 min)

Railway gives you a free cloud server that runs 24/7.

1. Go to **railway.app** → sign up with GitHub
2. Click **New Project** → **Deploy from GitHub repo**
3. Push this folder to a GitHub repo first:
   ```bash
   git init
   git add .
   git commit -m "autopilot bot"
   gh repo create autopilot-bot --private --push
   ```
4. Connect the repo in Railway → it auto-detects Node.js

---

## STEP 3 — Set environment variables in Railway

In your Railway project → click **Variables** tab → add these:

| Variable | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | your token from Step 1 |
| `TELEGRAM_CHAT_ID` | your chat ID from Step 1 |
| `PAPER_MODE` | `true` (start here!) |
| `POSITION_SIZE_USD` | `100` |
| `STARTING_BALANCE` | `1000` |
| `SCAN_INTERVAL_MS` | `120000` |
| `TRAIL_PCT` | `20` |
| `STOP_LOSS_PCT` | `25` |
| `MAX_HOLD_MS` | `1800000` |
| `MAX_POSITIONS` | `4` |

Click **Deploy** — the bot starts immediately.

---

## STEP 4 — Watch it work

Within 2 minutes you'll get a Telegram message:
```
🤖 AUTOPILOT BOT STARTED
Mode: 📝 Paper
Balance: $1000.00
Scanning every 120s
```

Then for every trade:
```
⚡ ENTRY — PEPEFROG
📝 PAPER MODE

💵 Size: $100
📊 Signal: STRONG BUY (82/100)
💲 Price: $4.12e-5
🛡 Rug flags: 0/6
🎯 Exit plan: Trail 20% | Stop -25%
💰 Balance: $900.00
```

---

## STEP 5 — Going LIVE (only after 48h+ paper success)

### Prerequisites
- Win rate ≥ 50% in paper mode
- You understand every exit rule
- You have a dedicated trading wallet (NOT your main wallet)

### Setup
1. Create a new Solana wallet in Phantom
2. Fund it with a small amount ($200–500 max to start)
3. Export the private key (Settings → Security → Export Private Key)
4. In Railway Variables, add:
   ```
   PAPER_MODE=false
   WALLET_PRIVATE_KEY=your_private_key_here
   ```
5. The bot will execute real swaps via Jupiter API

### ⚠️ Live trading checklist
- [ ] Dedicated wallet only (never main wallet)
- [ ] Max $500 starting capital
- [ ] You have read every rule in bot.js
- [ ] Win rate > 50% in paper mode
- [ ] You accept 100% loss is possible

---

## State persistence

The bot saves `state.json` every scan. If Railway restarts:
- Balance is restored
- All open positions are restored
- Full trade log is restored
- Nothing is lost

---

## Monitoring

### Logs
In Railway → click your service → **Logs** tab
You'll see every scan in real time:
```
[2025-04-16T03:12:00.000Z] 🔍 SCAN #47 — 3:12:00 AM
[2025-04-16T03:12:02.000Z]    Found 28 Solana pairs
[2025-04-16T03:12:03.000Z] ENTRY MOONCAT | score=78 | signal=BUY | price=0.000821
```

### Telegram
Every entry, exit, and 10-scan summary sent directly to you.

---

## Troubleshooting

**Bot not sending Telegram messages**
→ Double-check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in Railway Variables
→ Make sure you messaged your bot at least once first

**No trades being entered**
→ Normal — the rule engine is strict. Bad market = no signal = no trade
→ Check logs to see coin scores

**Bot crashed**
→ Railway auto-restarts on failure
→ State is saved so nothing lost

**Want faster scanning**
→ Change SCAN_INTERVAL_MS to 60000 (1 min)

---

## Cost

| Service | Cost |
|---|---|
| Railway hobby plan | Free (500 hours/month) or $5/month unlimited |
| DexScreener API | Free |
| Jupiter API | Free (charges gas on-chain) |
| Telegram Bot API | Free |

**Total: $0–5/month**

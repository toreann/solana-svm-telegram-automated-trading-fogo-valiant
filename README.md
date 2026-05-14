# Valiant Telegram-Controlled Trade Bot

Version: `0.1.2`

Local TypeScript bot that:

- reads Telegram signals from one source chat using a Telegram user session,
- filters allowed senders,
- parses `NOVO SINAL` and `LUCRO` templates,
- executes Valiant perps via a hybrid adapter,
- exposes control and notifications through a private Telegram bot.
- preserves signal entry, TP, and SL decimals while keeping the 3.5% minimum SL guardrail.

## Setup

1. Create either `.env` or `env.env`.
2. Fill in these required values in the env file:
   - `TELEGRAM_API_ID`
   - `TELEGRAM_API_HASH`
   - `CONTROL_BOT_TOKEN`
   - `CONTROL_OWNER_CHAT_ID`
   - `CONTROL_OWNER_USER_ID`
   - `TELEGRAM_SIGNAL_CHAT_ID` (optional while discovering the source chat)
3. Optional Valiant credentials in the env file:
   - `VALIANT_AGENT_KEY`
   - `VALIANT_MASTER_ACCOUNT_ADDRESS`
   - `VALIANT_PRIVATE_API_BASE_URL`
   - `VALIANT_PRIVATE_API_KEY` (legacy / optional)
   - `VALIANT_PRIVATE_API_SECRET` (legacy / optional)
   - `VALIANT_PLAYWRIGHT_EXECUTABLE_PATH` (optional Brave/Chrome/Chromium path)
   - `VALIANT_PLAYWRIGHT_CDP_URL` (recommended when reusing a live Brave/Chrome session)
   - `VALIANT_PLAYWRIGHT_HEADLESS` (`true` by default)
   - `VALIANT_PLAYWRIGHT_PROFILE_DIR` (persistent browser profile used by Playwright)
   - `VALIANT_MARKET_ROUTE` (supports `/perps/{symbol}` or `/perps/:symbol`)
4. Install dependencies:

```bash
npm install
```

## Brave Local Mode

Run Brave in local debugging mode before starting the bot:

```bash
/snap/bin/brave \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --user-data-dir="/home/obakex/tellegramautotrade/telegram-trading-bot-svmfogo-valiant/playwright-profile" \
  https://valiant.trade/perps
```

Keep this env value pointed at Brave's local DevTools endpoint:

```env
VALIANT_PLAYWRIGHT_CDP_URL=http://127.0.0.1:9222
```

Do not set `VALIANT_PLAYWRIGHT_CDP_URL` to `https://valiant.trade/perps`; that URL belongs in the Brave launch command.

## Telegram Session Login

Generate and save the Telegram user session that reads the signal chat:

```bash
npm run auth:telegram
```

This writes the session string to `secrets/telegram.session`.

## Run

Start in safe dry-run mode first:

```bash
npm run dev
```

If `TELEGRAM_SIGNAL_CHAT_ID` is blank, the bot starts in discovery mode and logs each observed Telegram `chatId` plus sender info so you can copy the correct values into your env file.

## Start on Linux Login

Install the user `systemd` services:

```bash
./scripts/install-startup-service.sh
```

This installs and starts:

- `valiant-brave.service`, which opens Brave/Chromium with the local debugging port.
- `telegram-trading-bot.service`, which builds the TypeScript app and runs `npm start`.

The Brave service removes stale Chromium profile locks before launch, waits for port `9222`
to open, and stays active while that debug port is available. This prevents silent startup
success when Brave exits without exposing the DevTools endpoint.

Check logs:

```bash
journalctl --user -u telegram-trading-bot.service -f
journalctl --user -u valiant-brave.service -f
```

Stop automatic startup:

```bash
./scripts/uninstall-startup-service.sh
```

By default these user services start when you log in. This is the recommended mode when
the bot depends on an unlocked Brave desktop session. If you want services to start before
login, enable linger:

```bash
sudo loginctl enable-linger "$USER"
```

Only enable linger if your Valiant setup does not require an unlocked desktop/browser session.

## Valiant Private Transport

- With `VALIANT_MASTER_ACCOUNT_ADDRESS` configured, the bot treats the live Valiant browser session as the source of truth for the currently approved agent.
- `VALIANT_AGENT_KEY` is now a fallback only. It is still useful as an emergency backup, but the bot no longer treats it as authoritative when a live approved browser agent is available.
- For the most reliable setup, launch Brave/Chrome with the same `VALIANT_PLAYWRIGHT_PROFILE_DIR` and a live debugging port, then set `VALIANT_PLAYWRIGHT_CDP_URL` to that endpoint.
- The bot now signs orders directly against the Hyperliquid exchange transport that backs Valiant.
- If `VALIANT_PRIVATE_API_BASE_URL` is blank, the app defaults to `https://api.hyperliquid.xyz`.
- Legacy `VALIANT_PRIVATE_API_KEY` and `VALIANT_PRIVATE_API_SECRET` remain optional helpers, but live order execution no longer depends on the old `/orders/...` Valiant REST assumption.

## Valiant Playwright Fallback

- `VALIANT_EXECUTION_MODE=playwright` uses a persistent browser profile to trade through the Valiant web UI.
- `VALIANT_EXECUTION_MODE=hybrid` still tries the private transport first and falls back to Playwright if the private request fails.
- The browser profile in `VALIANT_PLAYWRIGHT_PROFILE_DIR` must already be signed into Valiant and have perps enabled.
- If your Valiant wallet/agent rotates on page reload, keep a live browser session running and expose it through `VALIANT_PLAYWRIGHT_CDP_URL` so the bot can rediscover the current approved agent before trading.
- If Playwright cannot find your browser automatically, set `VALIANT_PLAYWRIGHT_EXECUTABLE_PATH` to the Brave, Chrome, or Chromium binary.
- The Playwright flow places market entries, then attempts to configure TP/SL and reduction actions through the Positions tab.
- For cleaner symbol targeting, set `VALIANT_MARKET_ROUTE=/perps/{symbol}` if your Valiant deployment supports symbol-specific routes.

## Live Browser Monitoring

- In `private` and `hybrid` mode, the bot checks the live Brave/Chrome Valiant session every minute when `VALIANT_MASTER_ACCOUNT_ADDRESS` is set.
- If the live browser session stops exposing a decryptable Valiant wallet for the configured master account, the control bot sends a Telegram alert with the title `Brave wallet disconnected`.
- This check relies on a reachable live debugging endpoint, so keep the browser session behind `VALIANT_PLAYWRIGHT_CDP_URL` running.

## Telegram Control Bot

- The main menu shows the perps account balance from Hyperliquid `totalRawUsd`, not open position notional.
- Retryable entry failures include a `Retry positioning` button that replays the original entry signal.
- Position controls can close positions, move SL to entry, reapply TP/SL, or reapply an entry when no live position exists.

## Entry Risk Guardrails

- Entry signals now enforce a minimum stop-loss distance of 3.5% from the entry price.
- For `LONG` entries, if the incoming SL is closer than 3.5% below entry, the bot widens it to exactly 3.5% below entry.
- For `SHORT` entries, if the incoming SL is closer than 3.5% above entry, the bot widens it to exactly 3.5% above entry.
- When this happens, the Telegram entry notification includes both the original SL and the adjusted SL.
- Entry, TP, and SL values are otherwise parsed and submitted with their incoming decimal precision instead of being rounded to whole numbers.

## Release Notes

### 0.1.2

- Preserve intended signal exposure when the exchange applies lower leverage by scaling margin proportionally.
- Show requested leverage, applied leverage, and adjusted margin in entry notifications.
- Compare live stop-loss confirmations using Hyperliquid tick formatting when available.

### 0.1.1

- Preserve incoming Entry, TP, and SL decimals from Telegram signals.
- Keep the 3.5% minimum stop-loss distance guardrail.
- Show perps account balance in Telegram instead of open trade notional.
- Add retry-positioning controls for failed entry placement.
- Add user systemd startup services and a Brave debug launcher that verifies port `9222`.

## Important Notes

- `VALIANT_EXECUTION_MODE=dry-run` is the safe default.
- `hybrid` mode tries private transport first and then Playwright.
- The control bot sends notifications to `CONTROL_OWNER_CHAT_ID` using `CONTROL_BOT_TOKEN`.
- `.env`, `secrets/`, `data/`, and browser profiles are ignored by Git.
- When Playwright fails, it saves a screenshot under `playwright-profile/debug-artifacts/` to make debugging easier.

# Valiant Telegram-Controlled Trade Bot

Local TypeScript bot that:

- reads Telegram signals from one source chat using a Telegram user session,
- filters allowed senders,
- parses `NOVO SINAL` and `LUCRO` templates,
- executes Valiant perps via a hybrid adapter,
- exposes control and notifications through a private Telegram bot.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill in these required values in `.env`:
   - `TELEGRAM_API_ID`
   - `TELEGRAM_API_HASH`
   - `CONTROL_BOT_TOKEN`
   - `CONTROL_OWNER_CHAT_ID`
   - `CONTROL_OWNER_USER_ID`
   - `TELEGRAM_SIGNAL_CHAT_ID`
3. Optional Valiant credentials in `.env`:
   - `VALIANT_AGENT_KEY`
   - `VALIANT_PRIVATE_API_BASE_URL`
   - `VALIANT_PRIVATE_API_KEY`
   - `VALIANT_PRIVATE_API_SECRET`
4. Install dependencies:

```bash
npm install
```

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

## Important Notes

- `VALIANT_EXECUTION_MODE=dry-run` is the safe default.
- `hybrid` mode tries private transport first and then Playwright.
- The control bot sends notifications to `CONTROL_OWNER_CHAT_ID` using `CONTROL_BOT_TOKEN`.
- `.env`, `secrets/`, `data/`, and browser profiles are ignored by Git.
- The Playwright path still needs the real Valiant UI selectors and workflow from a live session.

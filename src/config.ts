import { existsSync } from "node:fs";

import { config as loadDotenv } from "dotenv";
import { z } from "zod";

import type { AppConfig, RuntimeConfig } from "./types.js";

const discoveredEnvFiles: string[] = [];

for (const path of [".env", "env.env"]) {
  if (!existsSync(path)) {
    continue;
  }
  loadDotenv({ path, override: false });
  discoveredEnvFiles.push(path);
}

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_PATH: z.string().default("./data/tradebot.db"),
  TELEGRAM_API_ID: z.coerce.number().int().positive(),
  TELEGRAM_API_HASH: z.string().min(1),
  TELEGRAM_SESSION_FILE: z.string().default("./secrets/telegram.session"),
  TELEGRAM_SIGNAL_CHAT_ID: z.string().default(""),
  TELEGRAM_ALLOWED_SENDER_IDS: z.string().default(""),
  TELEGRAM_ALLOWED_SENDER_LABELS: z.string().default("@MacacoClub_bot,Mr. Robot"),
  CONTROL_BOT_TOKEN: z.string().min(1),
  CONTROL_OWNER_CHAT_ID: z.string().min(1),
  CONTROL_OWNER_USER_ID: z.string().min(1),
  SYMBOL_WHITELIST: z.string().default("SOL,BNB,BTC,ETH"),
  DEFAULT_MARGIN_PER_TRADE: z.coerce.number().positive().default(25),
  DEFAULT_MAX_LEVERAGE_CAP: z.coerce.number().positive().default(20),
  DEFAULT_PROFIT_PARTIAL_CLOSE_PERCENT: z.coerce.number().gt(0).lte(100).default(25),
  DRY_RUN: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() === "true"),
  PAUSED: z
    .string()
    .default("false")
    .transform((value) => value.toLowerCase() === "true"),
  VALIANT_EXECUTION_MODE: z
    .enum(["dry-run", "private", "playwright", "hybrid"])
    .default("dry-run"),
  VALIANT_BASE_URL: z.string().default("https://valiant.trade"),
  VALIANT_AGENT_KEY: z.string().optional(),
  VALIANT_PRIVATE_API_BASE_URL: z.string().optional(),
  VALIANT_PRIVATE_API_KEY: z.string().optional(),
  VALIANT_PRIVATE_API_SECRET: z.string().optional(),
  VALIANT_PLAYWRIGHT_EXECUTABLE_PATH: z.string().optional(),
  VALIANT_PLAYWRIGHT_HEADLESS: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() !== "false"),
  VALIANT_PLAYWRIGHT_PROFILE_DIR: z.string().default("./playwright-profile"),
  VALIANT_MARKET_ROUTE: z.string().default("/perps")
});

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getLoadedEnvFiles(): string[] {
  return [...discoveredEnvFiles];
}

export function loadConfig(): AppConfig {
  const env = envSchema.parse(process.env);
  const defaultRuntimeConfig: RuntimeConfig = {
    marginPerTrade: env.DEFAULT_MARGIN_PER_TRADE,
    maxLeverageCap: env.DEFAULT_MAX_LEVERAGE_CAP,
    profitPartialClosePercent: env.DEFAULT_PROFIT_PARTIAL_CLOSE_PERCENT,
    paused: env.PAUSED,
    dryRun: env.DRY_RUN
  };

  return {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    databasePath: env.DATABASE_PATH,
    telegramApiId: env.TELEGRAM_API_ID,
    telegramApiHash: env.TELEGRAM_API_HASH,
    telegramSessionFile: env.TELEGRAM_SESSION_FILE,
    telegramSignalChatId: env.TELEGRAM_SIGNAL_CHAT_ID,
    telegramAllowedSenderIds: splitCsv(env.TELEGRAM_ALLOWED_SENDER_IDS),
    telegramAllowedSenderLabels: splitCsv(env.TELEGRAM_ALLOWED_SENDER_LABELS),
    controlBotToken: env.CONTROL_BOT_TOKEN,
    controlOwnerChatId: env.CONTROL_OWNER_CHAT_ID,
    controlOwnerUserId: env.CONTROL_OWNER_USER_ID,
    symbolWhitelist: splitCsv(env.SYMBOL_WHITELIST).map((value) => value.toUpperCase()),
    defaultRuntimeConfig,
    valiantExecutionMode: env.VALIANT_EXECUTION_MODE,
    valiantBaseUrl: env.VALIANT_BASE_URL,
    valiantAgentKey: env.VALIANT_AGENT_KEY,
    valiantPrivateApiBaseUrl: env.VALIANT_PRIVATE_API_BASE_URL,
    valiantPrivateApiKey: env.VALIANT_PRIVATE_API_KEY,
    valiantPrivateApiSecret: env.VALIANT_PRIVATE_API_SECRET,
    valiantPlaywrightExecutablePath: env.VALIANT_PLAYWRIGHT_EXECUTABLE_PATH,
    valiantPlaywrightHeadless: env.VALIANT_PLAYWRIGHT_HEADLESS,
    valiantPlaywrightProfileDir: env.VALIANT_PLAYWRIGHT_PROFILE_DIR,
    valiantMarketRoute: env.VALIANT_MARKET_ROUTE
  };
}

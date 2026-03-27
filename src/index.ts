import { getLoadedEnvFiles, loadConfig } from "./config.js";
import { AppDatabase } from "./db.js";
import { createLogger } from "./logger.js";
import { Notifier } from "./notifier.js";
import { TradeOrchestrator } from "./orchestrator.js";
import { SenderFilter } from "./signals/senderFilter.js";
import { TelegramControlBot } from "./telegram/controlBot.js";
import { TelegramSignalIngestor } from "./telegram/signalIngestor.js";
import { HybridValiantExecutor, inferValiantPrivateApiBaseUrl } from "./trading/valiantExecutor.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const loadedEnvFiles = getLoadedEnvFiles();
  const inferredPrivateApiBaseUrl = inferValiantPrivateApiBaseUrl(
    config.valiantPrivateApiBaseUrl,
    config.valiantBaseUrl
  );
  const database = await AppDatabase.open(config.databasePath, config.defaultRuntimeConfig);
  const senderFilter = new SenderFilter(database, config.telegramAllowedSenderIds, config.telegramAllowedSenderLabels);
  const executor = new HybridValiantExecutor(config);
  const controlBot = new TelegramControlBot(
    config.controlBotToken,
    config.controlOwnerChatId,
    config.controlOwnerUserId,
    database,
    logger
  );
  const notifier = new Notifier(database, controlBot.bot, config.controlOwnerChatId);
  const orchestrator = new TradeOrchestrator(config, database, executor, notifier, logger);
  controlBot.attachOrchestrator(orchestrator);
  const ingestor = new TelegramSignalIngestor(config, senderFilter, orchestrator, logger);

  logger.info(
    {
      envFiles: loadedEnvFiles.length > 0 ? loadedEnvFiles : undefined,
      signalChatId: config.telegramSignalChatId || null,
      allowedSenderIdsConfigured: config.telegramAllowedSenderIds.length,
      allowedSenderLabelsConfigured: config.telegramAllowedSenderLabels.length,
      executionMode: config.valiantExecutionMode,
      privateApiBaseUrl: inferredPrivateApiBaseUrl,
      privateAuthMode: config.valiantAgentKey ? "agent-key" : "legacy-or-none"
    },
    config.telegramSignalChatId
      ? "Configuration loaded"
      : "Configuration loaded in Telegram chat discovery mode"
  );

  await ingestor.connect();

  await controlBot.launch();
  await notifier.notify({
    type: "INFO",
    title: "Trade Bot started",
    body: "Trade Bot started and listening for signals.",
    dedupeKey: `startup:${new Date().toISOString().slice(0, 16)}`
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    await ingestor.disconnect();
    controlBot.stop(signal);
    database.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

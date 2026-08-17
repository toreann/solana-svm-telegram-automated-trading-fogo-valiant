import { getLoadedEnvFiles, loadConfig } from "./config.js";
import { AppDatabase } from "./db.js";
import { createLogger } from "./logger.js";
import { Notifier } from "./notifier.js";
import { TradeOrchestrator } from "./orchestrator.js";
import { SenderFilter } from "./signals/senderFilter.js";
import { TelegramControlBot } from "./telegram/controlBot.js";
import { TelegramSignalIngestor } from "./telegram/signalIngestor.js";
import {
  HybridValiantExecutor,
  inferValiantPrivateApiBaseUrl
} from "./trading/valiantExecutor.js";
import { newId } from "./utils.js";

const EXCHANGE_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const HEALTHY_RUN_DELAY_MS = 5 * 60 * 1000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const loadedEnvFiles = getLoadedEnvFiles();
  const inferredPrivateApiBaseUrl = inferValiantPrivateApiBaseUrl(
    config.valiantPrivateApiBaseUrl,
    config.valiantBaseUrl
  );
  const database = await AppDatabase.open(config.databasePath, config.defaultRuntimeConfig);
  const runId = newId();
  const runStart = database.beginBotRun(runId);
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
  const ingestor = new TelegramSignalIngestor(config, senderFilter, orchestrator, logger, notifier);

  logger.info(
    {
      envFiles: loadedEnvFiles.length > 0 ? loadedEnvFiles : undefined,
      signalChatId: config.telegramSignalChatId || null,
      allowedSenderIdsConfigured: config.telegramAllowedSenderIds.length,
      allowedSenderLabelsConfigured: config.telegramAllowedSenderLabels.length,
      executionMode: config.valiantExecutionMode,
      privateApiBaseUrl: inferredPrivateApiBaseUrl,
      walletCheckIntervalMinutes: config.valiantWalletCheckIntervalMinutes,
      privateAuthMode: config.valiantMasterAccountAddress ? "dynamic-agent-session" : config.valiantAgentKey ? "env-fallback-agent-key" : "legacy-or-none"
    },
    config.telegramSignalChatId
      ? "Configuration loaded"
      : "Configuration loaded in Telegram chat discovery mode"
  );

  await ingestor.connect();

  controlBot.launch((error) => {
    logger.fatal({ error }, "Control bot polling failed");
    process.exit(1);
  });
  if (runStart.shouldAlert && runStart.incidentId) {
    await notifier.notify({
      type: "ERROR",
      title: "Trade Bot restart loop detected",
      body: [
        `The bot failed to remain healthy ${runStart.failedStarts} times within ten minutes.`,
        "Automatic restart delays will increase up to ten minutes while recovery is attempted.",
        `Incident: ${runStart.incidentId}`
      ].join("\n"),
      dedupeKey: `restart-loop:${runStart.incidentId}`
    });
    database.markIncidentAlertSent(runStart.incidentId);
  }

  try {
    const agentStatus = await orchestrator.syncAgentSession();
    logger.info({ agentStatus }, "Agent session synchronized at startup");
    if (config.valiantExecutionMode === "private" || config.valiantExecutionMode === "hybrid") {
      const previousTradingState = database.getOperationalState("agent_trading_state");
      database.setOperationalState("agent_trading_state", agentStatus.tradingState);
      if (agentStatus.tradingState === "BLOCKED" && previousTradingState !== "BLOCKED") {
        const incidentId = newId();
        database.setOperationalState("agent_blocked_incident_id", incidentId);
        await notifier.notify({
          type: "ERROR",
          title: "Trading blocked - Valiant agent required",
          body: [
            `Trading state: ${agentStatus.tradingState}`,
            `Approval status: ${agentStatus.approvalStatus}`,
            `Master account: ${agentStatus.masterAccountAddress ?? "n/a"}`,
            `Approved exchange agent: ${agentStatus.approvedAgentAddress ?? "n/a"}`,
            `Active in-memory agent: ${agentStatus.activeAgentAddress ?? "n/a"}`,
            `Env fallback agent: ${agentStatus.envFallbackAgentAddress ?? "n/a"}`,
            `Last error: ${agentStatus.lastError ?? "none"}`
          ].join("\n"),
          dedupeKey: `agent-blocked:${incidentId}`
        });
      }
    }
  } catch (error) {
    logger.warn({ error }, "Startup agent health check failed");
  }

  const runExchangeSync = async (reason: string) => {
    try {
      await orchestrator.syncPositionsFromExchange({ notify: true, reason });
    } catch (error) {
      logger.error({ error, reason }, "Exchange sync failed");
      await notifier.notify({
        type: "ERROR",
        title: "Exchange sync failed",
        body: `Reason: ${reason}\n\n${String(error)}`,
        dedupeKey: `sync-error:${reason}:${new Date().toISOString().slice(0, 16)}`
      });
    }
  };

  const runLiveBrowserWalletCheck = async (reason: string) => {
    if (!config.valiantMasterAccountAddress) {
      return;
    }
    if (config.valiantExecutionMode !== "private" && config.valiantExecutionMode !== "hybrid") {
      return;
    }

    const probe = await executor.getBrowserWalletStatus();
    logger.info({ probe, reason }, "Live Brave wallet session checked");

    if (probe.connected) {
      database.setOperationalState("browser_wallet_health", "healthy");
      return;
    }

    const previousHealth = database.getOperationalState("browser_wallet_health");
    database.setOperationalState("browser_wallet_health", "unhealthy");
    if (previousHealth === "unhealthy" || database.getOperationalState("agent_trading_state") === "BLOCKED") {
      return;
    }

    const incidentId = newId();
    database.setOperationalState("browser_wallet_incident_id", incidentId);
    await notifier.notify({
      type: "ERROR",
      title: "Brave wallet disconnected",
      body: [
        "The live Brave session is no longer exposing a usable Valiant wallet session.",
        "An already-loaded and still-approved agent may continue trading, but a cold restart will require wallet sign-in.",
        `Reason: ${probe.reason ?? "unknown"}`,
        `Master account: ${config.valiantMasterAccountAddress ?? "n/a"}`,
        `CDP endpoint: ${probe.cdpEndpoint ?? "n/a"}`
      ].join("\n"),
      dedupeKey: `brave-wallet-disconnected:${incidentId}`
    });
  };

  await runExchangeSync("startup sync");
  await runLiveBrowserWalletCheck("startup");
  const exchangeSyncInterval = setInterval(() => {
    void runExchangeSync("automatic 5-minute sync");
  }, EXCHANGE_SYNC_INTERVAL_MS);
  exchangeSyncInterval.unref();
  const liveBrowserWalletInterval = setInterval(() => {
    void runLiveBrowserWalletCheck(`automatic ${config.valiantWalletCheckIntervalMinutes}-minute wallet check`);
  }, config.valiantWalletCheckIntervalMinutes * 60 * 1000);
  liveBrowserWalletInterval.unref();
  const healthyRunTimer = setTimeout(() => {
    const recovery = database.markBotRunHealthy(runId);
    if (!recovery.shouldNotifyRecovery || !recovery.incidentId) {
      return;
    }
    void notifier.notify({
      type: "INFO",
      title: "Trade Bot recovered",
      body: `The bot has remained healthy for five minutes.\nIncident: ${recovery.incidentId}`,
      dedupeKey: `restart-loop-recovered:${recovery.incidentId}`
    }).then(() => {
      database.markIncidentRecoverySent(recovery.incidentId!);
    });
  }, HEALTHY_RUN_DELAY_MS);
  healthyRunTimer.unref();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    clearInterval(exchangeSyncInterval);
    clearInterval(liveBrowserWalletInterval);
    clearTimeout(healthyRunTimer);
    database.endBotRun(runId, signal);
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

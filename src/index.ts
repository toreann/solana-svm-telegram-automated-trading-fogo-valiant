import { chromium } from "playwright-core";

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
  inferValiantPrivateApiBaseUrl,
  resolvePlaywrightLiveCdpEndpoint,
  resolveValiantMarketUrl
} from "./trading/valiantExecutor.js";

const EXCHANGE_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const LIVE_BROWSER_WALLET_CHECK_INTERVAL_MS = 60 * 1000;

function normalizeHexAddress(value?: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }

  const withPrefix = normalized.startsWith("0x") ? normalized : `0x${normalized}`;
  return /^0x[a-fA-F0-9]{40}$/.test(withPrefix) ? withPrefix.toLowerCase() : undefined;
}

interface LiveBrowserWalletProbeResult {
  connected: boolean;
  cdpEndpoint?: string;
  walletAddresses: string[];
  reason?: string;
}

async function probeLiveBrowserWalletConnection(config: ReturnType<typeof loadConfig>): Promise<LiveBrowserWalletProbeResult> {
  const cdpEndpoint = resolvePlaywrightLiveCdpEndpoint(
    config.valiantPlaywrightCdpUrl,
    config.valiantPlaywrightProfileDir
  );
  if (!cdpEndpoint) {
    return {
      connected: false,
      walletAddresses: [],
      reason: `No live Brave debugging endpoint was found for ${config.valiantPlaywrightProfileDir}.`
    };
  }

  const browser = await chromium.connectOverCDP(cdpEndpoint);
  try {
    const context = browser.contexts()[0];
    if (!context) {
      return {
        connected: false,
        cdpEndpoint,
        walletAddresses: [],
        reason: `Connected to ${cdpEndpoint}, but no browser context was available.`
      };
    }

    const marketUrl = resolveValiantMarketUrl(config.valiantBaseUrl, config.valiantMarketRoute);
    const targetOrigin = new URL(marketUrl).origin;
    const existingPage = context.pages().find((page) => {
      try {
        return new URL(page.url()).origin === targetOrigin;
      } catch {
        return false;
      }
    });
    const page = existingPage ?? await context.newPage();
    if (!existingPage || page.url() !== marketUrl) {
      await page.goto(marketUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000
      });
    }

    const configuredMasterAccount = normalizeHexAddress(config.valiantMasterAccountAddress);
    const walletAddresses = await page.evaluate(`
      (async () => {
        const DB_NAME = "valiant-agent-keys";
        const STORE_NAME = "encryption-keys";
        const STORAGE_PREFIX = "valiant:agent:";
        const ADDR_PREFIX = "valiant:agent-addr:";

        const openDb = () => new Promise((resolve, reject) => {
          const request = indexedDB.open(DB_NAME, 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error("Failed to open Valiant agent key database"));
        });

        const unwrapCryptoKey = (value) => {
          if (value instanceof CryptoKey) {
            return value;
          }
          if (
            value
            && typeof value === "object"
            && "key" in value
            && value.key instanceof CryptoKey
          ) {
            return value.key;
          }
          return undefined;
        };

        const readStore = async () => {
          const db = await openDb();
          return await new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, "readonly");
            const store = transaction.objectStore(STORE_NAME);
            const keysRequest = store.getAllKeys();
            const valuesRequest = store.getAll();

            transaction.oncomplete = () => {
              const keys = Array.isArray(keysRequest.result) ? keysRequest.result : [];
              const values = Array.isArray(valuesRequest.result) ? valuesRequest.result : [];
              resolve(
                keys
                  .map((key, index) => {
                    const cryptoKey = unwrapCryptoKey(values[index]);
                    if (!cryptoKey) {
                      return undefined;
                    }
                    return {
                      key: String(key).toLowerCase(),
                      cryptoKey
                    };
                  })
                  .filter(Boolean)
              );
              db.close();
            };
            transaction.onerror = () => {
              reject(transaction.error ?? new Error("Failed to read Valiant encryption keys"));
              db.close();
            };
          });
        };

        const decryptPrivateKey = async (cryptoKey, encrypted) => {
          const bytes = Uint8Array.from(atob(encrypted), (char) => char.charCodeAt(0));
          const iv = bytes.slice(0, 12);
          const ciphertext = bytes.slice(12);
          await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext);
        };

        const keyEntries = await readStore();
        const results = [];

        for (const entry of keyEntries) {
          const encrypted = localStorage.getItem(STORAGE_PREFIX + entry.key);
          if (!encrypted) {
            continue;
          }

          try {
            await decryptPrivateKey(entry.cryptoKey, encrypted);
            const agentAddress = localStorage.getItem(ADDR_PREFIX + entry.key)?.toLowerCase();
            if (agentAddress) {
              results.push({
                userAddress: entry.key,
                agentAddress
              });
            }
          } catch {
          }
        }

        return results;
      })()
    `) as Array<{ userAddress?: string; agentAddress?: string }>;

    const matchingAddresses = walletAddresses
      .filter((candidate) => !configuredMasterAccount || candidate.userAddress === configuredMasterAccount)
      .map((candidate) => candidate.agentAddress)
      .filter((value): value is string => Boolean(value));

    if (matchingAddresses.length === 0) {
      return {
        connected: false,
        cdpEndpoint,
        walletAddresses: [],
        reason: configuredMasterAccount
          ? `Brave is open at ${cdpEndpoint}, but no decryptable Valiant wallet session is connected for ${configuredMasterAccount}.`
          : `Brave is open at ${cdpEndpoint}, but no decryptable Valiant wallet session is available.`
      };
    }

    return {
      connected: true,
      cdpEndpoint,
      walletAddresses: matchingAddresses
    };
  } catch (error) {
    return {
      connected: false,
      cdpEndpoint,
      walletAddresses: [],
      reason: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

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
      privateAuthMode: config.valiantMasterAccountAddress ? "dynamic-agent-session" : config.valiantAgentKey ? "env-fallback-agent-key" : "legacy-or-none"
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

  try {
    const agentStatus = await orchestrator.getAgentSessionStatus();
    logger.info({ agentStatus }, "Agent session status checked at startup");
    if (config.valiantExecutionMode === "private" || config.valiantExecutionMode === "hybrid") {
      const isTradingReady = agentStatus.approvalStatus === "ready" || agentStatus.approvalStatus === "synced";
      if (!isTradingReady) {
        await notifier.notify({
          type: "INFO",
          title: "Valiant agent approval required",
          body: [
            `Approval status: ${agentStatus.approvalStatus}`,
            `Master account: ${agentStatus.masterAccountAddress ?? "n/a"}`,
            `Approved exchange agent: ${agentStatus.approvedAgentAddress ?? "n/a"}`,
            `Active in-memory agent: ${agentStatus.activeAgentAddress ?? "n/a"}`,
            `Env fallback agent: ${agentStatus.envFallbackAgentAddress ?? "n/a"}`,
            `Last error: ${agentStatus.lastError ?? "none"}`
          ].join("\n"),
          dedupeKey: `agent-startup:${new Date().toISOString().slice(0, 16)}`
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

  let liveBrowserWalletAlertOpen = false;
  const runLiveBrowserWalletCheck = async (reason: string) => {
    if (!config.valiantMasterAccountAddress) {
      return;
    }
    if (config.valiantExecutionMode !== "private" && config.valiantExecutionMode !== "hybrid") {
      return;
    }

    const probe = await probeLiveBrowserWalletConnection(config);
    logger.info({ probe, reason }, "Live Brave wallet session checked");

    if (probe.connected) {
      liveBrowserWalletAlertOpen = false;
      return;
    }

    if (liveBrowserWalletAlertOpen) {
      return;
    }

    liveBrowserWalletAlertOpen = true;
    await notifier.notify({
      type: "ERROR",
      title: "Brave wallet disconnected",
      body: [
        "The live Brave session is no longer exposing a usable Valiant wallet session for trading.",
        `Reason: ${probe.reason ?? "unknown"}`,
        `Master account: ${normalizeHexAddress(config.valiantMasterAccountAddress) ?? "n/a"}`,
        `CDP endpoint: ${probe.cdpEndpoint ?? "n/a"}`
      ].join("\n"),
      dedupeKey: `brave-wallet-disconnected:${new Date().toISOString().slice(0, 16)}`
    });
  };

  await runExchangeSync("startup sync");
  await runLiveBrowserWalletCheck("startup");
  const exchangeSyncInterval = setInterval(() => {
    void runExchangeSync("automatic 5-minute sync");
  }, EXCHANGE_SYNC_INTERVAL_MS);
  exchangeSyncInterval.unref();
  const liveBrowserWalletInterval = setInterval(() => {
    void runLiveBrowserWalletCheck("automatic 1-minute wallet check");
  }, LIVE_BROWSER_WALLET_CHECK_INTERVAL_MS);
  liveBrowserWalletInterval.unref();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    clearInterval(exchangeSyncInterval);
    clearInterval(liveBrowserWalletInterval);
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

import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { AppDatabase } from "../src/db.js";
import type { Notifier } from "../src/notifier.js";
import { TradeOrchestrator } from "../src/orchestrator.js";
import type {
  AppConfig,
  ExecutionRequest,
  ExecutionResult,
  PositionSnapshot,
  PositionState,
  ProfitActionRequest
} from "../src/types.js";
import type { ExecutionAdapter } from "../src/trading/executionAdapter.js";

const dbPath = "./data/test-orchestrator.db";

class MockExecutor implements ExecutionAdapter {
  public async placeEntry(_request: ExecutionRequest): Promise<ExecutionResult> {
    return { status: "accepted", remoteOrderId: "order-1", remotePositionId: "position-1", resultingStatus: "OPEN" };
  }
  public async setProtectionOrders(_position: PositionState): Promise<ExecutionResult> {
    return { status: "accepted", resultingStatus: "OPEN" };
  }
  public async moveStopLoss(_position: PositionState, _stopLoss: number): Promise<ExecutionResult> {
    return { status: "accepted", resultingStatus: "OPEN" };
  }
  public async partialCloseReduceOnly(_position: PositionState, _percent: number): Promise<ExecutionResult> {
    return { status: "accepted", resultingStatus: "OPEN" };
  }
  public async closePositionReduceOnly(_position: PositionState): Promise<ExecutionResult> {
    return { status: "accepted", resultingStatus: "CLOSED" };
  }
  public async cancelPendingByTicker(_symbol: string): Promise<ExecutionResult> {
    return { status: "accepted", resultingStatus: "CANCELLED" };
  }
  public async getPositions(): Promise<PositionSnapshot[]> {
    return [];
  }
  public async applyProfitAction(_request: ProfitActionRequest): Promise<ExecutionResult> {
    return { status: "accepted", resultingStatus: "OPEN" };
  }
}

class MockNotifier {
  public readonly events: string[] = [];
  public async notify(event: { dedupeKey: string }): Promise<void> {
    this.events.push(event.dedupeKey);
  }
}

const config: AppConfig = {
  nodeEnv: "test",
  logLevel: "silent",
  databasePath: dbPath,
  telegramApiId: 1,
  telegramApiHash: "hash",
  telegramSessionFile: "./secrets/test.session",
  telegramSignalChatId: "1",
  telegramAllowedSenderIds: [],
  telegramAllowedSenderLabels: [],
  controlBotToken: "bot",
  controlOwnerChatId: "1",
  controlOwnerUserId: "1",
  symbolWhitelist: ["SOL", "BNB"],
  defaultRuntimeConfig: {
    marginPerTrade: 25,
    maxLeverageCap: 20,
    profitPartialClosePercent: 25,
    paused: false,
    dryRun: true
  },
  valiantExecutionMode: "dry-run",
  valiantBaseUrl: "https://app.valiant.trade",
  valiantPrivateApiBaseUrl: undefined,
  valiantPrivateApiKey: undefined,
  valiantPrivateApiSecret: undefined,
  valiantPlaywrightProfileDir: "./playwright-profile",
  valiantMarketRoute: "/perps"
};

function cleanup(): void {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    // no-op
  }
}

test("open a position for a valid entry signal", async () => {
  cleanup();
  const db = await AppDatabase.open(dbPath, config.defaultRuntimeConfig);
  const notifier = new MockNotifier();
  const orchestrator = new TradeOrchestrator(
    config,
    db,
    new MockExecutor(),
    notifier as unknown as Notifier,
    { info() {}, error() {}, warn() {} } as never
  );

  await orchestrator.handleParsedSignal(
    {
      type: "ENTRY",
      symbol: "SOL",
      side: "LONG",
      entry: 100,
      takeProfit: 110,
      stopLoss: 95,
      leverage: 10,
      statusText: "Aguardando confirmação",
      messageId: "m1",
      messageDate: "2026-03-26T00:00:00.000Z",
      rawText: "raw"
    },
    "1",
    { telegramUserId: "42", username: "MacacoClub_bot", displayName: "Macaco Club", isAllowed: true }
  );

  assert.equal(orchestrator.listPositions().length, 1);
  db.close();
  cleanup();
});

test("apply the profit action only once", async () => {
  cleanup();
  const db = await AppDatabase.open(dbPath, config.defaultRuntimeConfig);
  const notifier = new MockNotifier();
  const orchestrator = new TradeOrchestrator(
    config,
    db,
    new MockExecutor(),
    notifier as unknown as Notifier,
    { info() {}, error() {}, warn() {} } as never
  );

  await orchestrator.handleParsedSignal(
    {
      type: "ENTRY",
      symbol: "BNB",
      side: "LONG",
      entry: 100,
      takeProfit: 120,
      stopLoss: 90,
      leverage: 10,
      statusText: "Aguardando confirmação",
      messageId: "m1",
      messageDate: "2026-03-26T00:00:00.000Z",
      rawText: "raw"
    },
    "1",
    { telegramUserId: "42", username: "MacacoClub_bot", displayName: "Macaco Club", isAllowed: true }
  );

  await orchestrator.handleParsedSignal(
    {
      type: "PROFIT",
      symbol: "BNB",
      side: "LONG",
      currentProfitPct: 1,
      leveragedProfitPct: 18,
      priceFrom: 100,
      priceTo: 101,
      messageId: "m2",
      messageDate: "2026-03-26T00:01:00.000Z",
      rawText: "raw"
    },
    "1",
    { telegramUserId: "42", username: "MacacoClub_bot", displayName: "Macaco Club", isAllowed: true }
  );

  await orchestrator.handleParsedSignal(
    {
      type: "PROFIT",
      symbol: "BNB",
      side: "LONG",
      currentProfitPct: 2,
      leveragedProfitPct: 20,
      priceFrom: 101,
      priceTo: 102,
      messageId: "m3",
      messageDate: "2026-03-26T00:02:00.000Z",
      rawText: "raw"
    },
    "1",
    { telegramUserId: "42", username: "MacacoClub_bot", displayName: "Macaco Club", isAllowed: true }
  );

  const position = orchestrator.listPositions()[0];
  assert.equal(position.profitActionApplied, true);
  assert.equal(position.stopLoss, 100);
  db.close();
  cleanup();
});
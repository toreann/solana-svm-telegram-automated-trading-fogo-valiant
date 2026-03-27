import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { AppDatabase } from "../src/db.js";
import type { Notifier } from "../src/notifier.js";
import { TradeOrchestrator } from "../src/orchestrator.js";
import { parseSignal } from "../src/signals/parser.js";
import { SenderFilter } from "../src/signals/senderFilter.js";
import type {
  AppConfig,
  ExecutionRequest,
  ExecutionResult,
  PositionSnapshot,
  PositionState,
  ProfitActionRequest
} from "../src/types.js";
import type { ExecutionAdapter } from "../src/trading/executionAdapter.js";
import {
  buildValiantPrivateHeaders,
  formatHyperliquidOrderPrice,
  formatHyperliquidOrderSize,
  formatValiantOrderValue,
  inferValiantPrivateApiBaseUrl,
  pickPreferredLeverageChoice,
  resolveValiantMarketUrl
} from "../src/trading/valiantExecutor.js";

async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

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
  public readonly notifications: Array<{ title: string; body: string; dedupeKey: string }> = [];
  public async notify(event: { title: string; body: string; dedupeKey: string }): Promise<void> {
    this.events.push(event.dedupeKey);
    this.notifications.push(event);
  }
}

const orchestratorConfig: AppConfig = {
  nodeEnv: "test",
  logLevel: "silent",
  databasePath: "./data/test-orchestrator.db",
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
  valiantBaseUrl: "https://valiant.trade",
  valiantPrivateApiBaseUrl: undefined,
  valiantPrivateApiKey: undefined,
  valiantPrivateApiSecret: undefined,
  valiantPlaywrightProfileDir: "./playwright-profile",
  valiantMarketRoute: "/perps"
};

function cleanup(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // no-op
  }
}

await run("parse entry messages", () => {
  const entryMessage = `⚡️ LIVE\n\n🚨 NOVO SINAL | #BTC26032601V13\n\nAtivo: BTC\nDireção: 🟢 LONG\nEntrada: $68,497.25\n\n🎯 TP: $71,059.05 (3.74%)\n🛑 SL: $67,216.35 (1.87%)\n📊 R:R = 1:2.0\n⚡️ Alavancagem máx: 20.0x\n\nStatus: Aguardando confirmação`;
  const parsed = parseSignal(entryMessage, "1", "2026-03-26T12:00:00.000Z");
  assert.ok(parsed);
  assert.equal(parsed.type, "ENTRY");
  if (parsed.type === "ENTRY") {
    assert.equal(parsed.symbol, "BTC");
    assert.equal(parsed.side, "LONG");
    assert.equal(parsed.entry, 68497);
    assert.equal(parsed.takeProfit, 71059);
    assert.equal(parsed.stopLoss, 67216);
    assert.equal(parsed.leverage, 20);
  }
});

await run("round entry prices to the nearest whole number", () => {
  const entryMessage = `⚡️ LIVE\n\n🚨 NOVO SINAL | #ETH26032601V13\n\nAtivo: ETH\nDireção: 🟢 LONG\nEntrada: $1,999.56\n\n🎯 TP: $2,200.32 (10.04%)\n🛑 SL: $1,899.18 (5.02%)\n📊 R:R = 1:2.0\n⚡️ Alavancagem máx: 10.0x\n\nStatus: Aguardando confirmação`;
  const parsed = parseSignal(entryMessage, "1b", "2026-03-26T12:00:00.000Z");
  assert.ok(parsed);
  assert.equal(parsed?.type, "ENTRY");
  if (parsed?.type === "ENTRY") {
    assert.equal(parsed.entry, 2000);
    assert.equal(parsed.takeProfit, 2200);
    assert.equal(parsed.stopLoss, 1899);
  }
});

await run("round entry prices that use comma decimals", () => {
  const entryMessage = `⚡️ LIVE\n\n🚨 NOVO SINAL | #ETH26032601V13\n\nAtivo: ETH\nDireção: 🟢 LONG\nEntrada: $1.999,56\n\n🎯 TP: $2.200,32 (10,04%)\n🛑 SL: $1.899,18 (5,02%)\n📊 R:R = 1:2.0\n⚡️ Alavancagem máx: 10,0x\n\nStatus: Aguardando confirmação`;
  const parsed = parseSignal(entryMessage, "1c", "2026-03-26T12:00:00.000Z");
  assert.ok(parsed);
  assert.equal(parsed?.type, "ENTRY");
  if (parsed?.type === "ENTRY") {
    assert.equal(parsed.entry, 2000);
    assert.equal(parsed.takeProfit, 2200);
    assert.equal(parsed.stopLoss, 1899);
    assert.equal(parsed.leverage, 10);
  }
});

await run("round fractional entry leverage to the nearest whole number", () => {
  const entryMessage = `⚡️ LIVE\n\n🚨 NOVO SINAL | #SOL26032601V13\n\nAtivo: SOL\nDireção: 🟢 LONG\nEntrada: $84.5\n\n🎯 TP: $90.86 (4.90%)\n🛑 SL: $84.00 (2.45%)\n📊 R:R = 1:2.0\n⚡️ Alavancagem máx: 16.3x\n\nStatus: Aguardando confirmação`;
  const parsed = parseSignal(entryMessage, "4", "2026-03-26T12:00:00.000Z");
  assert.ok(parsed);
  assert.equal(parsed?.type, "ENTRY");
  if (parsed?.type === "ENTRY") {
    assert.equal(parsed.leverage, 16);
  }
});

await run("round fractional entry leverage written with a comma", () => {
  const entryMessage = `⚡️ LIVE\n\n🚨 NOVO SINAL | #SOL26032601V13\n\nAtivo: SOL\nDireção: 🟢 LONG\nEntrada: $84.5\n\n🎯 TP: $90.86 (4.90%)\n🛑 SL: $84.00 (2.45%)\n📊 R:R = 1:2.0\n⚡️ Alavancagem máx: 16,3x\n\nStatus: Aguardando confirmação`;
  const parsed = parseSignal(entryMessage, "4b", "2026-03-26T12:00:00.000Z");
  assert.ok(parsed);
  assert.equal(parsed?.type, "ENTRY");
  if (parsed?.type === "ENTRY") {
    assert.equal(parsed.leverage, 16);
  }
});

await run("parse profit messages", () => {
  const profitMessage = `LIVE\n\nLUCRO | #BNB26032601V13\n\nBNB LONG\nLucro atual: +1.0% (ou +18% com alav.)\nPreço: $625.25 -> $631.56`;
  const parsed = parseSignal(profitMessage, "2", "2026-03-26T12:00:00.000Z");
  assert.ok(parsed);
  assert.equal(parsed.type, "PROFIT");
  if (parsed.type === "PROFIT") {
    assert.equal(parsed.symbol, "BNB");
    assert.equal(parsed.side, "LONG");
    assert.equal(parsed.currentProfitPct, 1);
    assert.equal(parsed.leveragedProfitPct, 18);
    assert.equal(parsed.priceFrom, 625.25);
    assert.equal(parsed.priceTo, 631.56);
  }
});

await run("parse profit messages with comma decimals", () => {
  const profitMessage = `LIVE\n\nLUCRO | #BNB26032601V13\n\nBNB LONG\nLucro atual: +1,0% (ou +18,5% com alav.)\nPreço: $625.25 -> $631.56`;
  const parsed = parseSignal(profitMessage, "2b", "2026-03-26T12:00:00.000Z");
  assert.ok(parsed);
  assert.equal(parsed?.type, "PROFIT");
  if (parsed?.type === "PROFIT") {
    assert.equal(parsed.currentProfitPct, 1);
    assert.equal(parsed.leveragedProfitPct, 18.5);
  }
});

await run("ignore unrelated messages", () => {
  assert.equal(parseSignal("hello", "3", "2026-03-26T12:00:00.000Z"), null);
});

await run("infer the default Valiant private API base URL", () => {
  assert.equal(inferValiantPrivateApiBaseUrl(undefined, "https://valiant.trade"), "https://api.hyperliquid.xyz");
  assert.equal(
    inferValiantPrivateApiBaseUrl(undefined, "https://testnet.valiant.trade/perps"),
    "https://api.hyperliquid-testnet.xyz"
  );
  assert.equal(
    inferValiantPrivateApiBaseUrl("https://custom.valiant.trade/", "https://app.valiant.trade"),
    "https://custom.valiant.trade"
  );
  assert.equal(
    inferValiantPrivateApiBaseUrl("https://api.valiant.trade", "https://valiant.trade"),
    "https://api.hyperliquid.xyz"
  );
});

await run("prefer agent-key auth for Valiant private transport", () => {
  assert.deepEqual(
    buildValiantPrivateHeaders(
      {
        valiantAgentKey: "agent-123",
        valiantPrivateApiKey: "legacy-key",
        valiantPrivateApiSecret: "legacy-secret"
      },
      true
    ),
    {
      "content-type": "application/json",
      "x-agent-key": "agent-123"
    }
  );
});

await run("resolve symbol-aware Valiant market routes", () => {
  assert.equal(
    resolveValiantMarketUrl("https://valiant.trade", "/perps/{symbol}", "sol"),
    "https://valiant.trade/perps/SOL"
  );
  assert.equal(
    resolveValiantMarketUrl("https://valiant.trade", "/perps/:symbol?view=trade", "btc"),
    "https://valiant.trade/perps/BTC?view=trade"
  );
  assert.equal(
    resolveValiantMarketUrl("https://valiant.trade", "/perps", "eth"),
    "https://valiant.trade/perps"
  );
});

await run("pick the safest available leverage chip", () => {
  assert.equal(pickPreferredLeverageChoice(16.3, [8, 16, 20]), 16);
  assert.equal(pickPreferredLeverageChoice(5, [8, 16, 20]), 8);
  assert.equal(pickPreferredLeverageChoice(20, [8, 16, 20, 20]), 20);
});

await run("format the Valiant order value from margin and leverage", () => {
  assert.equal(formatValiantOrderValue(120, 16.3), "1956");
  assert.equal(formatValiantOrderValue(25, 10), "250");
});

await run("format Hyperliquid prices to the allowed tick size", () => {
  assert.equal(formatHyperliquidOrderPrice(145.12654, 1), "145.12");
  assert.equal(formatHyperliquidOrderPrice(84.768, 2), "84.768");
  assert.equal(formatHyperliquidOrderPrice(0.123456789, 0), "0.12345");
});

await run("format Hyperliquid sizes to the allowed lot size", () => {
  assert.equal(formatHyperliquidOrderSize(1.234567, 2), "1.23");
  assert.equal(formatHyperliquidOrderSize(0.123456, 4), "0.1234");
});

await run("accept configured usernames and persist sender ID", async () => {
  const dbPath = "./data/test-sender-filter.db";
  cleanup(dbPath);
  const db = await AppDatabase.open(dbPath, {
    marginPerTrade: 25,
    maxLeverageCap: 20,
    profitPartialClosePercent: 25,
    paused: false,
    dryRun: true
  });
  const filter = new SenderFilter(db, [], ["@MacacoClub_bot", "Mr. Robot"]);
  const allowed = filter.isAllowed({ telegramUserId: "100", username: "MacacoClub_bot", displayName: "Macaco Club" });
  assert.equal(allowed, true);
  assert.equal(db.getAllowedSenders().length, 1);
  db.close();
  cleanup(dbPath);
});

await run("reject non-allowed senders", async () => {
  const dbPath = "./data/test-sender-filter.db";
  cleanup(dbPath);
  const db = await AppDatabase.open(dbPath, {
    marginPerTrade: 25,
    maxLeverageCap: 20,
    profitPartialClosePercent: 25,
    paused: false,
    dryRun: true
  });
  const filter = new SenderFilter(db, [], ["@MacacoClub_bot"]);
  const allowed = filter.isAllowed({ telegramUserId: "200", username: "other_bot", displayName: "Other Bot" });
  assert.equal(allowed, false);
  db.close();
  cleanup(dbPath);
});

await run("open a position for a valid entry signal", async () => {
  const dbPath = "./data/test-orchestrator.db";
  cleanup(dbPath);
  const db = await AppDatabase.open(dbPath, orchestratorConfig.defaultRuntimeConfig);
  const notifier = new MockNotifier();
  const orchestrator = new TradeOrchestrator(
    orchestratorConfig,
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
  cleanup(dbPath);
});

await run("store the leverage actually applied by the executor", async () => {
  const dbPath = "./data/test-orchestrator.db";
  cleanup(dbPath);
  const db = await AppDatabase.open(dbPath, orchestratorConfig.defaultRuntimeConfig);
  const notifier = new MockNotifier();
  const executor = new MockExecutor();
  executor.placeEntry = async (_request: ExecutionRequest): Promise<ExecutionResult> => ({
    status: "accepted",
    remoteOrderId: "order-1",
    remotePositionId: "position-1",
    resultingStatus: "OPEN",
    metadata: { appliedLeverage: 16 }
  });
  const orchestrator = new TradeOrchestrator(
    { ...orchestratorConfig, valiantExecutionMode: "private" },
    db,
    executor,
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
      leverage: 17,
      statusText: "Aguardando confirmação",
      messageId: "m-applied",
      messageDate: "2026-03-26T00:00:00.000Z",
      rawText: "raw"
    },
    "1",
    { telegramUserId: "42", username: "MacacoClub_bot", displayName: "Macaco Club", isAllowed: true }
  );

  const position = orchestrator.listPositions()[0];
  assert.equal(position?.leverage, 16);
  assert.equal(position?.currentSize, 4);

  db.close();
  cleanup(dbPath);
});

await run("warn when the entry is live but protection orders fail", async () => {
  const dbPath = "./data/test-orchestrator.db";
  cleanup(dbPath);
  const db = await AppDatabase.open(dbPath, orchestratorConfig.defaultRuntimeConfig);
  const notifier = new MockNotifier();
  const executor = new MockExecutor();
  executor.setProtectionOrders = async (_position: PositionState): Promise<ExecutionResult> => ({
    status: "failed",
    reason: "Hyperliquid rejected the TP/SL order"
  });
  const orchestrator = new TradeOrchestrator(
    { ...orchestratorConfig, valiantExecutionMode: "private" },
    db,
    executor,
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
      messageId: "m-protection-failed",
      messageDate: "2026-03-26T00:00:00.000Z",
      rawText: "raw"
    },
    "1",
    { telegramUserId: "42", username: "MacacoClub_bot", displayName: "Macaco Club", isAllowed: true }
  );

  const position = orchestrator.listPositions()[0];
  assert.equal(position?.lastError, "Hyperliquid rejected the TP/SL order");
  assert.equal(
    notifier.notifications.at(-1)?.title,
    "[SOL] LONG order placed with TP/SL warning"
  );
  assert.match(notifier.notifications.at(-1)?.body ?? "", /Protection orders: Hyperliquid rejected the TP\/SL order/);

  db.close();
  cleanup(dbPath);
});

await run("reapply TP/SL for an open position", async () => {
  const dbPath = "./data/test-orchestrator.db";
  cleanup(dbPath);
  const db = await AppDatabase.open(dbPath, orchestratorConfig.defaultRuntimeConfig);
  const notifier = new MockNotifier();
  const executor = new MockExecutor();
  let protectionAttempts = 0;
  executor.setProtectionOrders = async (_position: PositionState): Promise<ExecutionResult> => {
    protectionAttempts += 1;
    return protectionAttempts === 1
      ? { status: "failed", reason: "Initial TP/SL placement failed" }
      : { status: "accepted", resultingStatus: "OPEN" };
  };

  const orchestrator = new TradeOrchestrator(
    { ...orchestratorConfig, valiantExecutionMode: "private" },
    db,
    executor,
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
      messageId: "m-reapply",
      messageDate: "2026-03-26T00:00:00.000Z",
      rawText: "raw"
    },
    "1",
    { telegramUserId: "42", username: "MacacoClub_bot", displayName: "Macaco Club", isAllowed: true }
  );

  const position = orchestrator.listPositions()[0];
  assert.equal(position?.lastError, "Initial TP/SL placement failed");

  const refreshed = await orchestrator.reapplyProtectionOrders(position!.id);
  assert.equal(protectionAttempts, 2);
  assert.equal(refreshed?.lastError, null);
  assert.match(notifier.notifications.at(-1)?.title ?? "", /\[SOL\] TP\/SL reapplied/);

  db.close();
  cleanup(dbPath);
});

await run("apply the profit action only once", async () => {
  const dbPath = "./data/test-orchestrator.db";
  cleanup(dbPath);
  const db = await AppDatabase.open(dbPath, orchestratorConfig.defaultRuntimeConfig);
  const notifier = new MockNotifier();
  const orchestrator = new TradeOrchestrator(
    orchestratorConfig,
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
  cleanup(dbPath);
});

await run("reset local positions clears active positions", async () => {
  const dbPath = "./data/test-orchestrator.db";
  cleanup(dbPath);
  const db = await AppDatabase.open(dbPath, orchestratorConfig.defaultRuntimeConfig);
  const notifier = new MockNotifier();
  const orchestrator = new TradeOrchestrator(
    orchestratorConfig,
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

  const resetCount = orchestrator.resetLocalPositions();
  assert.equal(resetCount, 1);
  assert.equal(orchestrator.listPositions().length, 0);
  assert.equal(db.listAllPositions()[0]?.status, "CLOSED");
  assert.equal(db.listAllPositions()[0]?.currentSize, 0);

  db.close();
  cleanup(dbPath);
});

if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}

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
  public async notify(event: { dedupeKey: string }): Promise<void> {
    this.events.push(event.dedupeKey);
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
  valiantBaseUrl: "https://app.valiant.trade",
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
  const entryMessage = `LIVE\n\nNOVO SINAL | #SOL26032601V13\n\nAtivo: SOL\nDireção: LONG\nEntrada: $86.62\n\nTP: $90.86 (4.90%)\nSL: $84.50 (2.45%)\nR:R = 1:2.0\nAlavancagem máx: 16.3x\n\nStatus: Aguardando confirmação`;
  const parsed = parseSignal(entryMessage, "1", "2026-03-26T12:00:00.000Z");
  assert.ok(parsed);
  assert.equal(parsed.type, "ENTRY");
  if (parsed.type === "ENTRY") {
    assert.equal(parsed.symbol, "SOL");
    assert.equal(parsed.side, "LONG");
    assert.equal(parsed.entry, 86.62);
    assert.equal(parsed.takeProfit, 90.86);
    assert.equal(parsed.stopLoss, 84.5);
    assert.equal(parsed.leverage, 16.3);
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

await run("ignore unrelated messages", () => {
  assert.equal(parseSignal("hello", "3", "2026-03-26T12:00:00.000Z"), null);
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

if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}
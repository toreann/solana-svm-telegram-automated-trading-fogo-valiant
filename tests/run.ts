import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { privateKeyToAccount } from "viem/accounts";

import { AppDatabase } from "../src/db.js";
import type { Notifier } from "../src/notifier.js";
import { TradeOrchestrator } from "../src/orchestrator.js";
import { parseSignal } from "../src/signals/parser.js";
import { SenderFilter } from "../src/signals/senderFilter.js";
import { buildSelfRestartHandoffArgs, buildSelfRestartPlan } from "../src/telegram/controlBot.js";
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
  HybridValiantExecutor,
  buildValiantPrivateHeaders,
  formatHyperliquidOrderPrice,
  formatHyperliquidOrderSize,
  formatValiantOrderValue,
  inferValiantPrivateApiBaseUrl,
  isRetryableHyperliquidAuthFailure,
  parseDevToolsActivePortFile,
  pickPreferredLeverageChoice,
  resolvePlaywrightLiveCdpEndpoint,
  resolveValiantMarketUrl,
  selectApprovedAgentPrivateKey
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

function createAdapterStub(overrides: Partial<ExecutionAdapter>): ExecutionAdapter {
  return {
    async placeEntry(_request: ExecutionRequest): Promise<ExecutionResult> {
      return { status: "failed", reason: "not implemented" };
    },
    async setProtectionOrders(_position: PositionState): Promise<ExecutionResult> {
      return { status: "failed", reason: "not implemented" };
    },
    async moveStopLoss(_position: PositionState, _stopLoss: number): Promise<ExecutionResult> {
      return { status: "failed", reason: "not implemented" };
    },
    async partialCloseReduceOnly(_position: PositionState, _percent: number): Promise<ExecutionResult> {
      return { status: "failed", reason: "not implemented" };
    },
    async closePositionReduceOnly(_position: PositionState): Promise<ExecutionResult> {
      return { status: "failed", reason: "not implemented" };
    },
    async cancelPendingByTicker(_symbol: string): Promise<ExecutionResult> {
      return { status: "failed", reason: "not implemented" };
    },
    async getPositions(): Promise<PositionSnapshot[]> {
      return [];
    },
    async applyProfitAction(_request: ProfitActionRequest): Promise<ExecutionResult> {
      return { status: "failed", reason: "not implemented" };
    },
    ...overrides
  };
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

await run("parse leverage labels that use maxima punctuation variants", () => {
  const entryMessage = `⚡️ LIVE\n\n🚨 NOVO SINAL | #BNB26032601V13\n\nAtivo: BNB\nDireção: 🟢 LONG\nEntrada: $589.4\n\n🎯 TP: $612.2 (3.8%)\n🛑 SL: $577.3 (2.1%)\n📊 R:R = 1:2.0\n⚡️ Alavancagem máxima.: 9,7x\n\nStatus: Aguardando confirmação`;
  const parsed = parseSignal(entryMessage, "4c", "2026-03-26T12:00:00.000Z");
  assert.ok(parsed);
  assert.equal(parsed?.type, "ENTRY");
  if (parsed?.type === "ENTRY") {
    assert.equal(parsed.symbol, "BNB");
    assert.equal(parsed.leverage, 10);
  }
});

await run("reject entry signals whose rounded prices collapse into the same value", () => {
  const entryMessage = `⚡️ LIVE\n\n🚨 NOVO SINAL | #ETH26032601V13\n\nAtivo: ETH\nDireção: 🟢 LONG\nEntrada: $100.49\n\n🎯 TP: $100.40 (0.2%)\n🛑 SL: $99.60 (0.8%)\n📊 R:R = 1:2.0\n⚡️ Alavancagem máx: 10.0x\n\nStatus: Aguardando confirmação`;
  assert.throws(
    () => parseSignal(entryMessage, "4d", "2026-03-26T12:00:00.000Z"),
    /distinct values/
  );
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

await run("recognize retryable Hyperliquid auth failures", () => {
  assert.equal(
    isRetryableHyperliquidAuthFailure(
      'Hyperliquid rejected the request: {"status":"err","response":"User or API Wallet 0xabc does not exist."}'
    ),
    true
  );
  assert.equal(
    isRetryableHyperliquidAuthFailure(
      'VALIANT_AGENT_KEY resolves to 0xabc, but Hyperliquid userRole returned "missing".'
    ),
    true
  );
  assert.equal(isRetryableHyperliquidAuthFailure("Price must be divisible by tick size"), false);
});

await run("parse DevToolsActivePort files into a CDP endpoint", () => {
  assert.equal(
    parseDevToolsActivePortFile("9222\n/devtools/browser/abc123\n"),
    "ws://127.0.0.1:9222/devtools/browser/abc123"
  );
  assert.equal(
    parseDevToolsActivePortFile("9333\n"),
    "http://127.0.0.1:9333"
  );
});

await run("prefer the configured live CDP endpoint over profile discovery", () => {
  assert.equal(
    resolvePlaywrightLiveCdpEndpoint("http://127.0.0.1:9222", "./playwright-profile"),
    "http://127.0.0.1:9222"
  );
});

await run("select an approved browser-stored agent key when the configured key is stale", () => {
  const selected = selectApprovedAgentPrivateKey({
    configuredAgentKey: `0x${"11".repeat(32)}`,
    configuredMasterAccountAddress: "0x8811436f1d51911368ebb2072d92a1bd20e29612",
    approvedAgentAddresses: ["0xa3f6083bcb4ad18820bf87bb6eda80baf45f87b0"],
    browserStoredAgents: [
      {
        userAddress: "0x8811436f1d51911368ebb2072d92a1bd20e29612",
        agentAddress: "0xa3f6083bcb4ad18820bf87bb6eda80baf45f87b0",
        privateKey: `0x${"22".repeat(32)}`
      }
    ]
  });

  assert.equal(selected, `0x${"22".repeat(32)}`);
});

await run("prefer the configured agent key when it is already approved", () => {
  const configuredAgentKey = `0x${"33".repeat(32)}` as `0x${string}`;
  const selected = selectApprovedAgentPrivateKey({
    configuredAgentKey,
    approvedAgentAddresses: [
      privateKeyToAccount(configuredAgentKey).address
    ],
    browserStoredAgents: [
      {
        userAddress: "0x8811436f1d51911368ebb2072d92a1bd20e29612",
        agentAddress: "0xa3f6083bcb4ad18820bf87bb6eda80baf45f87b0",
        privateKey: `0x${"22".repeat(32)}`
      }
    ]
  });

  assert.equal(selected, configuredAgentKey);
});

await run("prefer the browser-approved agent over the configured env key when both are approved", () => {
  const configuredAgentKey = `0x${"33".repeat(32)}` as `0x${string}`;
  const browserAgentKey = `0x${"44".repeat(32)}` as `0x${string}`;
  const selected = selectApprovedAgentPrivateKey({
    configuredAgentKey,
    configuredMasterAccountAddress: "0x8811436f1d51911368ebb2072d92a1bd20e29612",
    approvedAgentAddresses: [
      privateKeyToAccount(configuredAgentKey).address,
      privateKeyToAccount(browserAgentKey).address
    ],
    browserStoredAgents: [
      {
        userAddress: "0x8811436f1d51911368ebb2072d92a1bd20e29612",
        agentAddress: privateKeyToAccount(browserAgentKey).address,
        privateKey: browserAgentKey
      }
    ]
  });

  assert.equal(selected, browserAgentKey);
});

await run("fallback to Playwright when private entry auth fails in private mode", async () => {
  const executor = new HybridValiantExecutor({
    ...orchestratorConfig,
    valiantExecutionMode: "private",
    valiantAgentKey: `0x${"11".repeat(32)}`
  });

  const mutableExecutor = executor as unknown as {
    privateTransport: ExecutionAdapter;
    playwright: ExecutionAdapter;
  };

  let playwrightCalls = 0;
  mutableExecutor.privateTransport = createAdapterStub({
    async placeEntry(): Promise<ExecutionResult> {
      return {
        status: "failed",
        reason: 'Hyperliquid rejected the request: {"status":"err","response":"User or API Wallet 0xabc does not exist."}'
      };
    }
  });
  mutableExecutor.playwright = createAdapterStub({
    async placeEntry(): Promise<ExecutionResult> {
      playwrightCalls += 1;
      return { status: "accepted", resultingStatus: "OPEN", metadata: { adapter: "playwright" } };
    }
  });

  const result = await executor.placeEntry({
    symbol: "SOL",
    side: "SHORT",
    entryPrice: 120,
    takeProfit: 110,
    stopLoss: 125,
    leverage: 5,
    margin: 25,
    sourceMessageId: "fallback-1"
  });

  assert.equal(result.status, "accepted");
  assert.equal(playwrightCalls, 1);
  assert.equal(result.metadata?.adapter, "playwright");
});

await run("build a self-restart plan from the current process command line", () => {
  assert.deepEqual(
    buildSelfRestartPlan("/usr/bin/node", ["./node_modules/tsx/dist/cli.mjs", "watch", "src/index.ts"], "/tmp/trade-bot"),
    {
      command: "/usr/bin/node",
      args: ["./node_modules/tsx/dist/cli.mjs", "watch", "src/index.ts"],
      cwd: "/tmp/trade-bot"
    }
  );
});

await run("build detached self-restart handoff args", () => {
  const args = buildSelfRestartHandoffArgs(
    {
      command: "/usr/bin/node",
      args: ["./dist/src/index.js"],
      cwd: "/tmp/trade-bot"
    },
    4321
  );
  assert.equal(args[0], "-e");
  assert.match(args[1] ?? "", /waitForParentExit/);
  assert.equal(args[2], JSON.stringify({
    command: "/usr/bin/node",
    args: ["./dist/src/index.js"],
    cwd: "/tmp/trade-bot"
  }));
  assert.equal(args[3], "4321");
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

await run("widen long stops to a minimum 3.5% distance from entry", async () => {
  const dbPath = "./data/test-orchestrator.db";
  cleanup(dbPath);
  const db = await AppDatabase.open(dbPath, orchestratorConfig.defaultRuntimeConfig);
  const notifier = new MockNotifier();
  const executor = new MockExecutor();
  let capturedRequest: ExecutionRequest | undefined;
  executor.placeEntry = async (request: ExecutionRequest): Promise<ExecutionResult> => {
    capturedRequest = request;
    return { status: "accepted", remoteOrderId: "order-1", remotePositionId: "position-1", resultingStatus: "OPEN" };
  };
  const orchestrator = new TradeOrchestrator(
    orchestratorConfig,
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
      stopLoss: 98,
      leverage: 10,
      statusText: "Aguardando confirmação",
      messageId: "m-min-stop-long",
      messageDate: "2026-03-26T00:00:00.000Z",
      rawText: "raw"
    },
    "1",
    { telegramUserId: "42", username: "MacacoClub_bot", displayName: "Macaco Club", isAllowed: true }
  );

  assert.equal(capturedRequest?.stopLoss, 96.5);
  assert.equal(orchestrator.listPositions()[0]?.stopLoss, 96.5);
  assert.match(notifier.notifications.at(-1)?.body ?? "", /adjusted from 98 to 96\.5/);

  db.close();
  cleanup(dbPath);
});

await run("widen short stops to a minimum 3.5% distance from entry", async () => {
  const dbPath = "./data/test-orchestrator.db";
  cleanup(dbPath);
  const db = await AppDatabase.open(dbPath, orchestratorConfig.defaultRuntimeConfig);
  const notifier = new MockNotifier();
  const executor = new MockExecutor();
  let capturedRequest: ExecutionRequest | undefined;
  executor.placeEntry = async (request: ExecutionRequest): Promise<ExecutionResult> => {
    capturedRequest = request;
    return { status: "accepted", remoteOrderId: "order-1", remotePositionId: "position-1", resultingStatus: "OPEN" };
  };
  const orchestrator = new TradeOrchestrator(
    orchestratorConfig,
    db,
    executor,
    notifier as unknown as Notifier,
    { info() {}, error() {}, warn() {} } as never
  );

  await orchestrator.handleParsedSignal(
    {
      type: "ENTRY",
      symbol: "BNB",
      side: "SHORT",
      entry: 100,
      takeProfit: 90,
      stopLoss: 101,
      leverage: 10,
      statusText: "Aguardando confirmação",
      messageId: "m-min-stop-short",
      messageDate: "2026-03-26T00:00:00.000Z",
      rawText: "raw"
    },
    "1",
    { telegramUserId: "42", username: "MacacoClub_bot", displayName: "Macaco Club", isAllowed: true }
  );

  assert.equal(capturedRequest?.stopLoss, 103.5);
  assert.equal(orchestrator.listPositions()[0]?.stopLoss, 103.5);
  assert.match(notifier.notifications.at(-1)?.body ?? "", /adjusted from 101 to 103\.5/);

  db.close();
  cleanup(dbPath);
});

await run("clear stale local positions before blocking a fresh entry", async () => {
  const dbPath = "./data/test-orchestrator.db";
  cleanup(dbPath);
  const db = await AppDatabase.open(dbPath, orchestratorConfig.defaultRuntimeConfig);
  const notifier = new MockNotifier();
  const executor = new MockExecutor();
  let placeEntryCalls = 0;
  executor.placeEntry = async (_request: ExecutionRequest): Promise<ExecutionResult> => {
    placeEntryCalls += 1;
    return { status: "accepted", remoteOrderId: "order-new", remotePositionId: "position-new", resultingStatus: "OPEN" };
  };
  executor.getPositions = async (): Promise<PositionSnapshot[]> => [];

  db.upsertPosition({
    id: "stale-sol",
    symbol: "SOL",
    side: "LONG",
    status: "OPEN",
    entryPrice: 90,
    currentSize: 1,
    initialSize: 1,
    takeProfit: 100,
    stopLoss: 85,
    leverage: 10,
    margin: 25,
    sourceMessageId: "stale-message",
    sourceChatId: "1",
    senderId: "42",
    signalId: "stale",
    remoteOrderId: "stale-order",
    remotePositionId: "stale-position",
    profitActionApplied: false,
    lastError: null,
    createdAt: "2026-03-26T00:00:00.000Z",
    updatedAt: "2026-03-26T00:00:00.000Z"
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
      messageId: "m-fresh-sol",
      messageDate: "2026-03-26T00:05:00.000Z",
      rawText: "raw"
    },
    "1",
    { telegramUserId: "42", username: "MacacoClub_bot", displayName: "Macaco Club", isAllowed: true }
  );

  assert.equal(placeEntryCalls, 1);
  const allPositions = db.listAllPositions();
  assert.equal(allPositions.find((position) => position.id === "stale-sol")?.status, "CLOSED");
  assert.equal(orchestrator.listPositions()[0]?.sourceMessageId, "m-fresh-sol");
  assert.match(notifier.notifications[0]?.title ?? "", /Exchange sync updated local positions/);

  db.close();
  cleanup(dbPath);
});

await run("notify when a live/open position still blocks a new entry", async () => {
  const dbPath = "./data/test-orchestrator.db";
  cleanup(dbPath);
  const db = await AppDatabase.open(dbPath, orchestratorConfig.defaultRuntimeConfig);
  const notifier = new MockNotifier();
  const executor = new MockExecutor();
  let placeEntryCalls = 0;
  executor.placeEntry = async (_request: ExecutionRequest): Promise<ExecutionResult> => {
    placeEntryCalls += 1;
    return { status: "accepted", remoteOrderId: "order-new", remotePositionId: "position-new", resultingStatus: "OPEN" };
  };
  executor.getPositions = async (): Promise<PositionSnapshot[]> => ([
    {
      symbol: "SOL",
      side: "LONG",
      size: 1.2,
      entryPrice: 95,
      status: "OPEN"
    }
  ]);

  db.upsertPosition({
    id: "live-sol",
    symbol: "SOL",
    side: "LONG",
    status: "OPEN",
    entryPrice: 95,
    currentSize: 1.2,
    initialSize: 1.2,
    takeProfit: 105,
    stopLoss: 90,
    leverage: 10,
    margin: 25,
    sourceMessageId: "live-message",
    sourceChatId: "1",
    senderId: "42",
    signalId: "live",
    remoteOrderId: "live-order",
    remotePositionId: "live-position",
    profitActionApplied: false,
    lastError: null,
    createdAt: "2026-03-26T00:00:00.000Z",
    updatedAt: "2026-03-26T00:00:00.000Z"
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
      messageId: "m-blocked-sol",
      messageDate: "2026-03-26T00:05:00.000Z",
      rawText: "raw"
    },
    "1",
    { telegramUserId: "42", username: "MacacoClub_bot", displayName: "Macaco Club", isAllowed: true }
  );

  assert.equal(placeEntryCalls, 0);
  assert.equal(orchestrator.listPositions().length, 1);
  assert.equal(
    notifier.notifications.at(-1)?.title,
    "SOL LONG ignored"
  );
  assert.match(notifier.notifications.at(-1)?.body ?? "", /still exists after exchange sync/);

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
  assert.match(notifier.notifications.at(-1)?.body ?? "", /Requested leverage: 17x/);
  assert.match(notifier.notifications.at(-1)?.body ?? "", /Applied leverage: 16x/);

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
  executor.getPositions = async (): Promise<PositionSnapshot[]> => ([
    {
      symbol: "SOL",
      side: "LONG",
      size: 1.8,
      entryPrice: 100,
      status: "OPEN"
    }
  ]);
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

await run("reapply an entry from a stored position when no live position exists", async () => {
  const dbPath = "./data/test-orchestrator.db";
  cleanup(dbPath);
  const db = await AppDatabase.open(dbPath, orchestratorConfig.defaultRuntimeConfig);
  const notifier = new MockNotifier();
  const executor = new MockExecutor();
  let placeEntryCalls = 0;
  executor.getPositions = async (): Promise<PositionSnapshot[]> => [];
  executor.placeEntry = async (_request: ExecutionRequest): Promise<ExecutionResult> => {
    placeEntryCalls += 1;
    return {
      status: "accepted",
      remoteOrderId: "order-reapplied",
      remotePositionId: "position-reapplied",
      resultingStatus: "OPEN",
      metadata: { appliedLeverage: 12 }
    };
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
      messageId: "m-reapply-entry",
      messageDate: "2026-03-26T00:00:00.000Z",
      rawText: "raw"
    },
    "1",
    { telegramUserId: "42", username: "MacacoClub_bot", displayName: "Macaco Club", isAllowed: true }
  );

  const original = orchestrator.listPositions()[0];
  original.status = "CLOSED";
  original.currentSize = 0;
  db.upsertPosition(original);

  const refreshed = await orchestrator.reapplyEntry(original.id);
  assert.equal(placeEntryCalls, 2);
  assert.equal(refreshed?.status, "OPEN");
  assert.equal(refreshed?.leverage, 12);
  assert.equal(refreshed?.remoteOrderId, "order-reapplied");
  assert.equal(refreshed?.lastError, null);
  assert.match(notifier.notifications.at(-1)?.title ?? "", /\[SOL\] entry reapplied/);

  db.close();
  cleanup(dbPath);
});

await run("reject reapplying an entry when a live position already exists", async () => {
  const dbPath = "./data/test-orchestrator.db";
  cleanup(dbPath);
  const db = await AppDatabase.open(dbPath, orchestratorConfig.defaultRuntimeConfig);
  const notifier = new MockNotifier();
  const executor = new MockExecutor();
  executor.getPositions = async (): Promise<PositionSnapshot[]> => ([
    {
      symbol: "SOL",
      side: "LONG",
      size: 2.5,
      entryPrice: 100,
      status: "OPEN"
    }
  ]);

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
      messageId: "m-reapply-entry-live",
      messageDate: "2026-03-26T00:00:00.000Z",
      rawText: "raw"
    },
    "1",
    { telegramUserId: "42", username: "MacacoClub_bot", displayName: "Macaco Club", isAllowed: true }
  );

  const original = orchestrator.listPositions()[0];
  original.status = "CLOSED";
  original.currentSize = 0;
  db.upsertPosition(original);

  await assert.rejects(
    () => orchestrator.reapplyEntry(original.id),
    /already exists/
  );

  db.close();
  cleanup(dbPath);
});

await run("apply the profit action only once", async () => {
  const dbPath = "./data/test-orchestrator.db";
  cleanup(dbPath);
  const db = await AppDatabase.open(dbPath, orchestratorConfig.defaultRuntimeConfig);
  const notifier = new MockNotifier();
  const executor = new MockExecutor();
  let liveStopLoss = 90;
  executor.getPositions = async (): Promise<PositionSnapshot[]> => ([
    {
      symbol: "BNB",
      side: "LONG",
      size: 2,
      entryPrice: 100,
      takeProfit: 120,
      stopLoss: liveStopLoss,
      status: "OPEN"
    }
  ]);
  executor.moveStopLoss = async (_position: PositionState, stopLoss: number): Promise<ExecutionResult> => {
    liveStopLoss = stopLoss;
    return { status: "accepted", resultingStatus: "OPEN" };
  };
  const orchestrator = new TradeOrchestrator(
    orchestratorConfig,
    db,
    executor,
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

await run("reject the profit action when no live position exists", async () => {
  const dbPath = "./data/test-orchestrator.db";
  cleanup(dbPath);
  const db = await AppDatabase.open(dbPath, orchestratorConfig.defaultRuntimeConfig);
  const notifier = new MockNotifier();
  const executor = new MockExecutor();
  let moveStopCalls = 0;
  let partialCloseCalls = 0;
  executor.moveStopLoss = async (_position: PositionState, _stopLoss: number): Promise<ExecutionResult> => {
    moveStopCalls += 1;
    return { status: "accepted", resultingStatus: "OPEN" };
  };
  executor.partialCloseReduceOnly = async (_position: PositionState, _percent: number): Promise<ExecutionResult> => {
    partialCloseCalls += 1;
    return { status: "accepted", resultingStatus: "OPEN", metadata: { remainingSize: 1.4 } };
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
      symbol: "BNB",
      side: "LONG",
      entry: 100,
      takeProfit: 120,
      stopLoss: 90,
      leverage: 10,
      statusText: "Aguardando confirmação",
      messageId: "m-live-check",
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
      messageId: "m-live-check-profit",
      messageDate: "2026-03-26T00:01:00.000Z",
      rawText: "raw"
    },
    "1",
    { telegramUserId: "42", username: "MacacoClub_bot", displayName: "Macaco Club", isAllowed: true }
  );

  const position = orchestrator.listPositions()[0];
  assert.equal(position.profitActionApplied, false);
  assert.match(position.lastError ?? "", /No live BNB LONG position found/);
  assert.equal(moveStopCalls, 0);
  assert.equal(partialCloseCalls, 0);
  assert.equal(notifier.notifications.at(-1)?.title, "Signal processing failed");

  db.close();
  cleanup(dbPath);
});

await run("reject moving the stop to entry when the live stop does not change", async () => {
  const dbPath = "./data/test-orchestrator.db";
  cleanup(dbPath);
  const db = await AppDatabase.open(dbPath, orchestratorConfig.defaultRuntimeConfig);
  const notifier = new MockNotifier();
  const executor = new MockExecutor();

  executor.getPositions = async (): Promise<PositionSnapshot[]> => ([
    {
      symbol: "SOL",
      side: "LONG",
      size: 2.5,
      entryPrice: 100,
      takeProfit: 110,
      stopLoss: 95,
      leverage: 10,
      status: "OPEN",
      remotePositionId: "SOL:LONG"
    }
  ]);
  executor.moveStopLoss = async (_position: PositionState, _stopLoss: number): Promise<ExecutionResult> => (
    { status: "accepted", resultingStatus: "OPEN" }
  );

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
      messageId: "m-manual-sl",
      messageDate: "2026-03-26T00:00:00.000Z",
      rawText: "raw"
    },
    "1",
    { telegramUserId: "42", username: "MacacoClub_bot", displayName: "Macaco Club", isAllowed: true }
  );

  const position = orchestrator.listPositions()[0];
  await assert.rejects(
    () => orchestrator.moveStopLossToEntry(position.id),
    /stop loss did not update/
  );

  const refreshed = orchestrator.listPositions()[0];
  assert.equal(refreshed.stopLoss, 95);
  assert.match(refreshed.lastError ?? "", /Expected: 100/);

  db.close();
  cleanup(dbPath);
});

await run("sync positions from exchange closes stale locals and imports live positions", async () => {
  const dbPath = "./data/test-orchestrator.db";
  cleanup(dbPath);
  const db = await AppDatabase.open(dbPath, orchestratorConfig.defaultRuntimeConfig);
  const notifier = new MockNotifier();
  const executor = new MockExecutor();
  executor.getPositions = async (): Promise<PositionSnapshot[]> => ([
    {
      symbol: "ETH",
      side: "SHORT",
      size: 0.75,
      entryPrice: 2000,
      takeProfit: 1900,
      stopLoss: 2050,
      leverage: 8,
      status: "OPEN",
      remotePositionId: "ETH:SHORT"
    }
  ]);
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
      messageId: "m-sync-sol",
      messageDate: "2026-03-26T00:00:00.000Z",
      rawText: "raw"
    },
    "1",
    { telegramUserId: "42", username: "MacacoClub_bot", displayName: "Macaco Club", isAllowed: true }
  );

  const summary = await orchestrator.syncPositionsFromExchange();
  assert.deepEqual(summary, { synced: 0, created: 1, closed: 1 });

  const positions = db.listAllPositions();
  const closedSol = positions.find((position) => position.symbol === "SOL" && position.side === "LONG");
  const importedEth = positions.find((position) => position.symbol === "ETH" && position.side === "SHORT");

  assert.equal(closedSol?.status, "CLOSED");
  assert.equal(closedSol?.currentSize, 0);
  assert.equal(importedEth?.status, "OPEN");
  assert.equal(importedEth?.entryPrice, 2000);
  assert.equal(importedEth?.currentSize, 0.75);
  assert.equal(importedEth?.takeProfit, 1900);
  assert.equal(importedEth?.stopLoss, 2050);
  assert.equal(importedEth?.leverage, 8);
  assert.equal(importedEth?.remotePositionId, "ETH:SHORT");
  assert.match(importedEth?.lastError ?? "", /Synced from exchange/);

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

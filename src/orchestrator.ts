import type { Logger } from "pino";

import type { AppDatabase } from "./db.js";
import type { Notifier } from "./notifier.js";
import type {
  AppConfig,
  ExecutionRequest,
  ExecutionResult,
  ParsedEntrySignal,
  ParsedProfitSignal,
  ParsedSignal,
  PnlSummary,
  PositionState,
  RuntimeConfig,
  SenderIdentity
} from "./types.js";
import { newId, nowIso, round } from "./utils.js";
import type { ExecutionAdapter } from "./trading/executionAdapter.js";

export class TradeOrchestrator {
  public constructor(
    private readonly config: AppConfig,
    private readonly database: AppDatabase,
    private readonly executor: ExecutionAdapter,
    private readonly notifier: Notifier,
    private readonly logger: Logger
  ) {}

  public getRuntimeConfig(): RuntimeConfig {
    return this.database.getRuntimeConfig();
  }

  public updateRuntimeConfig(patch: Partial<RuntimeConfig>): RuntimeConfig {
    return this.database.updateRuntimeConfig(patch);
  }

  public listPositions(): PositionState[] {
    return this.database.listActivePositions();
  }

  public resetLocalPositions(): number {
    const activePositions = this.database.listActivePositions();
    if (activePositions.length === 0) {
      return 0;
    }

    const updatedAt = nowIso();
    for (const position of activePositions) {
      position.status = position.status === "PENDING" ? "CANCELLED" : "CLOSED";
      position.currentSize = 0;
      position.updatedAt = updatedAt;
      this.database.upsertPosition(position);
    }

    this.logger.warn(
      {
        count: activePositions.length,
        mode: this.config.valiantExecutionMode,
        dryRun: this.database.getRuntimeConfig().dryRun
      },
      "Reset local active positions"
    );

    return activePositions.length;
  }

  public getExecutionMode(): AppConfig["valiantExecutionMode"] {
    return this.config.valiantExecutionMode;
  }

  public async getPnlSummary(): Promise<PnlSummary> {
    const openSnapshots = await this.executor.getPositions();
    const localPositions = this.database.listAllPositions();
    return {
      realizedPnl: 0,
      unrealizedPnl: openSnapshots.reduce((sum, position) => sum + (position.unrealizedPnl ?? 0), 0),
      openPositions: openSnapshots.length,
      closedPositions: localPositions.filter((position) => position.status === "CLOSED").length
    };
  }

  public async handleParsedSignal(signal: ParsedSignal, chatId: string, sender: SenderIdentity): Promise<void> {
    if (this.database.hasProcessedMessage(signal.messageId, chatId)) {
      this.logger.info({ messageId: signal.messageId }, "Ignoring duplicate Telegram message");
      return;
    }

    try {
      if (signal.type === "ENTRY") {
        await this.handleEntrySignal(signal, chatId, sender);
      } else {
        await this.handleProfitSignal(signal);
      }
      this.database.markMessageProcessed(signal, chatId, sender.telegramUserId);
    } catch (error) {
      this.logger.error({ error, signal }, "Failed to process signal");
      await this.notifier.notify({
        type: "ERROR",
        title: "Signal processing failed",
        body: `Message ${signal.messageId} could not be processed.\n\nReason: ${String(error)}`,
        dedupeKey: `error:${signal.messageId}`
      });
    }
  }

  private validateSymbol(symbol: string): void {
    if (!this.config.symbolWhitelist.includes(symbol)) {
      throw new Error(`Symbol ${symbol} is not allowed`);
    }
  }

  private validateEntrySignal(signal: ParsedEntrySignal, runtimeConfig: RuntimeConfig): void {
    this.validateSymbol(signal.symbol);
    if (signal.entry <= 0 || signal.takeProfit <= 0 || signal.stopLoss <= 0) {
      throw new Error("Signal contains invalid price values");
    }
    if (signal.side === "LONG" && !(signal.stopLoss < signal.entry && signal.takeProfit > signal.entry)) {
      throw new Error("LONG signal TP/SL are inconsistent with entry");
    }
    if (signal.side === "SHORT" && !(signal.stopLoss > signal.entry && signal.takeProfit < signal.entry)) {
      throw new Error("SHORT signal TP/SL are inconsistent with entry");
    }
    if (signal.leverage > runtimeConfig.maxLeverageCap) {
      throw new Error(`Signal leverage ${signal.leverage} exceeds configured max cap ${runtimeConfig.maxLeverageCap}`);
    }
  }

  private buildPosition(
    signal: ParsedEntrySignal,
    chatId: string,
    senderId: string,
    runtimeConfig: RuntimeConfig,
    appliedLeverage: number,
    remoteOrderId?: string,
    remotePositionId?: string,
    status: PositionState["status"] = "OPEN"
  ): PositionState {
    const size = round((runtimeConfig.marginPerTrade * appliedLeverage) / signal.entry, 8);
    const timestamp = nowIso();
    return {
      id: newId(),
      symbol: signal.symbol,
      side: signal.side,
      status,
      entryPrice: signal.entry,
      currentSize: size,
      initialSize: size,
      takeProfit: signal.takeProfit,
      stopLoss: signal.stopLoss,
      leverage: appliedLeverage,
      margin: runtimeConfig.marginPerTrade,
      sourceMessageId: signal.messageId,
      sourceChatId: chatId,
      senderId,
      signalId: signal.signalId,
      remoteOrderId: remoteOrderId ?? null,
      remotePositionId: remotePositionId ?? null,
      profitActionApplied: false,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
  }

  private resolveAppliedLeverage(signal: ParsedEntrySignal, result: ExecutionResult): number {
    const appliedLeverage = result.metadata?.appliedLeverage;
    if (typeof appliedLeverage === "number" && Number.isFinite(appliedLeverage) && appliedLeverage > 0) {
      return appliedLeverage;
    }

    return signal.leverage;
  }

  private async handleEntrySignal(signal: ParsedEntrySignal, chatId: string, sender: SenderIdentity): Promise<void> {
    const runtimeConfig = this.database.getRuntimeConfig();
    if (runtimeConfig.paused) {
      this.logger.info({ signal }, "Bot is paused; skipping entry signal");
      return;
    }

    this.validateEntrySignal(signal, runtimeConfig);
    const activeForSymbol = this.database.findActivePositionBySymbol(signal.symbol);
    if (activeForSymbol?.status === "OPEN") {
      this.logger.info({ symbol: signal.symbol }, "Ignoring entry because open position already exists for symbol");
      return;
    }

    if (activeForSymbol?.status === "PENDING") {
      await this.executor.cancelPendingByTicker(signal.symbol);
      activeForSymbol.status = "CANCELLED";
      activeForSymbol.updatedAt = nowIso();
      this.database.upsertPosition(activeForSymbol);
    }

    const request: ExecutionRequest = {
      symbol: signal.symbol,
      side: signal.side,
      entryPrice: signal.entry,
      takeProfit: signal.takeProfit,
      stopLoss: signal.stopLoss,
      leverage: signal.leverage,
      margin: runtimeConfig.marginPerTrade,
      sourceMessageId: signal.messageId,
      signalId: signal.signalId
    };

    const result = await this.executor.placeEntry(request);
    if (result.status !== "accepted") {
      await this.notifier.notify({
        type: "ENTRY_REJECTED",
        title: `${signal.symbol} ${signal.side} rejected`,
        body: `Entry signal ${signal.messageId} was rejected.\n\nReason: ${result.reason ?? "unknown"}`,
        dedupeKey: `entry-rejected:${signal.messageId}`
      });
      return;
    }

    const appliedLeverage = this.resolveAppliedLeverage(signal, result);
    const position = this.buildPosition(
      signal,
      chatId,
      sender.telegramUserId,
      runtimeConfig,
      appliedLeverage,
      result.remoteOrderId,
      result.remotePositionId,
      result.resultingStatus ?? "OPEN"
    );
    this.database.upsertPosition(position);
    const protectionResult = await this.executor.setProtectionOrders(position);
    const protectionFailureReason = protectionResult.status === "accepted"
      ? null
      : (protectionResult.reason ?? "Failed to place TP/SL orders");

    if (protectionFailureReason) {
      position.lastError = protectionFailureReason;
      position.updatedAt = nowIso();
      this.database.upsertPosition(position);
      this.logger.warn(
        {
          symbol: position.symbol,
          side: position.side,
          positionId: position.id,
          reason: protectionFailureReason
        },
        "Entry was placed but protection orders failed"
      );
    } else if (position.lastError) {
      position.lastError = null;
      position.updatedAt = nowIso();
      this.database.upsertPosition(position);
    }

    const isDryRunExecution = this.config.valiantExecutionMode === "dry-run";
    await this.notifier.notify({
      type: "ENTRY_PLACED",
      title: isDryRunExecution
        ? `[DRY RUN] [${position.symbol}] ${position.side} simulated`
        : protectionFailureReason
          ? `[${position.symbol}] ${position.side} order placed with TP/SL warning`
        : `[${position.symbol}] ${position.side} order placed`,
      body: [
        `Execution adapter: ${this.config.valiantExecutionMode}`,
        ...(isDryRunExecution ? ["No live order was sent to Valiant."] : []),
        `Entry: ${position.entryPrice}`,
        `TP: ${position.takeProfit}`,
        `SL: ${position.stopLoss}`,
        ...(protectionFailureReason ? [`Protection orders: ${protectionFailureReason}`] : ["Protection orders: configured"]),
        `Leverage: ${position.leverage}x`,
        `Margin: ${position.margin} USDC`,
        `Message: ${position.sourceMessageId}`
      ].join("\n"),
      dedupeKey: `entry:${position.id}`
    });
  }

  private async handleProfitSignal(signal: ParsedProfitSignal): Promise<void> {
    const position = this.database.findOpenPosition(signal.symbol, signal.side);
    if (!position) {
      this.logger.info({ signal }, "Ignoring profit signal without matching open position");
      return;
    }
    if (position.profitActionApplied) {
      this.logger.info({ positionId: position.id }, "Ignoring profit signal because action already applied");
      return;
    }

    const runtimeConfig = this.database.getRuntimeConfig();
    await this.executor.moveStopLoss(position, position.entryPrice);
    await this.executor.partialCloseReduceOnly(position, runtimeConfig.profitPartialClosePercent);

    position.stopLoss = position.entryPrice;
    position.currentSize = round(position.currentSize * (1 - runtimeConfig.profitPartialClosePercent / 100), 8);
    position.profitActionApplied = true;
    position.updatedAt = nowIso();
    this.database.upsertPosition(position);

    await this.notifier.notify({
      type: "PROFIT_ACTION_APPLIED",
      title: `[${position.symbol}] profit action applied`,
      body: [
        `Side: ${position.side}`,
        `Stop moved to entry: ${position.entryPrice}`,
        `Partial close: ${runtimeConfig.profitPartialClosePercent}%`,
        `Remaining size: ${position.currentSize}`,
        `Message: ${signal.messageId}`
      ].join("\n"),
      dedupeKey: `profit:${position.id}`
    });
  }

  public async closePosition(positionId: string): Promise<PositionState | undefined> {
    const position = this.database.getPositionById(positionId);
    if (!position) {
      return undefined;
    }

    const result = await this.executor.closePositionReduceOnly(position);
    if (result.status !== "accepted") {
      throw new Error(result.reason ?? "Failed to close position");
    }

    position.status = "CLOSED";
    position.currentSize = 0;
    position.updatedAt = nowIso();
    this.database.upsertPosition(position);

    await this.notifier.notify({
      type: "POSITION_CLOSED",
      title: `[${position.symbol}] position closed`,
      body: `Manual close executed for ${position.side} ${position.symbol}.`,
      dedupeKey: `closed:${position.id}:${position.updatedAt}`
    });

    return position;
  }

  public async moveStopLossToEntry(positionId: string): Promise<PositionState | undefined> {
    const position = this.database.getPositionById(positionId);
    if (!position) {
      return undefined;
    }

    const result = await this.executor.moveStopLoss(position, position.entryPrice);
    if (result.status !== "accepted") {
      throw new Error(result.reason ?? "Failed to move stop loss");
    }

    position.stopLoss = position.entryPrice;
    position.updatedAt = nowIso();
    this.database.upsertPosition(position);
    return position;
  }

  public async reapplyProtectionOrders(positionId: string): Promise<PositionState | undefined> {
    const position = this.database.getPositionById(positionId);
    if (!position) {
      return undefined;
    }

    const result = await this.executor.setProtectionOrders(position);
    if (result.status !== "accepted") {
      position.lastError = result.reason ?? "Failed to reapply TP/SL orders";
      position.updatedAt = nowIso();
      this.database.upsertPosition(position);
      throw new Error(position.lastError);
    }

    position.lastError = null;
    position.updatedAt = nowIso();
    this.database.upsertPosition(position);

    await this.notifier.notify({
      type: "INFO",
      title: `[${position.symbol}] TP/SL reapplied`,
      body: [
        `Side: ${position.side}`,
        `TP: ${position.takeProfit}`,
        `SL: ${position.stopLoss}`,
        `Position: ${position.id}`
      ].join("\n"),
      dedupeKey: `tpsl:${position.id}:${position.updatedAt}`
    });

    return position;
  }
}

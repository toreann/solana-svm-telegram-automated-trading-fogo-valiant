import type { Logger } from "pino";

import type { AppDatabase } from "./db.js";
import type { Notifier } from "./notifier.js";
import type {
  AgentSessionStatus,
  AppConfig,
  ExecutionRequest,
  ExecutionResult,
  ParsedEntrySignal,
  ParsedProfitSignal,
  ParsedSignal,
  PnlSummary,
  PositionSnapshot,
  PositionState,
  RuntimeConfig,
  SenderIdentity
} from "./types.js";
import { newId, nowIso, round } from "./utils.js";
import type { ExecutionAdapter } from "./trading/executionAdapter.js";

const MIN_ENTRY_STOP_DISTANCE_PCT = 0.035;

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

  public async syncPositionsFromExchange(options?: { notify?: boolean; reason?: string }): Promise<{ synced: number; created: number; closed: number }> {
    const liveSnapshots = await this.executor.getPositions();
    const liveOpenPositions = liveSnapshots.filter((position) => position.status === "OPEN");
    const activePositions = this.database.listActivePositions();
    const allPositions = this.database.listAllPositions();
    const runtimeConfig = this.database.getRuntimeConfig();
    const updatedAt = nowIso();

    const localByMarket = new Map<string, PositionState>();
    for (const position of allPositions) {
      const key = `${position.symbol}:${position.side}`;
      if (!localByMarket.has(key)) {
        localByMarket.set(key, position);
      }
    }

    let synced = 0;
    let created = 0;
    let closed = 0;
    const liveKeys = new Set(liveOpenPositions.map((position) => `${position.symbol}:${position.side}`));

    for (const localPosition of activePositions) {
      const key = `${localPosition.symbol}:${localPosition.side}`;
      if (liveKeys.has(key)) {
        continue;
      }

      localPosition.status = "CLOSED";
      localPosition.currentSize = 0;
      localPosition.lastError = "Closed locally during exchange sync because no live position was found";
      localPosition.updatedAt = updatedAt;
      this.database.upsertPosition(localPosition);
      closed += 1;
    }

    for (const livePosition of liveOpenPositions) {
      const key = `${livePosition.symbol}:${livePosition.side}`;
      const existing = localByMarket.get(key);
      if (existing) {
        existing.status = "OPEN";
        existing.entryPrice = livePosition.entryPrice;
        existing.currentSize = livePosition.size;
        existing.initialSize = Math.max(existing.initialSize, livePosition.size);
        existing.takeProfit = livePosition.takeProfit ?? existing.takeProfit;
        existing.stopLoss = livePosition.stopLoss ?? existing.stopLoss;
        existing.leverage = livePosition.leverage ?? existing.leverage;
        existing.remotePositionId = livePosition.remotePositionId ?? existing.remotePositionId ?? null;
        existing.lastError = null;
        existing.updatedAt = updatedAt;
        this.database.upsertPosition(existing);
        synced += 1;
        continue;
      }

      this.database.upsertPosition({
        id: newId(),
        symbol: livePosition.symbol,
        side: livePosition.side,
        status: "OPEN",
        entryPrice: livePosition.entryPrice,
        currentSize: livePosition.size,
        initialSize: livePosition.size,
        takeProfit: livePosition.takeProfit ?? 0,
        stopLoss: livePosition.stopLoss ?? 0,
        leverage: livePosition.leverage ?? 0,
        margin: runtimeConfig.marginPerTrade,
        sourceMessageId: "exchange-sync",
        sourceChatId: "exchange-sync",
        senderId: "exchange-sync",
        signalId: null,
        remoteOrderId: null,
        remotePositionId: livePosition.remotePositionId ?? null,
        profitActionApplied: false,
        lastError: "Synced from exchange; TP/SL and leverage need to be set or rediscovered locally",
        createdAt: updatedAt,
        updatedAt
      });
      created += 1;
    }

    this.logger.info(
      {
        synced,
        created,
        closed,
        liveCount: liveOpenPositions.length,
        mode: this.config.valiantExecutionMode
      },
      "Synchronized local positions from exchange"
    );

    const summary = { synced, created, closed };
    if (options?.notify && (synced > 0 || created > 0 || closed > 0)) {
      await this.notifier.notify({
        type: "INFO",
        title: "Exchange sync updated local positions",
        body: [
          `Reason: ${options.reason ?? "exchange sync"}`,
          `Updated existing positions: ${synced}`,
          `Imported new positions: ${created}`,
          `Closed stale local positions: ${closed}`
        ].join("\n"),
        dedupeKey: `sync:${options.reason ?? "exchange"}:${updatedAt}`
      });
    }

    return summary;
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

  public async getAgentSessionStatus(): Promise<AgentSessionStatus> {
    if (!this.executor.getAgentSessionStatus) {
      return {
        masterAccountAddress: this.config.valiantMasterAccountAddress,
        approvedAgentAddress: null,
        activeAgentAddress: null,
        envFallbackAgentAddress: null,
        approvalStatus: "missing",
        lastCheckedAt: new Date().toISOString(),
        lastSyncAt: null,
        lastError: "The current execution adapter does not expose agent session status."
      };
    }

    return this.executor.getAgentSessionStatus();
  }

  public async syncAgentSession(): Promise<AgentSessionStatus> {
    if (!this.executor.syncAgentSession) {
      return {
        masterAccountAddress: this.config.valiantMasterAccountAddress,
        approvedAgentAddress: null,
        activeAgentAddress: null,
        envFallbackAgentAddress: null,
        approvalStatus: "missing",
        lastCheckedAt: new Date().toISOString(),
        lastSyncAt: null,
        lastError: "The current execution adapter does not support agent sync."
      };
    }

    return this.executor.syncAgentSession();
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
    if (
      !Number.isFinite(signal.entry) || signal.entry <= 0
      || !Number.isFinite(signal.takeProfit) || signal.takeProfit <= 0
      || !Number.isFinite(signal.stopLoss) || signal.stopLoss <= 0
    ) {
      throw new Error("Signal contains invalid price values");
    }
    if (!Number.isFinite(signal.leverage) || signal.leverage <= 0) {
      throw new Error("Signal contains an invalid leverage value");
    }
    if (!signal.statusText.trim()) {
      throw new Error("Signal status text is empty");
    }
    if (signal.entry === signal.takeProfit || signal.entry === signal.stopLoss || signal.takeProfit === signal.stopLoss) {
      throw new Error("Signal entry, TP, and SL must all be different values");
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

  private applyMinimumStopDistance(signal: ParsedEntrySignal): number | null {
    const minimumDistance = signal.entry * MIN_ENTRY_STOP_DISTANCE_PCT;
    if (!(minimumDistance > 0)) {
      return null;
    }

    const adjustedStopLoss = signal.side === "LONG"
      ? round(signal.entry - minimumDistance, 8)
      : round(signal.entry + minimumDistance, 8);

    if (signal.side === "LONG" && signal.stopLoss > adjustedStopLoss) {
      const originalStopLoss = signal.stopLoss;
      signal.stopLoss = adjustedStopLoss;
      return originalStopLoss;
    }

    if (signal.side === "SHORT" && signal.stopLoss < adjustedStopLoss) {
      const originalStopLoss = signal.stopLoss;
      signal.stopLoss = adjustedStopLoss;
      return originalStopLoss;
    }

    return null;
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

  private resolveAppliedLeverageFromPosition(position: PositionState, result: ExecutionResult): number {
    const appliedLeverage = result.metadata?.appliedLeverage;
    if (typeof appliedLeverage === "number" && Number.isFinite(appliedLeverage) && appliedLeverage > 0) {
      return appliedLeverage;
    }

    return position.leverage;
  }

  private async requireLivePosition(position: PositionState, action: string): Promise<PositionSnapshot> {
    const livePosition = (await this.executor.getPositions()).find(
      (snapshot) => snapshot.symbol === position.symbol && snapshot.side === position.side && snapshot.status === "OPEN"
    );
    if (livePosition) {
      return livePosition;
    }

    position.lastError = `No live ${position.symbol} ${position.side} position found while trying to ${action}`;
    position.updatedAt = nowIso();
    this.database.upsertPosition(position);
    throw new Error(position.lastError);
  }

  private pricesMatch(actual: number | null | undefined, expected: number): boolean {
    if (typeof actual !== "number" || !Number.isFinite(actual)) {
      return false;
    }

    return Math.abs(actual - expected) <= Math.max(1e-8, Math.abs(expected) * 1e-6);
  }

  private async confirmLiveStopLoss(position: PositionState, expectedStopLoss: number, action: string): Promise<void> {
    const livePosition = await this.requireLivePosition(position, action);
    if (this.pricesMatch(livePosition.stopLoss, expectedStopLoss)) {
      return;
    }

    position.lastError = [
      `Live ${position.symbol} ${position.side} stop loss did not update after trying to ${action}.`,
      `Expected: ${expectedStopLoss}`,
      `Found: ${livePosition.stopLoss ?? "missing"}`
    ].join(" ");
    position.updatedAt = nowIso();
    this.database.upsertPosition(position);
    throw new Error(position.lastError);
  }

  private async handleEntrySignal(signal: ParsedEntrySignal, chatId: string, sender: SenderIdentity): Promise<void> {
    const runtimeConfig = this.database.getRuntimeConfig();
    if (runtimeConfig.paused) {
      this.logger.info({ signal }, "Bot is paused; skipping entry signal");
      await this.notifier.notify({
        type: "INFO",
        title: `${signal.symbol} ${signal.side} ignored`,
        body: `Entry signal ${signal.messageId} was ignored because the bot is paused.`,
        dedupeKey: `entry-paused:${signal.messageId}`
      });
      return;
    }

    const adjustedStopLossFrom = this.applyMinimumStopDistance(signal);
    this.validateEntrySignal(signal, runtimeConfig);
    let activeForSymbol = this.database.findActivePositionBySymbol(signal.symbol);
    if (activeForSymbol?.status === "OPEN") {
      await this.syncPositionsFromExchange({ notify: true, reason: "entry guard sync" });
      activeForSymbol = this.database.findActivePositionBySymbol(signal.symbol);
      if (activeForSymbol?.status === "OPEN") {
        this.logger.info({ symbol: signal.symbol }, "Ignoring entry because open position already exists for symbol");
        await this.notifier.notify({
          type: "INFO",
          title: `${signal.symbol} ${signal.side} ignored`,
          body: `Entry signal ${signal.messageId} was ignored because a live/open ${signal.symbol} position still exists after exchange sync.`,
          dedupeKey: `entry-open:${signal.messageId}`
        });
        return;
      }
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

    const executionAdapter = typeof result.metadata?.adapter === "string"
      ? result.metadata.adapter
      : this.config.valiantExecutionMode;
    const isDryRunExecution = executionAdapter === "dry-run";
    const leverageLines = position.leverage === signal.leverage
      ? [`Leverage: ${position.leverage}x`]
      : [`Requested leverage: ${signal.leverage}x`, `Applied leverage: ${position.leverage}x`];
    await this.notifier.notify({
      type: "ENTRY_PLACED",
      title: isDryRunExecution
        ? `[DRY RUN] [${position.symbol}] ${position.side} simulated`
        : protectionFailureReason
          ? `[${position.symbol}] ${position.side} order placed with TP/SL warning`
        : `[${position.symbol}] ${position.side} order placed`,
      body: [
        `Execution adapter: ${executionAdapter}`,
        ...(isDryRunExecution ? ["No live order was sent to Valiant."] : []),
        `Entry: ${position.entryPrice}`,
        `TP: ${position.takeProfit}`,
        `SL: ${position.stopLoss}`,
        ...(adjustedStopLossFrom === null
          ? []
          : [`Signal SL adjusted from ${adjustedStopLossFrom} to ${position.stopLoss} to enforce a 3.5% minimum stop distance.`]),
        ...(protectionFailureReason ? [`Protection orders: ${protectionFailureReason}`] : ["Protection orders: configured"]),
        ...leverageLines,
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
    await this.requireLivePosition(position, "apply the profit action");

    const moveStopResult = await this.executor.moveStopLoss(position, position.entryPrice);
    if (moveStopResult.status !== "accepted") {
      position.lastError = moveStopResult.reason ?? "Failed to move stop loss";
      position.updatedAt = nowIso();
      this.database.upsertPosition(position);
      throw new Error(position.lastError);
    }
    await this.confirmLiveStopLoss(position, position.entryPrice, "move the stop loss to entry");

    const partialCloseResult = await this.executor.partialCloseReduceOnly(position, runtimeConfig.profitPartialClosePercent);
    if (partialCloseResult.status !== "accepted") {
      position.lastError = partialCloseResult.reason ?? "Failed to partially close the live position";
      position.updatedAt = nowIso();
      this.database.upsertPosition(position);
      throw new Error(position.lastError);
    }

    position.stopLoss = position.entryPrice;
    position.currentSize = (() => {
      const remainingSize = partialCloseResult.metadata?.remainingSize;
      if (typeof remainingSize === "number" && Number.isFinite(remainingSize) && remainingSize >= 0) {
        return remainingSize;
      }
      return round(position.currentSize * (1 - runtimeConfig.profitPartialClosePercent / 100), 8);
    })();
    position.status = partialCloseResult.resultingStatus ?? position.status;
    position.profitActionApplied = true;
    position.lastError = null;
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

    await this.requireLivePosition(position, "move the stop loss");
    const result = await this.executor.moveStopLoss(position, position.entryPrice);
    if (result.status !== "accepted") {
      throw new Error(result.reason ?? "Failed to move stop loss");
    }
    await this.confirmLiveStopLoss(position, position.entryPrice, "move the stop loss to entry");

    position.stopLoss = position.entryPrice;
    position.lastError = null;
    position.updatedAt = nowIso();
    this.database.upsertPosition(position);
    return position;
  }

  public async reapplyProtectionOrders(positionId: string): Promise<PositionState | undefined> {
    const position = this.database.getPositionById(positionId);
    if (!position) {
      return undefined;
    }

    await this.requireLivePosition(position, "reapply TP/SL");
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

  public async reapplyEntry(positionId: string): Promise<PositionState | undefined> {
    const position = this.database.getPositionById(positionId);
    if (!position) {
      return undefined;
    }

    const runtimeConfig = this.database.getRuntimeConfig();
    const liveMatch = (await this.executor.getPositions()).find(
      (snapshot) => snapshot.symbol === position.symbol && snapshot.side === position.side && snapshot.status === "OPEN"
    );
    if (liveMatch) {
      position.lastError = `A live ${position.symbol} ${position.side} position already exists; refusing to reapply the entry`;
      position.updatedAt = nowIso();
      this.database.upsertPosition(position);
      throw new Error(position.lastError);
    }

    const request: ExecutionRequest = {
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      takeProfit: position.takeProfit,
      stopLoss: position.stopLoss,
      leverage: position.leverage,
      margin: position.margin,
      sourceMessageId: position.sourceMessageId,
      signalId: position.signalId ?? undefined
    };

    const result = await this.executor.placeEntry(request);
    if (result.status !== "accepted") {
      position.lastError = result.reason ?? "Failed to reapply the entry";
      position.updatedAt = nowIso();
      this.database.upsertPosition(position);
      throw new Error(position.lastError);
    }

    const appliedLeverage = this.resolveAppliedLeverageFromPosition(position, result);
    const nextSize = round((position.margin * appliedLeverage) / position.entryPrice, 8);
    position.status = result.resultingStatus ?? "OPEN";
    position.currentSize = nextSize;
    position.initialSize = nextSize;
    position.leverage = appliedLeverage;
    position.remoteOrderId = result.remoteOrderId ?? position.remoteOrderId ?? null;
    position.remotePositionId = result.remotePositionId ?? position.remotePositionId ?? null;
    position.profitActionApplied = false;
    position.lastError = null;
    position.updatedAt = nowIso();
    this.database.upsertPosition(position);

    const protectionResult = await this.executor.setProtectionOrders(position);
    if (protectionResult.status !== "accepted") {
      position.lastError = protectionResult.reason ?? "Entry was reapplied, but TP/SL could not be configured";
      position.updatedAt = nowIso();
      this.database.upsertPosition(position);
    }

    await this.notifier.notify({
      type: "INFO",
      title: `[${position.symbol}] entry reapplied`,
      body: [
        `Side: ${position.side}`,
        `Entry: ${position.entryPrice}`,
        `TP: ${position.takeProfit}`,
        `SL: ${position.stopLoss}`,
        `Leverage: ${position.leverage}x`,
        `Status: ${position.status}`,
        ...(position.lastError ? [`Protection orders: ${position.lastError}`] : ["Protection orders: configured"])
      ].join("\n"),
      dedupeKey: `entry-reapply:${position.id}:${position.updatedAt}`
    });

    return position;
  }
}

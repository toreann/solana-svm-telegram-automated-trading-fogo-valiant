export type TradeSide = "LONG" | "SHORT";
export type PositionStatus = "PENDING" | "OPEN" | "CLOSED" | "FAILED" | "CANCELLED";
export type ExecutionMode = "dry-run" | "private" | "playwright" | "hybrid";
export type SignalType = "ENTRY" | "PROFIT";

export interface SenderIdentity {
  telegramUserId: string;
  username?: string | null;
  displayName?: string | null;
  isAllowed: boolean;
}

export interface RuntimeConfig {
  marginPerTrade: number;
  maxLeverageCap: number;
  profitPartialClosePercent: number;
  paused: boolean;
  dryRun: boolean;
}

export interface ParsedSignalBase {
  type: SignalType;
  symbol: string;
  side: TradeSide;
  messageId: string;
  messageDate: string;
  rawText: string;
}

export interface ParsedEntrySignal extends ParsedSignalBase {
  type: "ENTRY";
  entry: number;
  takeProfit: number;
  stopLoss: number;
  leverage: number;
  statusText: string;
  signalId?: string;
}

export interface ParsedProfitSignal extends ParsedSignalBase {
  type: "PROFIT";
  currentProfitPct: number;
  leveragedProfitPct?: number | null;
  priceFrom: number;
  priceTo: number;
  signalId?: string;
}

export type ParsedSignal = ParsedEntrySignal | ParsedProfitSignal;

export interface PositionState {
  id: string;
  symbol: string;
  side: TradeSide;
  status: PositionStatus;
  entryPrice: number;
  currentSize: number;
  initialSize: number;
  takeProfit: number;
  stopLoss: number;
  leverage: number;
  margin: number;
  sourceMessageId: string;
  sourceChatId: string;
  senderId: string;
  signalId?: string | null;
  remoteOrderId?: string | null;
  remotePositionId?: string | null;
  profitActionApplied: boolean;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionRequest {
  symbol: string;
  side: TradeSide;
  entryPrice: number;
  takeProfit: number;
  stopLoss: number;
  leverage: number;
  margin: number;
  sourceMessageId: string;
  signalId?: string;
}

export interface ProfitActionRequest {
  positionId: string;
  symbol: string;
  side: TradeSide;
  breakevenPrice: number;
  partialClosePercent: number;
}

export interface ExecutionResult {
  status: "accepted" | "rejected" | "failed";
  remoteOrderId?: string;
  remotePositionId?: string;
  resultingStatus?: PositionStatus;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface PositionSnapshot {
  symbol: string;
  side: TradeSide;
  size: number;
  entryPrice: number;
  takeProfit?: number | null;
  stopLoss?: number | null;
  leverage?: number | null;
  markPrice?: number | null;
  unrealizedPnl?: number | null;
  status: PositionStatus;
  remotePositionId?: string | null;
}

export interface PnlSummary {
  realizedPnl: number;
  unrealizedPnl: number;
  openPositions: number;
  closedPositions: number;
}

export type AgentApprovalStatus =
  | "ready"
  | "synced"
  | "stale"
  | "missing"
  | "error";

export interface AgentSessionStatus {
  masterAccountAddress?: string;
  approvedAgentAddress?: string | null;
  activeAgentAddress?: string | null;
  envFallbackAgentAddress?: string | null;
  approvalStatus: AgentApprovalStatus;
  lastCheckedAt?: string | null;
  lastSyncAt?: string | null;
  lastError?: string | null;
}

export interface NotificationEvent {
  type:
    | "ENTRY_PLACED"
    | "ENTRY_REJECTED"
    | "PROFIT_ACTION_APPLIED"
    | "POSITION_CLOSED"
    | "INFO"
    | "ERROR";
  title: string;
  body: string;
  dedupeKey: string;
}

export interface AllowedSenderRule {
  id?: string;
  username?: string;
  displayName?: string;
}

export interface AppConfig {
  nodeEnv: string;
  logLevel: string;
  databasePath: string;
  telegramApiId: number;
  telegramApiHash: string;
  telegramSessionFile: string;
  telegramSignalChatId: string;
  telegramAllowedSenderIds: string[];
  telegramAllowedSenderLabels: string[];
  controlBotToken: string;
  controlOwnerChatId: string;
  controlOwnerUserId: string;
  symbolWhitelist: string[];
  defaultRuntimeConfig: RuntimeConfig;
  valiantExecutionMode: ExecutionMode;
  valiantBaseUrl: string;
  valiantAgentKey?: string;
  valiantMasterAccountAddress?: string;
  valiantPrivateApiBaseUrl?: string;
  valiantPrivateApiKey?: string;
  valiantPrivateApiSecret?: string;
  valiantPlaywrightExecutablePath?: string;
  valiantPlaywrightCdpUrl?: string;
  valiantPlaywrightHeadless?: boolean;
  valiantPlaywrightProfileDir: string;
  valiantMarketRoute: string;
}

import type {
  AccountBalance,
  AgentSessionStatus,
  ExecutionRequest,
  ExecutionResult,
  PositionSnapshot,
  PositionState,
  ProfitActionRequest
} from "../types.js";

export interface ExecutionAdapter {
  placeEntry(request: ExecutionRequest): Promise<ExecutionResult>;
  setProtectionOrders(position: PositionState): Promise<ExecutionResult>;
  moveStopLoss(position: PositionState, stopLoss: number): Promise<ExecutionResult>;
  partialCloseReduceOnly(position: PositionState, percent: number): Promise<ExecutionResult>;
  closePositionReduceOnly(position: PositionState): Promise<ExecutionResult>;
  cancelPendingByTicker(symbol: string): Promise<ExecutionResult>;
  getPositions(): Promise<PositionSnapshot[]>;
  pricesMatch?(symbol: string, actual: number | null | undefined, expected: number): Promise<boolean>;
  getAccountBalance?(): Promise<AccountBalance | null>;
  applyProfitAction(request: ProfitActionRequest): Promise<ExecutionResult>;
  syncAgentSession?(): Promise<AgentSessionStatus>;
  getAgentSessionStatus?(): Promise<AgentSessionStatus>;
} 

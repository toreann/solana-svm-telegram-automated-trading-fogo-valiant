import type {
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
  applyProfitAction(request: ProfitActionRequest): Promise<ExecutionResult>;
}
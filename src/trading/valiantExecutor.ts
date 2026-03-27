import { chromium, type BrowserContext, type Page } from "playwright-core";

import type {
  AppConfig,
  ExecutionRequest,
  ExecutionResult,
  PositionSnapshot,
  PositionState,
  ProfitActionRequest
} from "../types.js";
import type { ExecutionAdapter } from "./executionAdapter.js";

function accepted(resultingStatus: ExecutionResult["resultingStatus"], metadata?: Record<string, unknown>): ExecutionResult {
  return {
    status: "accepted",
    resultingStatus,
    metadata
  };
}

class DryRunValiantExecutor implements ExecutionAdapter {
  public async placeEntry(request: ExecutionRequest): Promise<ExecutionResult> {
    return {
      status: "accepted",
      remoteOrderId: `dryrun-order-${request.symbol}-${Date.now()}`,
      remotePositionId: `dryrun-position-${request.symbol}-${Date.now()}`,
      resultingStatus: "OPEN",
      metadata: { request }
    };
  }

  public async setProtectionOrders(position: PositionState): Promise<ExecutionResult> {
    return accepted(position.status, { action: "setProtectionOrders", positionId: position.id });
  }

  public async moveStopLoss(position: PositionState, stopLoss: number): Promise<ExecutionResult> {
    return accepted(position.status, { action: "moveStopLoss", positionId: position.id, stopLoss });
  }

  public async partialCloseReduceOnly(position: PositionState, percent: number): Promise<ExecutionResult> {
    return accepted("OPEN", { action: "partialCloseReduceOnly", positionId: position.id, percent });
  }

  public async closePositionReduceOnly(position: PositionState): Promise<ExecutionResult> {
    return accepted("CLOSED", { action: "closePositionReduceOnly", positionId: position.id });
  }

  public async cancelPendingByTicker(symbol: string): Promise<ExecutionResult> {
    return accepted("CANCELLED", { action: "cancelPendingByTicker", symbol });
  }

  public async getPositions(): Promise<PositionSnapshot[]> {
    return [];
  }

  public async applyProfitAction(request: ProfitActionRequest): Promise<ExecutionResult> {
    return accepted("OPEN", { action: "applyProfitAction", request });
  }
}

class PrivateTransportValiantExecutor implements ExecutionAdapter {
  public constructor(private readonly config: AppConfig) {}

  private async request(path: string, body: Record<string, unknown>): Promise<ExecutionResult> {
    if (!this.config.valiantPrivateApiBaseUrl) {
      return {
        status: "failed",
        reason: "Private transport is not configured"
      };
    }

    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (this.config.valiantPrivateApiKey) {
      headers["x-api-key"] = this.config.valiantPrivateApiKey;
    }
    if (this.config.valiantPrivateApiSecret) {
      headers["x-api-secret"] = this.config.valiantPrivateApiSecret;
    }
    if (this.config.valiantAgentKey) {
      headers["x-agent-key"] = this.config.valiantAgentKey;
    }

    const response = await fetch(`${this.config.valiantPrivateApiBaseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      return {
        status: "failed",
        reason: `Private transport request failed with status ${response.status}`
      };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    return {
      status: "accepted",
      resultingStatus: (payload.resultingStatus as ExecutionResult["resultingStatus"]) ?? "OPEN",
      remoteOrderId: payload.remoteOrderId as string | undefined,
      remotePositionId: payload.remotePositionId as string | undefined,
      metadata: payload
    };
  }

  public async placeEntry(request: ExecutionRequest): Promise<ExecutionResult> {
    return this.request("/orders/entry", request as unknown as Record<string, unknown>);
  }

  public async setProtectionOrders(position: PositionState): Promise<ExecutionResult> {
    return this.request("/orders/protection", { position });
  }

  public async moveStopLoss(position: PositionState, stopLoss: number): Promise<ExecutionResult> {
    return this.request("/orders/move-stop", { positionId: position.remotePositionId, stopLoss });
  }

  public async partialCloseReduceOnly(position: PositionState, percent: number): Promise<ExecutionResult> {
    return this.request("/orders/partial-close", { positionId: position.remotePositionId, percent });
  }

  public async closePositionReduceOnly(position: PositionState): Promise<ExecutionResult> {
    return this.request("/orders/close", { positionId: position.remotePositionId });
  }

  public async cancelPendingByTicker(symbol: string): Promise<ExecutionResult> {
    return this.request("/orders/cancel-by-symbol", { symbol });
  }

  public async getPositions(): Promise<PositionSnapshot[]> {
    if (!this.config.valiantPrivateApiBaseUrl) {
      return [];
    }

    const headers: Record<string, string> = {};
    if (this.config.valiantPrivateApiKey) {
      headers["x-api-key"] = this.config.valiantPrivateApiKey;
    }
    if (this.config.valiantPrivateApiSecret) {
      headers["x-api-secret"] = this.config.valiantPrivateApiSecret;
    }
    if (this.config.valiantAgentKey) {
      headers["x-agent-key"] = this.config.valiantAgentKey;
    }

    const response = await fetch(`${this.config.valiantPrivateApiBaseUrl}/positions`, { headers });
    if (!response.ok) {
      return [];
    }

    return (await response.json()) as PositionSnapshot[];
  }

  public async applyProfitAction(request: ProfitActionRequest): Promise<ExecutionResult> {
    return this.request("/orders/profit-action", request as unknown as Record<string, unknown>);
  }
}

class PlaywrightValiantExecutor implements ExecutionAdapter {
  private context?: BrowserContext;
  private page?: Page;

  public constructor(private readonly config: AppConfig) {}

  private async ensurePage(): Promise<Page> {
    if (this.page) {
      return this.page;
    }

    this.context = await chromium.launchPersistentContext(this.config.valiantPlaywrightProfileDir, {
      headless: true
    });
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    await this.page.goto(`${this.config.valiantBaseUrl}${this.config.valiantMarketRoute}`, {
      waitUntil: "networkidle"
    });
    return this.page;
  }

  private unsupported(action: string): ExecutionResult {
    return {
      status: "failed",
      reason: `Playwright adapter scaffolded but selectors/workflow for ${action} must be configured against the live Valiant UI`
    };
  }

  public async placeEntry(_request: ExecutionRequest): Promise<ExecutionResult> {
    await this.ensurePage();
    return this.unsupported("placeEntry");
  }

  public async setProtectionOrders(_position: PositionState): Promise<ExecutionResult> {
    await this.ensurePage();
    return this.unsupported("setProtectionOrders");
  }

  public async moveStopLoss(_position: PositionState, _stopLoss: number): Promise<ExecutionResult> {
    await this.ensurePage();
    return this.unsupported("moveStopLoss");
  }

  public async partialCloseReduceOnly(_position: PositionState, _percent: number): Promise<ExecutionResult> {
    await this.ensurePage();
    return this.unsupported("partialCloseReduceOnly");
  }

  public async closePositionReduceOnly(_position: PositionState): Promise<ExecutionResult> {
    await this.ensurePage();
    return this.unsupported("closePositionReduceOnly");
  }

  public async cancelPendingByTicker(_symbol: string): Promise<ExecutionResult> {
    await this.ensurePage();
    return this.unsupported("cancelPendingByTicker");
  }

  public async getPositions(): Promise<PositionSnapshot[]> {
    await this.ensurePage();
    return [];
  }

  public async applyProfitAction(_request: ProfitActionRequest): Promise<ExecutionResult> {
    await this.ensurePage();
    return this.unsupported("applyProfitAction");
  }
}

export class HybridValiantExecutor implements ExecutionAdapter {
  private readonly dryRun = new DryRunValiantExecutor();
  private readonly privateTransport: ExecutionAdapter;
  private readonly playwright: ExecutionAdapter;

  public constructor(private readonly config: AppConfig) {
    this.privateTransport = new PrivateTransportValiantExecutor(config);
    this.playwright = new PlaywrightValiantExecutor(config);
  }

  private adapterSequence(): ExecutionAdapter[] {
    switch (this.config.valiantExecutionMode) {
      case "dry-run":
        return [this.dryRun];
      case "private":
        return [this.privateTransport];
      case "playwright":
        return [this.playwright];
      case "hybrid":
        return [this.privateTransport, this.playwright];
      default:
        return [this.dryRun];
    }
  }

  private async run(method: keyof ExecutionAdapter, ...args: unknown[]): Promise<ExecutionResult> {
    for (const adapter of this.adapterSequence()) {
      const fn = adapter[method] as (...inner: unknown[]) => Promise<ExecutionResult>;
      const result = await fn.apply(adapter, args);
      if (result.status === "accepted") {
        return result;
      }
    }

    return {
      status: "failed",
      reason: `No execution adapter succeeded for ${String(method)}`
    };
  }

  public placeEntry(request: ExecutionRequest): Promise<ExecutionResult> {
    return this.run("placeEntry", request);
  }

  public setProtectionOrders(position: PositionState): Promise<ExecutionResult> {
    return this.run("setProtectionOrders", position);
  }

  public moveStopLoss(position: PositionState, stopLoss: number): Promise<ExecutionResult> {
    return this.run("moveStopLoss", position, stopLoss);
  }

  public partialCloseReduceOnly(position: PositionState, percent: number): Promise<ExecutionResult> {
    return this.run("partialCloseReduceOnly", position, percent);
  }

  public closePositionReduceOnly(position: PositionState): Promise<ExecutionResult> {
    return this.run("closePositionReduceOnly", position);
  }

  public cancelPendingByTicker(symbol: string): Promise<ExecutionResult> {
    return this.run("cancelPendingByTicker", symbol);
  }

  public async getPositions(): Promise<PositionSnapshot[]> {
    for (const adapter of this.adapterSequence()) {
      const positions = await adapter.getPositions();
      if (positions.length > 0) {
        return positions;
      }
    }
    return [];
  }

  public applyProfitAction(request: ProfitActionRequest): Promise<ExecutionResult> {
    return this.run("applyProfitAction", request);
  }
}

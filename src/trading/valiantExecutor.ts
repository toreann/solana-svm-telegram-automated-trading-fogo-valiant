import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ExchangeClient, HttpRequestError, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { ApiRequestError } from "@nktkas/hyperliquid/api/exchange";
import type {
  FrontendOpenOrdersResponse,
  MetaAndAssetCtxsResponse,
  UserRoleResponse
} from "@nktkas/hyperliquid/api/info";
import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type {
  AgentSessionStatus,
  AppConfig,
  ExecutionRequest,
  ExecutionResult,
  PositionSnapshot,
  PositionState,
  ProfitActionRequest,
  TradeSide
} from "../types.js";
import { normalizeLeverage } from "../utils.js";
import type { ExecutionAdapter } from "./executionAdapter.js";

function accepted(
  resultingStatus: ExecutionResult["resultingStatus"],
  metadata?: Record<string, unknown>,
  remoteOrderId?: string,
  remotePositionId?: string
): ExecutionResult {
  return {
    status: "accepted",
    resultingStatus,
    metadata,
    remoteOrderId,
    remotePositionId
  };
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatDecimal(value: number, maxDecimals = 8): string {
  if (!Number.isFinite(value)) {
    return "0";
  }

  const normalized = value.toFixed(maxDecimals).replace(/\.?0+$/, "");
  return normalized === "-0" ? "0" : normalized;
}

function titleCaseSide(side: TradeSide): string {
  return side === "LONG" ? "Long" : "Short";
}

function parseLeverageChoice(label: string): number | undefined {
  const match = label.match(/(\d+(?:\.\d+)?)\s*x/i);
  if (!match) {
    return undefined;
  }
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function routeHasSymbolPlaceholder(route: string): boolean {
  return /(\{symbol\}|:symbol\b|\[\[symbol\]\])/i.test(route);
}

const HYPERLIQUID_MAINNET_API_URL = "https://api.hyperliquid.xyz";
const HYPERLIQUID_TESTNET_API_URL = "https://api.hyperliquid-testnet.xyz";
const HYPERLIQUID_MARKET_SLIPPAGE_BPS = 150;
const HYPERLIQUID_TPSL_MARKET_SLIPPAGE_BPS = 1_000;
const HYPERLIQUID_POSITION_SYNC_RETRIES = 8;
const HYPERLIQUID_POSITION_SYNC_DELAY_MS = 350;
const VALIANT_AGENT_DISCOVERY_TIMEOUT_MS = 5_000;

export function inferValiantPrivateApiBaseUrl(
  configuredBaseUrl: string | undefined,
  valiantBaseUrl: string | undefined
): string {
  const configured = configuredBaseUrl?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      const host = url.hostname.toLowerCase();
      if (host === "api.valiant.trade" || host === "mainnet-api.valiant.trade") {
        return HYPERLIQUID_MAINNET_API_URL;
      }
      if (host === "testnet-api.valiant.trade") {
        return HYPERLIQUID_TESTNET_API_URL;
      }
    } catch {
      // Fall through to the normalized configured value.
    }

    return configured.replace(/\/+$/, "");
  }

  try {
    const url = new URL(valiantBaseUrl ?? "https://valiant.trade");
    const host = url.hostname.toLowerCase();
    if (host.includes("testnet")) {
      return HYPERLIQUID_TESTNET_API_URL;
    }
  } catch {
    // Fall through to the official Hyperliquid API hostname.
  }

  return HYPERLIQUID_MAINNET_API_URL;
}

export function buildValiantPrivateHeaders(
  config: Pick<AppConfig, "valiantAgentKey" | "valiantPrivateApiKey" | "valiantPrivateApiSecret">,
  includeContentType = true
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (includeContentType) {
    headers["content-type"] = "application/json";
  }

  const agentKey = config.valiantAgentKey?.trim();
  if (agentKey) {
    headers["x-agent-key"] = agentKey;
    return headers;
  }

  if (config.valiantPrivateApiKey?.trim()) {
    headers["x-api-key"] = config.valiantPrivateApiKey.trim();
  }
  if (config.valiantPrivateApiSecret?.trim()) {
    headers["x-api-secret"] = config.valiantPrivateApiSecret.trim();
  }

  return headers;
}

export function resolveValiantMarketUrl(baseUrl: string, marketRoute: string, symbol?: string): string {
  const route = symbol && routeHasSymbolPlaceholder(marketRoute)
    ? marketRoute.replace(/(\{symbol\}|:symbol\b|\[\[symbol\]\])/gi, encodeURIComponent(symbol.toUpperCase()))
    : marketRoute;
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(route, normalizedBase).toString();
}

export function pickPreferredLeverageChoice(requested: number, availableValues: number[]): number | undefined {
  const available = [...new Set(availableValues.filter((value) => Number.isFinite(value) && value > 0))].sort(
    (left, right) => left - right
  );
  if (available.length === 0 || !Number.isFinite(requested) || requested <= 0) {
    return undefined;
  }

  const normalizedRequested = normalizeLeverage(requested);
  const exactMatch = available.find((value) => value === normalizedRequested);
  if (exactMatch) {
    return exactMatch;
  }

  const notAboveRequested = available.filter((value) => value <= normalizedRequested);
  if (notAboveRequested.length > 0) {
    return notAboveRequested[notAboveRequested.length - 1];
  }

  return available[0];
}

export function formatValiantOrderValue(margin: number, leverage: number): string {
  return formatDecimal(margin * leverage, 4);
}

export function formatHyperliquidOrderPrice(price: number, szDecimals: number): string {
  return formatPrice(formatDecimal(price, 12), szDecimals, "perp");
}

export function formatHyperliquidOrderSize(size: number, szDecimals: number): string {
  return formatSize(formatDecimal(roundDown(size, szDecimals), szDecimals), szDecimals);
}

function formatValiantAssetAmount(size: number): string {
  return formatDecimal(size, 8);
}

function roundDown(value: number, decimals: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const factor = 10 ** Math.max(0, decimals);
  return Math.floor(value * factor) / factor;
}

function parsePositiveNumber(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeHexPrivateKey(value?: string): Hex | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }

  const withPrefix = normalized.startsWith("0x") ? normalized : `0x${normalized}`;
  return /^0x[a-fA-F0-9]{64}$/.test(withPrefix) ? (withPrefix as Hex) : undefined;
}

function normalizeHexAddress(value?: string): Hex | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }

  const withPrefix = normalized.startsWith("0x") ? normalized : `0x${normalized}`;
  return /^0x[a-fA-F0-9]{40}$/.test(withPrefix) ? (withPrefix as Hex) : undefined;
}

interface BrowserStoredAgentCandidate {
  userAddress?: string;
  agentAddress?: string;
  privateKey: string;
}

function normalizeAddressList(values: readonly string[] | undefined): string[] {
  return [...new Set(
    (values ?? [])
      .map((value) => normalizeHexAddress(value)?.toLowerCase())
      .filter((value): value is string => Boolean(value))
  )];
}

function candidateAgentAddress(candidate: BrowserStoredAgentCandidate): string | undefined {
  const normalizedAddress = normalizeHexAddress(candidate.agentAddress)?.toLowerCase();
  if (normalizedAddress) {
    return normalizedAddress;
  }

  const normalizedPrivateKey = normalizeHexPrivateKey(candidate.privateKey);
  if (!normalizedPrivateKey) {
    return undefined;
  }

  return privateKeyToAccount(normalizedPrivateKey).address.toLowerCase();
}

export function selectApprovedAgentPrivateKey(options: {
  configuredAgentKey?: string;
  configuredMasterAccountAddress?: string;
  approvedAgentAddresses?: readonly string[];
  browserStoredAgents?: readonly BrowserStoredAgentCandidate[];
}): Hex | undefined {
  const configuredAgentKey = normalizeHexPrivateKey(options.configuredAgentKey);
  const configuredMasterAccountAddress = normalizeHexAddress(options.configuredMasterAccountAddress)?.toLowerCase();
  const approvedAgentAddresses = normalizeAddressList(options.approvedAgentAddresses);

  if (approvedAgentAddresses.length === 0) {
    const firstBrowserKey = options.browserStoredAgents
      ?.map((candidate) => normalizeHexPrivateKey(candidate.privateKey))
      .find((candidate): candidate is Hex => Boolean(candidate));
    if (firstBrowserKey) {
      return firstBrowserKey;
    }

    return configuredAgentKey;
  }

  for (const candidate of options.browserStoredAgents ?? []) {
    const candidateUserAddress = normalizeHexAddress(candidate.userAddress)?.toLowerCase();
    if (configuredMasterAccountAddress && candidateUserAddress && candidateUserAddress !== configuredMasterAccountAddress) {
      continue;
    }

    const normalizedPrivateKey = normalizeHexPrivateKey(candidate.privateKey);
    const normalizedAgentAddress = candidateAgentAddress(candidate);
    if (normalizedPrivateKey && normalizedAgentAddress && approvedAgentAddresses.includes(normalizedAgentAddress)) {
      return normalizedPrivateKey;
    }
  }

  if (configuredAgentKey) {
    const configuredAddress = privateKeyToAccount(configuredAgentKey).address.toLowerCase();
    if (approvedAgentAddresses.includes(configuredAddress)) {
      return configuredAgentKey;
    }
  }

  return undefined;
}

function emptyAgentSessionStatus(config: AppConfig): AgentSessionStatus {
  return {
    masterAccountAddress: normalizeHexAddress(config.valiantMasterAccountAddress)?.toLowerCase(),
    approvedAgentAddress: null,
    activeAgentAddress: null,
    envFallbackAgentAddress: normalizeHexPrivateKey(config.valiantAgentKey)
      ? privateKeyToAccount(normalizeHexPrivateKey(config.valiantAgentKey)!).address.toLowerCase()
      : null,
    approvalStatus: "missing",
    lastCheckedAt: null,
    lastSyncAt: null,
    lastError: null
  };
}

function aggressiveMarketPrice(referencePrice: number, isBuy: boolean): number {
  const multiplier = 1 + HYPERLIQUID_MARKET_SLIPPAGE_BPS / 10_000;
  return isBuy ? referencePrice * multiplier : referencePrice / multiplier;
}

function aggressiveProtectionPrice(referencePrice: number, isBuy: boolean): number {
  const multiplier = 1 + HYPERLIQUID_TPSL_MARKET_SLIPPAGE_BPS / 10_000;
  return isBuy ? referencePrice * multiplier : referencePrice / multiplier;
}

function formatMissingAgentRoleMessage(agentAddress: Hex): string {
  return [
    `VALIANT_AGENT_KEY resolves to ${agentAddress}, but Hyperliquid userRole returned "missing".`,
    "This API wallet/agent is not currently approved on the trading account.",
    "Re-approve the agent wallet on Hyperliquid or replace VALIANT_AGENT_KEY with the currently approved agent private key."
  ].join(" ");
}

export function isRetryableHyperliquidAuthFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("user or api wallet")
    && normalized.includes("does not exist")
  ) || normalized.includes('userrole returned "missing"');
}

function extractHyperliquidOrderErrors(statuses: unknown): string[] {
  if (!Array.isArray(statuses)) {
    return [];
  }

  return statuses.flatMap((status) => {
    if (!status || typeof status !== "object") {
      return [];
    }

    const error = (status as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) {
      return [error.trim()];
    }

    return [];
  });
}

function newCloid(): `0x${string}` {
  return `0x${randomBytes(16).toString("hex")}` as `0x${string}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function resolvePlaywrightExecutablePath(configuredPath?: string): string | undefined {
  const configured = configuredPath?.trim();
  if (configured) {
    return configured;
  }

  const windowsCandidates = [
    process.env.PROGRAMFILES ? `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
    process.env["PROGRAMFILES(X86)"]
      ? `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`
      : undefined,
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
    process.env.PROGRAMFILES ? `${process.env.PROGRAMFILES}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe` : undefined,
    process.env["PROGRAMFILES(X86)"]
      ? `${process.env["PROGRAMFILES(X86)"]}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`
      : undefined,
    process.env.LOCALAPPDATA
      ? `${process.env.LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`
      : undefined
  ];

  const candidates = [
    process.env.CHROME_PATH?.trim(),
    process.env.BRAVE_PATH?.trim(),
    "/snap/bin/brave",
    "/usr/bin/brave-browser",
    "/usr/bin/brave",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ...windowsCandidates
  ].filter((value): value is string => Boolean(value));

  return candidates.find((candidate) => existsSync(candidate));
}

export function parseDevToolsActivePortFile(contents: string): string | undefined {
  const lines = contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return undefined;
  }

  const firstLine = lines[0];
  if (/^https?:\/\//iu.test(firstLine) || /^wss?:\/\//iu.test(firstLine)) {
    return firstLine;
  }

  if (!/^\d+$/u.test(firstLine)) {
    return undefined;
  }

  const path = lines[1];
  if (path?.startsWith("/devtools/")) {
    return `ws://127.0.0.1:${firstLine}${path}`;
  }

  return `http://127.0.0.1:${firstLine}`;
}

export function resolvePlaywrightLiveCdpEndpoint(configuredUrl?: string, profileDir?: string): string | undefined {
  const configured = configuredUrl?.trim();
  if (configured) {
    return configured;
  }

  const normalizedProfileDir = profileDir?.trim();
  if (!normalizedProfileDir) {
    return undefined;
  }

  const devToolsActivePortPath = resolve(normalizedProfileDir, "DevToolsActivePort");
  if (!existsSync(devToolsActivePortPath)) {
    return undefined;
  }

  try {
    return parseDevToolsActivePortFile(readFileSync(devToolsActivePortPath, "utf8"));
  } catch {
    return undefined;
  }
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

  public async syncAgentSession(): Promise<AgentSessionStatus> {
    return {
      ...emptyAgentSessionStatus({
        valiantMasterAccountAddress: undefined,
        valiantAgentKey: undefined
      } as AppConfig),
      approvalStatus: "ready",
      lastCheckedAt: new Date().toISOString(),
      lastSyncAt: new Date().toISOString(),
      lastError: null
    };
  }

  public async getAgentSessionStatus(): Promise<AgentSessionStatus> {
    return this.syncAgentSession();
  }
}

interface HyperliquidAssetDescriptor {
  index: number;
  symbol: string;
  szDecimals: number;
  maxLeverage: number;
  markPrice: number;
  midPrice?: number;
  impactBid?: number;
  impactAsk?: number;
}

interface HyperliquidResolvedPosition {
  symbol: string;
  side: TradeSide;
  size: number;
  entryPrice: number;
  leverage: number | null;
  markPrice: number | null;
  unrealizedPnl: number | null;
}

type HyperliquidOpenOrder = FrontendOpenOrdersResponse[number];

class PrivateTransportValiantExecutor implements ExecutionAdapter {
  private transport?: HttpTransport;
  private exchange?: ExchangeClient;
  private info?: InfoClient;
  private wallet?: ReturnType<typeof privateKeyToAccount>;
  private activeAgentKey?: Hex;
  private resolvedAccountAddress?: Promise<Hex>;
  private readonly nonceState = new Map<string, number>();
  private readonly assetCache = new Map<string, Promise<HyperliquidAssetDescriptor>>();
  private agentSessionStatus: AgentSessionStatus;
  private browserAgentDiscoveryError: string | null = null;

  public constructor(private readonly config: AppConfig) {
    this.agentSessionStatus = emptyAgentSessionStatus(config);
  }

  private baseUrl(): string {
    return inferValiantPrivateApiBaseUrl(this.config.valiantPrivateApiBaseUrl, this.config.valiantBaseUrl);
  }

  private isConfigured(): boolean {
    return Boolean(
      normalizeHexAddress(this.config.valiantMasterAccountAddress)
      || normalizeHexPrivateKey(this.config.valiantAgentKey)
    );
  }

  private walletClient(): ReturnType<typeof privateKeyToAccount> {
    if (this.wallet) {
      return this.wallet;
    }

    throw new Error("Private transport wallet is not initialized");
  }

  private configuredAgentKey(): Hex | undefined {
    return normalizeHexPrivateKey(this.config.valiantAgentKey);
  }

  private activeAgentAddress(): string | null {
    if (this.wallet) {
      return this.wallet.address.toLowerCase();
    }
    if (this.activeAgentKey) {
      return privateKeyToAccount(this.activeAgentKey).address.toLowerCase();
    }
    return null;
  }

  private updateAgentSessionStatus(patch: Partial<AgentSessionStatus>): AgentSessionStatus {
    this.agentSessionStatus = {
      ...this.agentSessionStatus,
      ...patch,
      masterAccountAddress: patch.masterAccountAddress ?? this.agentSessionStatus.masterAccountAddress
        ?? normalizeHexAddress(this.config.valiantMasterAccountAddress)?.toLowerCase(),
      envFallbackAgentAddress: patch.envFallbackAgentAddress ?? this.agentSessionStatus.envFallbackAgentAddress
        ?? emptyAgentSessionStatus(this.config).envFallbackAgentAddress
    };
    return { ...this.agentSessionStatus };
  }

  private blockingAgentError(status: AgentSessionStatus): string {
    return status.lastError
      ?? "No approved Valiant agent is loaded in memory. Run Sync Agent or open the canonical Valiant browser profile.";
  }

  private async approvedAgentAddresses(masterAccountAddress: Hex): Promise<string[]> {
    const approvedAgents = await this.infoClient().extraAgents({ user: masterAccountAddress });
    const now = Date.now();
    return normalizeAddressList(
      approvedAgents
        .filter((agent) => !agent.validUntil || agent.validUntil >= now)
        .map((agent) => agent.address)
    );
  }

  private makeTempProfileDir(): string {
    const path = join(tmpdir(), `valiant-agent-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(join(path, "Default"), { recursive: true });
    return path;
  }

  private copyIfExists(from: string, to: string): void {
    if (!existsSync(from)) {
      return;
    }
    cpSync(from, to, { recursive: true, force: true });
  }

  private hasValiantStorage(profileRoot: string): boolean {
    return existsSync(join(profileRoot, "Default", "IndexedDB", "https_valiant.trade_0.indexeddb.leveldb"))
      && existsSync(join(profileRoot, "Default", "Local Storage", "leveldb"));
  }

  private async openValiantPage(context: BrowserContext): Promise<Page> {
    const marketUrl = resolveValiantMarketUrl(this.config.valiantBaseUrl, this.config.valiantMarketRoute);
    const targetOrigin = new URL(marketUrl).origin;
    const existingPage = context.pages().find((page) => {
      try {
        return new URL(page.url()).origin === targetOrigin;
      } catch {
        return false;
      }
    });

    const page = existingPage ?? await context.newPage();
    if (!existingPage || page.url() !== marketUrl) {
      await page.goto(marketUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000
      });
    }

    return page;
  }

  private async collectBrowserStoredAgents(page: Page): Promise<BrowserStoredAgentCandidate[]> {
    const storedAgents = await page.evaluate(`
      (async () => {
        const DB_NAME = "valiant-agent-keys";
        const STORE_NAME = "encryption-keys";
        const STORAGE_PREFIX = "valiant:agent:";
        const ADDR_PREFIX = "valiant:agent-addr:";

        const openDb = () => new Promise((resolve, reject) => {
          const request = indexedDB.open(DB_NAME, 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error("Failed to open Valiant agent key database"));
        });

        const unwrapCryptoKey = (value) => {
          if (value instanceof CryptoKey) {
            return value;
          }
          if (
            value
            && typeof value === "object"
            && "key" in value
            && value.key instanceof CryptoKey
          ) {
            return value.key;
          }
          return undefined;
        };

        const readStore = async () => {
          const db = await openDb();
          return await new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, "readonly");
            const store = transaction.objectStore(STORE_NAME);
            const keysRequest = store.getAllKeys();
            const valuesRequest = store.getAll();

            transaction.oncomplete = () => {
              const keys = Array.isArray(keysRequest.result) ? keysRequest.result : [];
              const values = Array.isArray(valuesRequest.result) ? valuesRequest.result : [];
              resolve(
                keys
                  .map((key, index) => {
                    const cryptoKey = unwrapCryptoKey(values[index]);
                    if (!cryptoKey) {
                      return undefined;
                    }
                    return {
                      key: String(key),
                      cryptoKey
                    };
                  })
                  .filter(Boolean)
              );
              db.close();
            };
            transaction.onerror = () => {
              reject(transaction.error ?? new Error("Failed to read Valiant encryption keys"));
              db.close();
            };
          });
        };

        const decryptPrivateKey = async (cryptoKey, encrypted) => {
          const bytes = Uint8Array.from(atob(encrypted), (char) => char.charCodeAt(0));
          const iv = bytes.slice(0, 12);
          const ciphertext = bytes.slice(12);
          const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext);
          return new TextDecoder().decode(decrypted);
        };

        const keyEntries = await readStore();
        const results = [];

        for (const entry of keyEntries) {
          const encrypted = localStorage.getItem(STORAGE_PREFIX + entry.key.toLowerCase());
          if (!encrypted) {
            continue;
          }

          try {
            const privateKey = await decryptPrivateKey(entry.cryptoKey, encrypted);
            const agentAddress = localStorage.getItem(ADDR_PREFIX + entry.key.toLowerCase()) ?? undefined;
            results.push({
              userAddress: entry.key,
              agentAddress: agentAddress ?? undefined,
              privateKey
            });
          } catch {
          }
        }

        return results;
      })()
    `);

    return Array.isArray(storedAgents) ? storedAgents : [];
  }

  private async extractBrowserStoredAgentsFromLiveSession(cdpEndpoint: string): Promise<BrowserStoredAgentCandidate[]> {
    const browser = await withTimeout(
      chromium.connectOverCDP(cdpEndpoint),
      VALIANT_AGENT_DISCOVERY_TIMEOUT_MS,
      `Connecting to the live Valiant browser session at ${cdpEndpoint}`
    );
    try {
      const context = browser.contexts()[0];
      if (!context) {
        throw new Error(`Connected to the live canonical browser at ${cdpEndpoint}, but no browser context was available.`);
      }

      const page = await withTimeout(
        this.openValiantPage(context),
        VALIANT_AGENT_DISCOVERY_TIMEOUT_MS,
        `Opening the Valiant page in the live browser session at ${cdpEndpoint}`
      );
      return await withTimeout(
        this.collectBrowserStoredAgents(page),
        VALIANT_AGENT_DISCOVERY_TIMEOUT_MS,
        `Reading Valiant agent storage from the live browser session at ${cdpEndpoint}`
      );
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  private async extractBrowserStoredAgentsFromCopiedProfile(profileRoot: string, executablePath: string): Promise<BrowserStoredAgentCandidate[]> {
    const tempProfileDir = this.makeTempProfileDir();
    this.copyIfExists(join(profileRoot, "Local State"), join(tempProfileDir, "Local State"));
    this.copyIfExists(join(profileRoot, "Default", "Local Storage"), join(tempProfileDir, "Default", "Local Storage"));
    this.copyIfExists(join(profileRoot, "Default", "IndexedDB"), join(tempProfileDir, "Default", "IndexedDB"));

    let context: BrowserContext | undefined;
    try {
      context = await chromium.launchPersistentContext(tempProfileDir, {
        executablePath,
        headless: this.config.valiantPlaywrightHeadless ?? false
      });
      const page = await this.openValiantPage(context);
      return this.collectBrowserStoredAgents(page);
    } finally {
      await context?.close().catch(() => undefined);
      rmSync(tempProfileDir, { recursive: true, force: true });
    }
  }

  private async browserStoredAgents(): Promise<BrowserStoredAgentCandidate[]> {
    this.browserAgentDiscoveryError = null;
    const executablePath = resolvePlaywrightExecutablePath(this.config.valiantPlaywrightExecutablePath);
    if (!executablePath) {
      this.browserAgentDiscoveryError = "No Chrome/Chromium/Brave executable is available for Valiant agent discovery.";
      return [];
    }

    const canonicalProfileRoot = resolve(this.config.valiantPlaywrightProfileDir);
    if (!this.hasValiantStorage(canonicalProfileRoot)) {
      this.browserAgentDiscoveryError = `The canonical Valiant browser profile ${canonicalProfileRoot} does not contain Valiant IndexedDB/local storage yet.`;
      return [];
    }

    const discoveryErrors: string[] = [];
    const liveCdpEndpoint = resolvePlaywrightLiveCdpEndpoint(
      this.config.valiantPlaywrightCdpUrl,
      canonicalProfileRoot
    );

    if (liveCdpEndpoint) {
      try {
        const liveAgents = await this.extractBrowserStoredAgentsFromLiveSession(liveCdpEndpoint);
        if (liveAgents.length > 0) {
          return liveAgents;
        }
        discoveryErrors.push(`Attached to the live canonical browser session at ${liveCdpEndpoint}, but no decryptable Valiant agents were found.`);
      } catch (error) {
        discoveryErrors.push(`Live canonical browser attach failed at ${liveCdpEndpoint}: ${extractErrorMessage(error)}`);
      }
    } else {
      discoveryErrors.push(
        `No live canonical browser debugging endpoint was found for ${canonicalProfileRoot}. Set VALIANT_PLAYWRIGHT_CDP_URL or launch Brave with --remote-debugging-port.`
      );
    }

    try {
      const copiedProfileAgents = await this.extractBrowserStoredAgentsFromCopiedProfile(canonicalProfileRoot, executablePath);
      if (copiedProfileAgents.length > 0) {
        return copiedProfileAgents;
      }
      discoveryErrors.push("Copied-profile Valiant agent extraction found no decryptable agents.");
    } catch (error) {
      discoveryErrors.push(`Copied-profile Valiant agent extraction failed: ${extractErrorMessage(error)}`);
    }

    this.browserAgentDiscoveryError = discoveryErrors.join(" | ");
    return [];
  }

  private applyActiveAgentKey(agentKey: Hex): ReturnType<typeof privateKeyToAccount> {
    if (this.wallet && this.activeAgentKey === agentKey) {
      return this.wallet;
    }

    this.activeAgentKey = agentKey;
    this.wallet = privateKeyToAccount(agentKey);
    this.exchange = undefined;
    this.resolvedAccountAddress = undefined;
    this.nonceState.clear();
    this.updateAgentSessionStatus({
      activeAgentAddress: this.wallet.address.toLowerCase(),
      lastError: null
    });
    return this.wallet;
  }

  private async inspectAgentSession(): Promise<AgentSessionStatus> {
    const checkedAt = new Date().toISOString();
    const baseStatus = emptyAgentSessionStatus(this.config);
    this.updateAgentSessionStatus(baseStatus);

    try {
      const configuredMasterAccount = normalizeHexAddress(this.config.valiantMasterAccountAddress);
      if (!configuredMasterAccount) {
        const fallbackWallet = this.configuredAgentKey();
        if (fallbackWallet) {
          const wallet = this.applyActiveAgentKey(fallbackWallet);
          return this.updateAgentSessionStatus({
            activeAgentAddress: wallet.address.toLowerCase(),
            approvalStatus: "ready",
            lastCheckedAt: checkedAt,
            lastError: null
          });
        }

        return this.updateAgentSessionStatus({
          approvalStatus: "missing",
          lastCheckedAt: checkedAt,
          lastError: "VALIANT_MASTER_ACCOUNT_ADDRESS is required for dynamic agent sync."
        });
      }

      const approvedAgentAddresses = await this.approvedAgentAddresses(configuredMasterAccount);
      const approvedAgentAddress = approvedAgentAddresses[0] ?? null;
      const activeAgentAddress = this.activeAgentAddress();
      const envFallbackAgentAddress = baseStatus.envFallbackAgentAddress;

      if (!approvedAgentAddress) {
        return this.updateAgentSessionStatus({
          approvedAgentAddress,
          activeAgentAddress,
          envFallbackAgentAddress,
          approvalStatus: "missing",
          lastCheckedAt: checkedAt,
          lastError: `No approved Valiant agent is currently registered for ${configuredMasterAccount}.`
        });
      }

      if (activeAgentAddress && approvedAgentAddresses.includes(activeAgentAddress)) {
        return this.updateAgentSessionStatus({
          approvedAgentAddress,
          activeAgentAddress,
          envFallbackAgentAddress,
          approvalStatus: "ready",
          lastCheckedAt: checkedAt,
          lastError: null
        });
      }

      const staleReason = envFallbackAgentAddress
        ? `VALIANT_AGENT_KEY resolves to ${envFallbackAgentAddress}, but it is not the currently approved Valiant agent. Approved agent addresses for ${configuredMasterAccount}: ${approvedAgentAddresses.join(", ")}.`
        : `No approved in-memory Valiant agent is loaded. Approved agent addresses for ${configuredMasterAccount}: ${approvedAgentAddresses.join(", ")}.`;

      return this.updateAgentSessionStatus({
        approvedAgentAddress,
        activeAgentAddress,
        envFallbackAgentAddress,
        approvalStatus: "stale",
        lastCheckedAt: checkedAt,
        lastError: staleReason
      });
    } catch (error) {
      return this.updateAgentSessionStatus({
        approvalStatus: "error",
        lastCheckedAt: checkedAt,
        lastError: extractErrorMessage(error)
      });
    }
  }

  public async getAgentSessionStatus(): Promise<AgentSessionStatus> {
    return this.inspectAgentSession();
  }

  public async syncAgentSession(): Promise<AgentSessionStatus> {
    const checkedAt = new Date().toISOString();

    try {
      const configuredMasterAccount = normalizeHexAddress(this.config.valiantMasterAccountAddress);
      if (!configuredMasterAccount) {
        const fallbackKey = this.configuredAgentKey();
        if (!fallbackKey) {
          return this.updateAgentSessionStatus({
            approvalStatus: "missing",
            lastCheckedAt: checkedAt,
            lastError: "Cannot sync agent without VALIANT_MASTER_ACCOUNT_ADDRESS or VALIANT_AGENT_KEY fallback."
          });
        }

        const wallet = this.applyActiveAgentKey(fallbackKey);
        return this.updateAgentSessionStatus({
          activeAgentAddress: wallet.address.toLowerCase(),
          approvalStatus: "synced",
          lastCheckedAt: checkedAt,
          lastSyncAt: checkedAt,
          lastError: null
        });
      }

      const approvedAgentAddresses = await this.approvedAgentAddresses(configuredMasterAccount);
      const browserStoredAgents = await this.browserStoredAgents();
      const selectedAgentKey = selectApprovedAgentPrivateKey({
        configuredAgentKey: this.config.valiantAgentKey,
        configuredMasterAccountAddress: configuredMasterAccount,
        approvedAgentAddresses,
        browserStoredAgents
      });

      if (!selectedAgentKey) {
        return this.updateAgentSessionStatus({
          approvedAgentAddress: approvedAgentAddresses[0] ?? null,
          activeAgentAddress: this.activeAgentAddress(),
          approvalStatus: approvedAgentAddresses.length > 0 ? "stale" : "missing",
          lastCheckedAt: checkedAt,
          lastError: approvedAgentAddresses.length > 0
            ? this.browserAgentDiscoveryError
              ?? `Could not load the approved agent ${approvedAgentAddresses[0]} from the canonical Valiant browser profile ${resolve(this.config.valiantPlaywrightProfileDir)}.`
            : `No approved Valiant agent is currently registered for ${configuredMasterAccount}.`,
          lastSyncAt: null
        });
      }

      const wallet = this.applyActiveAgentKey(selectedAgentKey);
      return this.updateAgentSessionStatus({
        approvedAgentAddress: approvedAgentAddresses[0] ?? wallet.address.toLowerCase(),
        activeAgentAddress: wallet.address.toLowerCase(),
        approvalStatus: "synced",
        lastCheckedAt: checkedAt,
        lastSyncAt: checkedAt,
        lastError: null
      });
    } catch (error) {
      return this.updateAgentSessionStatus({
        approvalStatus: "error",
        lastCheckedAt: checkedAt,
        lastError: extractErrorMessage(error)
      });
    }
  }

  private async ensureWalletClient(forceBrowserRefresh = false): Promise<ReturnType<typeof privateKeyToAccount>> {
    if (this.wallet && this.activeAgentKey && !forceBrowserRefresh) {
      return this.wallet;
    }

    const syncedStatus = await this.syncAgentSession();
    if (!this.wallet) {
      throw new Error(this.blockingAgentError(syncedStatus));
    }

    return this.wallet;
  }

  private async ensureWritableAgentSession(): Promise<void> {
    const configuredMasterAccount = normalizeHexAddress(this.config.valiantMasterAccountAddress);
    if (configuredMasterAccount) {
      const syncedStatus = await this.syncAgentSession();
      if (syncedStatus.approvalStatus === "ready" || syncedStatus.approvalStatus === "synced") {
        return;
      }

      throw new Error(this.blockingAgentError(syncedStatus));
    }

    const status = await this.inspectAgentSession();
    if (status.approvalStatus === "ready") {
      return;
    }

    const syncedStatus = await this.syncAgentSession();
    if (syncedStatus.approvalStatus === "ready" || syncedStatus.approvalStatus === "synced") {
      return;
    }

    throw new Error(this.blockingAgentError(syncedStatus));
  }

  private transportClient(): HttpTransport {
    if (this.transport) {
      return this.transport;
    }

    this.transport = new HttpTransport({
      apiUrl: this.baseUrl(),
      isTestnet: this.baseUrl().includes("testnet"),
      timeout: 12_000
    });
    return this.transport;
  }

  private exchangeClient(): ExchangeClient {
    if (this.exchange) {
      return this.exchange;
    }

    this.exchange = new ExchangeClient({
      transport: this.transportClient(),
      wallet: this.walletClient(),
      nonceManager: (address) => this.nextNonce(address)
    });
    return this.exchange;
  }

  private nextNonce(address: string): number {
    const now = Date.now();

    for (const [key, lastNonce] of this.nonceState) {
      if (now > lastNonce) {
        this.nonceState.delete(key);
      }
    }

    const key = `${address.toLowerCase()}:${this.transportClient().isTestnet}`;
    const lastNonce = this.nonceState.get(key) ?? 0;
    const nonce = now > lastNonce ? now : lastNonce + 1;
    this.nonceState.set(key, nonce);
    return nonce;
  }

  private infoClient(): InfoClient {
    if (this.info) {
      return this.info;
    }

    this.info = new InfoClient({ transport: this.transportClient() });
    return this.info;
  }

  private async resolveTradingAccountAddress(): Promise<Hex> {
    const configuredMasterAccount = normalizeHexAddress(this.config.valiantMasterAccountAddress);
    if (configuredMasterAccount) {
      return configuredMasterAccount.toLowerCase() as Hex;
    }

    const agentAddress = (await this.ensureWalletClient()).address.toLowerCase() as Hex;

    const role = (await this.infoClient().userRole({ user: agentAddress })) as UserRoleResponse;
    if (role.role === "agent") {
      return role.data.user.toLowerCase() as Hex;
    }
    if (role.role === "subAccount") {
      return role.data.master.toLowerCase() as Hex;
    }
    if (role.role === "missing") {
      throw new Error(formatMissingAgentRoleMessage(agentAddress));
    }

    return agentAddress;
  }

  private resetCachedState(): void {
    this.transport = undefined;
    this.exchange = undefined;
    this.info = undefined;
    this.wallet = undefined;
    this.activeAgentKey = undefined;
    this.resolvedAccountAddress = undefined;
    this.nonceState.clear();
    this.assetCache.clear();
  }

  private async tradingAccountAddress(): Promise<Hex> {
    if (!this.resolvedAccountAddress) {
      this.resolvedAccountAddress = this.resolveTradingAccountAddress().catch((error) => {
        this.resolvedAccountAddress = undefined;
        throw error;
      });
    }
    return this.resolvedAccountAddress;
  }

  private async asset(symbol: string): Promise<HyperliquidAssetDescriptor> {
    const normalizedSymbol = symbol.trim().toUpperCase();
    const existing = this.assetCache.get(normalizedSymbol);
    if (existing) {
      return existing;
    }

    const loaded = this.loadAsset(normalizedSymbol);
    this.assetCache.set(normalizedSymbol, loaded);
    return loaded;
  }

  private async loadAsset(symbol: string): Promise<HyperliquidAssetDescriptor> {
    const [meta, assetCtxs] = (await this.infoClient().metaAndAssetCtxs()) as MetaAndAssetCtxsResponse;
    const index = meta.universe.findIndex((entry) => entry.name.toUpperCase() === symbol);
    if (index < 0) {
      throw new Error(`Hyperliquid does not list ${symbol}`);
    }

    const metaEntry = meta.universe[index];
    const assetCtx = assetCtxs[index];
    return {
      index,
      symbol,
      szDecimals: metaEntry.szDecimals,
      maxLeverage: metaEntry.maxLeverage,
      markPrice: parsePositiveNumber(assetCtx.markPx) ?? 0,
      midPrice: parsePositiveNumber(assetCtx.midPx),
      impactBid: parsePositiveNumber(assetCtx.impactPxs?.[0]),
      impactAsk: parsePositiveNumber(assetCtx.impactPxs?.[1])
    };
  }

  private async livePositions(): Promise<HyperliquidResolvedPosition[]> {
    const user = await this.tradingAccountAddress();
    const state = await this.infoClient().clearinghouseState({ user });
    return state.assetPositions
      .map((entry) => {
        const size = Number.parseFloat(entry.position.szi);
        if (!Number.isFinite(size) || size === 0) {
          return undefined;
        }

        return {
          symbol: entry.position.coin.toUpperCase(),
          side: size > 0 ? "LONG" : "SHORT",
          size: Math.abs(size),
          entryPrice: Number.parseFloat(entry.position.entryPx),
          leverage: Number.isFinite(Number(entry.position.leverage?.value)) ? Number(entry.position.leverage.value) : null,
          markPrice: parsePositiveNumber(entry.position.positionValue) && Math.abs(size) > 0
            ? Number.parseFloat(entry.position.positionValue) / Math.abs(size)
            : null,
          unrealizedPnl: Number.isFinite(Number.parseFloat(entry.position.unrealizedPnl))
            ? Number.parseFloat(entry.position.unrealizedPnl)
            : null
        } satisfies HyperliquidResolvedPosition;
      })
      .filter((entry): entry is HyperliquidResolvedPosition => Boolean(entry));
  }

  private async waitForLivePosition(symbol: string, expectedSide?: TradeSide): Promise<HyperliquidResolvedPosition | undefined> {
    const normalizedSymbol = symbol.toUpperCase();

    for (let attempt = 0; attempt < HYPERLIQUID_POSITION_SYNC_RETRIES; attempt += 1) {
      const livePosition = (await this.livePositions()).find(
        (entry) => entry.symbol === normalizedSymbol && (!expectedSide || entry.side === expectedSide)
      );
      if (livePosition) {
        return livePosition;
      }
      await sleep(HYPERLIQUID_POSITION_SYNC_DELAY_MS);
    }

    return undefined;
  }

  private async waitForPositionSizeChange(
    symbol: string,
    side: TradeSide,
    previousSize: number,
    szDecimals: number
  ): Promise<HyperliquidResolvedPosition | undefined> {
    const normalizedSymbol = symbol.toUpperCase();
    const tolerance = 1 / 10 ** Math.max(szDecimals, 0);
    let latestPosition: HyperliquidResolvedPosition | undefined;

    for (let attempt = 0; attempt < HYPERLIQUID_POSITION_SYNC_RETRIES; attempt += 1) {
      latestPosition = (await this.livePositions()).find(
        (entry) => entry.symbol === normalizedSymbol && entry.side === side
      );
      const currentSize = latestPosition?.size ?? 0;
      if (Math.abs(currentSize - previousSize) >= tolerance) {
        return latestPosition;
      }
      await sleep(HYPERLIQUID_POSITION_SYNC_DELAY_MS);
    }

    return latestPosition;
  }

  private async frontendOpenOrders(symbol?: string): Promise<HyperliquidOpenOrder[]> {
    const user = await this.tradingAccountAddress();
    const normalizedSymbol = symbol?.toUpperCase();
    const orders = await this.infoClient().frontendOpenOrders({ user });
    return normalizedSymbol ? orders.filter((entry) => entry.coin.toUpperCase() === normalizedSymbol) : orders;
  }

  private protectionOrders(orders: HyperliquidOpenOrder[]): HyperliquidOpenOrder[] {
    return orders.filter((entry) => entry.reduceOnly && entry.isTrigger);
  }

  private currentProtectionTargets(orders: HyperliquidOpenOrder[]): { takeProfit?: number; stopLoss?: number } {
    const targets: { takeProfit?: number; stopLoss?: number } = {};

    for (const order of this.protectionOrders(orders)) {
      const triggerPx = parsePositiveNumber(order.triggerPx);
      if (!triggerPx) {
        continue;
      }

      const orderType = order.orderType.toLowerCase();
      if (orderType.includes("take")) {
        targets.takeProfit = triggerPx;
      } else if (orderType.includes("stop")) {
        targets.stopLoss = triggerPx;
      }
    }

    return targets;
  }

  private async waitForProtectionTargets(
    symbol: string,
    takeProfit: number,
    stopLoss: number,
    szDecimals: number
  ): Promise<{ takeProfit?: number; stopLoss?: number }> {
    let latestTargets: { takeProfit?: number; stopLoss?: number } = {};

    for (let attempt = 0; attempt < HYPERLIQUID_POSITION_SYNC_RETRIES; attempt += 1) {
      latestTargets = this.currentProtectionTargets(await this.frontendOpenOrders(symbol));
      if (this.protectionMatches(latestTargets, takeProfit, stopLoss, szDecimals)) {
        return latestTargets;
      }
      await sleep(HYPERLIQUID_POSITION_SYNC_DELAY_MS);
    }

    return latestTargets;
  }

  private protectionMatches(
    current: { takeProfit?: number; stopLoss?: number },
    expectedTakeProfit: number,
    expectedStopLoss: number,
    szDecimals: number
  ): boolean {
    if (!(current.takeProfit && current.stopLoss && expectedTakeProfit > 0 && expectedStopLoss > 0)) {
      return false;
    }

    try {
      return (
        formatHyperliquidOrderPrice(current.takeProfit, szDecimals) === formatHyperliquidOrderPrice(expectedTakeProfit, szDecimals)
        && formatHyperliquidOrderPrice(current.stopLoss, szDecimals) === formatHyperliquidOrderPrice(expectedStopLoss, szDecimals)
      );
    } catch {
      return false;
    }
  }

  private entryReferencePrice(asset: HyperliquidAssetDescriptor, isBuy: boolean): number {
    return (
      (isBuy ? asset.impactAsk : asset.impactBid)
      ?? asset.midPrice
      ?? asset.markPrice
      ?? 0
    );
  }

  private orderSize(notional: number, referencePrice: number, szDecimals: number): number {
    if (!Number.isFinite(notional) || !Number.isFinite(referencePrice) || notional <= 0 || referencePrice <= 0) {
      return 0;
    }

    const size = roundDown(notional / referencePrice, szDecimals);
    if (size > 0) {
      return size;
    }

    return 1 / 10 ** szDecimals;
  }

  private effectiveLeverage(requestedLeverage: number, asset: HyperliquidAssetDescriptor): number {
    return Math.max(1, Math.min(asset.maxLeverage, normalizeLeverage(requestedLeverage)));
  }

  private closeSideIsBuy(side: TradeSide): boolean {
    return side === "SHORT";
  }

  private formatHyperliquidSize(size: number, szDecimals: number): string {
    return formatHyperliquidOrderSize(size, szDecimals);
  }

  private formatHyperliquidPrice(price: number, szDecimals: number): string {
    return formatHyperliquidOrderPrice(price, szDecimals);
  }

  private async cancelOrders(orders: HyperliquidOpenOrder[]): Promise<void> {
    if (orders.length === 0) {
      return;
    }

    const cancels = await Promise.all(
      orders.map(async (order) => {
        const asset = await this.asset(order.coin);
        return {
          a: asset.index,
          o: order.oid
        };
      })
    );

    await this.exchangeClient().cancel({ cancels });
  }

  private async cancelProtectionOrders(symbol: string): Promise<HyperliquidOpenOrder[]> {
    const openOrders = await this.frontendOpenOrders(symbol);
    const protectionOrders = this.protectionOrders(openOrders);
    await this.cancelOrders(protectionOrders);
    return protectionOrders;
  }

  private async placeProtectionOrders(params: {
    symbol: string;
    side: TradeSide;
    takeProfit: number;
    stopLoss: number;
    fallbackSize: number;
    replaceExisting?: boolean;
  }): Promise<ExecutionResult> {
    const { symbol, side, takeProfit, stopLoss, fallbackSize, replaceExisting = false } = params;
    const asset = await this.asset(symbol);
    const openOrders = await this.frontendOpenOrders(symbol);
    const existingProtectionOrders = this.protectionOrders(openOrders);
    const currentTargets = this.currentProtectionTargets(openOrders);

    if (!replaceExisting && this.protectionMatches(currentTargets, takeProfit, stopLoss, asset.szDecimals)) {
      return accepted("OPEN", {
        adapter: "hyperliquid",
        action: "setProtectionOrders",
        symbol: symbol.toUpperCase(),
        alreadyConfigured: true
      });
    }

    if (replaceExisting || existingProtectionOrders.length > 0) {
      await this.cancelOrders(existingProtectionOrders);
    }

    const livePosition = await this.waitForLivePosition(symbol, side);
    const protectionSize = roundDown(livePosition?.size ?? fallbackSize, asset.szDecimals);
    if (!(protectionSize > 0)) {
      return {
        status: "failed",
        reason: `Could not determine a live ${symbol.toUpperCase()} position size for TP/SL placement`
      };
    }

    const isBuy = this.closeSideIsBuy(side);
    const protectionResponse = await this.exchangeClient().order({
      orders: [
        {
          a: asset.index,
          b: isBuy,
          p: this.formatHyperliquidPrice(aggressiveProtectionPrice(takeProfit, isBuy), asset.szDecimals),
          s: this.formatHyperliquidSize(protectionSize, asset.szDecimals),
          r: true,
          t: { trigger: { isMarket: true, triggerPx: this.formatHyperliquidPrice(takeProfit, asset.szDecimals), tpsl: "tp" } },
          c: newCloid()
        },
        {
          a: asset.index,
          b: isBuy,
          p: this.formatHyperliquidPrice(aggressiveProtectionPrice(stopLoss, isBuy), asset.szDecimals),
          s: this.formatHyperliquidSize(protectionSize, asset.szDecimals),
          r: true,
          t: { trigger: { isMarket: true, triggerPx: this.formatHyperliquidPrice(stopLoss, asset.szDecimals), tpsl: "sl" } },
          c: newCloid()
        }
      ],
      grouping: "positionTpsl"
    });

    const protectionErrors = extractHyperliquidOrderErrors(protectionResponse.response.data.statuses);
    if (protectionErrors.length > 0) {
      return {
        status: "failed",
        reason: `Hyperliquid rejected the ${symbol.toUpperCase()} TP/SL update: ${protectionErrors.join(" | ")}`
      };
    }

    const refreshedTargets = await this.waitForProtectionTargets(symbol, takeProfit, stopLoss, asset.szDecimals);
    if (!this.protectionMatches(refreshedTargets, takeProfit, stopLoss, asset.szDecimals)) {
      return {
        status: "failed",
        reason: `Could not confirm ${symbol.toUpperCase()} TP/SL orders on Hyperliquid`
      };
    }

    return accepted("OPEN", {
      adapter: "hyperliquid",
      action: "setProtectionOrders",
      symbol: symbol.toUpperCase(),
      protectionSize,
      statuses: protectionResponse.response.data.statuses
    });
  }

  private async placeReduceOnlyMarketOrder(
    symbol: string,
    side: TradeSide,
    size: number
  ): Promise<{ result: ExecutionResult; liveSizeBefore?: number }> {
    const asset = await this.asset(symbol);
    const livePosition = await this.waitForLivePosition(symbol);
    const closeSize = roundDown(size, asset.szDecimals);
    if (!(closeSize > 0)) {
      return {
        result: {
          status: "failed",
          reason: `Calculated ${symbol.toUpperCase()} close size is zero`
        },
        liveSizeBefore: livePosition?.size
      };
    }

    const referencePrice = this.entryReferencePrice(asset, this.closeSideIsBuy(side));
    const response = await this.exchangeClient().order({
      orders: [
        {
          a: asset.index,
          b: this.closeSideIsBuy(side),
          p: this.formatHyperliquidPrice(
            aggressiveMarketPrice(referencePrice, this.closeSideIsBuy(side)),
            asset.szDecimals
          ),
          s: this.formatHyperliquidSize(closeSize, asset.szDecimals),
          r: true,
          t: { limit: { tif: "FrontendMarket" } },
          c: newCloid()
        }
      ],
      grouping: "na"
    });

    return {
      result: accepted("OPEN", {
        adapter: "hyperliquid",
        action: "reduceOnlyMarketOrder",
        symbol: symbol.toUpperCase(),
        closeSize,
        statuses: response.response.data.statuses
      }),
      liveSizeBefore: livePosition?.size
    };
  }

  private explainApiError(error: unknown): string {
    if (error instanceof ApiRequestError) {
      try {
        return `Hyperliquid rejected the request: ${JSON.stringify(error.response)}`;
      } catch {
        return `Hyperliquid rejected the request: ${extractErrorMessage(error)}`;
      }
    }

    if (error instanceof HttpRequestError) {
      return `Hyperliquid transport error: ${extractErrorMessage(error)}`;
    }

    return extractErrorMessage(error);
  }

  private async withExecutionResult(work: () => Promise<ExecutionResult>): Promise<ExecutionResult> {
    try {
      if (this.isConfigured()) {
        await this.ensureWritableAgentSession();
      }
      return await work();
    } catch (error) {
      const firstFailureReason = this.explainApiError(error);
      if (isRetryableHyperliquidAuthFailure(firstFailureReason)) {
        this.resetCachedState();
        try {
          if (this.isConfigured()) {
            const syncedStatus = await this.syncAgentSession();
            if (syncedStatus.approvalStatus !== "ready" && syncedStatus.approvalStatus !== "synced") {
              throw new Error(this.blockingAgentError(syncedStatus));
            }
          }
          return await work();
        } catch (retryError) {
          return {
            status: "failed",
            reason: this.explainApiError(retryError)
          };
        }
      }

      return {
        status: "failed",
        reason: firstFailureReason
      };
    }
  }

  public async placeEntry(request: ExecutionRequest): Promise<ExecutionResult> {
    return this.withExecutionResult(async () => {
      if (!this.isConfigured()) {
        return {
          status: "failed",
          reason: "Private transport is not authenticated. Configure VALIANT_MASTER_ACCOUNT_ADDRESS and VALIANT_PLAYWRIGHT_PROFILE_DIR, or keep VALIANT_AGENT_KEY as an emergency fallback."
        };
      }

      const asset = await this.asset(request.symbol);
      const appliedLeverage = this.effectiveLeverage(request.leverage, asset);
      const isBuy = request.side === "LONG";
      const referencePrice = this.entryReferencePrice(asset, isBuy);
      if (!(referencePrice > 0)) {
        return {
          status: "failed",
          reason: `Could not resolve a live ${request.symbol.toUpperCase()} reference price`
        };
      }

      const orderNotional = request.margin * appliedLeverage;
      const size = this.orderSize(orderNotional, referencePrice, asset.szDecimals);
      if (!(size > 0)) {
        return {
          status: "failed",
          reason: `Calculated ${request.symbol.toUpperCase()} order size is zero`
        };
      }

      await this.exchangeClient().updateLeverage({
        asset: asset.index,
        isCross: false,
        leverage: appliedLeverage
      });

      const entryCloid = newCloid();
      const orderResponse = await this.exchangeClient().order({
        orders: [
          {
            a: asset.index,
            b: isBuy,
            p: this.formatHyperliquidPrice(aggressiveMarketPrice(referencePrice, isBuy), asset.szDecimals),
            s: this.formatHyperliquidSize(size, asset.szDecimals),
            r: false,
            t: { limit: { tif: "FrontendMarket" } },
            c: entryCloid
          }
        ],
        grouping: "na"
      });

      const remoteOrderId = (() => {
        const status = orderResponse.response.data.statuses[0];
        if (typeof status === "object" && status) {
          if ("filled" in status) {
            return String(status.filled.oid);
          }
          if ("resting" in status) {
            return String(status.resting.oid);
          }
        }
        return entryCloid;
      })();

      return accepted(
        "OPEN",
        {
          adapter: "hyperliquid",
          symbol: request.symbol.toUpperCase(),
          size,
          orderNotional,
          referencePrice,
          requestedLeverage: request.leverage,
          appliedLeverage,
          statuses: orderResponse.response.data.statuses
        },
        remoteOrderId,
        `${await this.tradingAccountAddress()}:${request.symbol.toUpperCase()}`
      );
    });
  }

  public async setProtectionOrders(position: PositionState): Promise<ExecutionResult> {
    return this.withExecutionResult(async () =>
      this.placeProtectionOrders({
        symbol: position.symbol,
        side: position.side,
        takeProfit: position.takeProfit,
        stopLoss: position.stopLoss,
        fallbackSize: position.currentSize,
        replaceExisting: false
      })
    );
  }

  public async moveStopLoss(position: PositionState, stopLoss: number): Promise<ExecutionResult> {
    return this.withExecutionResult(async () => {
      const livePosition = await this.waitForLivePosition(position.symbol, position.side);
      if (!livePosition) {
        return {
          status: "failed",
          reason: `No live ${position.symbol.toUpperCase()} ${position.side} position found while moving the stop loss`
        };
      }

      const openOrders = await this.frontendOpenOrders(position.symbol);
      const currentTargets = this.currentProtectionTargets(openOrders);
      return this.placeProtectionOrders({
        symbol: position.symbol,
        side: position.side,
        takeProfit: currentTargets.takeProfit ?? position.takeProfit,
        stopLoss,
        fallbackSize: position.currentSize,
        replaceExisting: true
      });
    });
  }

  public async partialCloseReduceOnly(position: PositionState, percent: number): Promise<ExecutionResult> {
    return this.withExecutionResult(async () => {
      const asset = await this.asset(position.symbol);
      const openOrders = await this.frontendOpenOrders(position.symbol);
      const currentTargets = this.currentProtectionTargets(openOrders);
      const livePosition = await this.waitForLivePosition(position.symbol, position.side);
      if (!livePosition) {
        return {
          status: "failed",
          reason: `No live ${position.symbol.toUpperCase()} ${position.side} position found while closing 30%`
        };
      }

      const closeSize = this.orderSize((livePosition.size * percent) / 100, 1, asset.szDecimals);
      const { result } = await this.placeReduceOnlyMarketOrder(position.symbol, position.side, closeSize);
      if (result.status !== "accepted") {
        return result;
      }

      const remainingPosition = await this.waitForPositionSizeChange(
        position.symbol,
        position.side,
        livePosition.size,
        asset.szDecimals
      );
      const remainingSize = remainingPosition?.size ?? 0;
      if (remainingPosition && remainingSize >= livePosition.size) {
        return {
          status: "failed",
          reason: `The live ${position.symbol.toUpperCase()} position size did not decrease after the partial close`
        };
      }
      if (!remainingPosition && livePosition.size > closeSize) {
        return {
          status: "failed",
          reason: `The live ${position.symbol.toUpperCase()} position disappeared instead of reducing by 30%`
        };
      }

      await this.cancelProtectionOrders(position.symbol);

      if (remainingPosition && remainingPosition.size > 0) {
        await this.placeProtectionOrders({
          symbol: position.symbol,
          side: position.side,
          takeProfit: currentTargets.takeProfit ?? position.takeProfit,
          stopLoss: currentTargets.stopLoss ?? position.stopLoss,
          fallbackSize: remainingPosition.size,
          replaceExisting: false
        });
      }

      return accepted(remainingPosition ? "OPEN" : "CLOSED", {
        adapter: "hyperliquid",
        action: "partialCloseReduceOnly",
        symbol: position.symbol.toUpperCase(),
        percent,
        remainingSize: remainingPosition?.size ?? 0
      });
    });
  }

  public async closePositionReduceOnly(position: PositionState): Promise<ExecutionResult> {
    return this.withExecutionResult(async () => {
      const livePosition = await this.waitForLivePosition(position.symbol);
      if (!livePosition) {
        await this.cancelProtectionOrders(position.symbol).catch(() => undefined);
        return accepted("CLOSED", {
          adapter: "hyperliquid",
          action: "closePositionReduceOnly",
          symbol: position.symbol.toUpperCase(),
          alreadyClosed: true
        });
      }

      const { result } = await this.placeReduceOnlyMarketOrder(position.symbol, position.side, livePosition.size);
      if (result.status !== "accepted") {
        return result;
      }

      await sleep(HYPERLIQUID_POSITION_SYNC_DELAY_MS);
      await this.cancelProtectionOrders(position.symbol).catch(() => undefined);

      return accepted("CLOSED", {
        adapter: "hyperliquid",
        action: "closePositionReduceOnly",
        symbol: position.symbol.toUpperCase()
      });
    });
  }

  public async cancelPendingByTicker(symbol: string): Promise<ExecutionResult> {
    return this.withExecutionResult(async () => {
      const openOrders = await this.frontendOpenOrders(symbol);
      const cancellable = openOrders.filter((entry) => !entry.reduceOnly);
      await this.cancelOrders(cancellable);
      return accepted("CANCELLED", {
        adapter: "hyperliquid",
        action: "cancelPendingByTicker",
        symbol: symbol.toUpperCase(),
        cancelledOrders: cancellable.length
      });
    });
  }

  public async getPositions(): Promise<PositionSnapshot[]> {
    if (!this.isConfigured()) {
      return [];
    }

    const [positions, openOrders] = await Promise.all([this.livePositions(), this.frontendOpenOrders()]);
    return positions.map((position) => {
      const protectionTargets = this.currentProtectionTargets(
        this.protectionOrders(openOrders.filter((order) => order.coin.toUpperCase() === position.symbol))
      );
      return {
        symbol: position.symbol,
        side: position.side,
        size: position.size,
        entryPrice: position.entryPrice,
        takeProfit: protectionTargets.takeProfit ?? null,
        stopLoss: protectionTargets.stopLoss ?? null,
        leverage: position.leverage,
        markPrice: position.markPrice,
        unrealizedPnl: position.unrealizedPnl,
        status: "OPEN",
        remotePositionId: `${position.symbol}:${position.side}`
      };
    });
  }

  public async applyProfitAction(request: ProfitActionRequest): Promise<ExecutionResult> {
    return accepted("OPEN", {
      adapter: "hyperliquid",
      action: "applyProfitAction",
      request
    });
  }
}

class PlaywrightValiantExecutor implements ExecutionAdapter {
  private context?: BrowserContext;
  private page?: Page;

  public constructor(private readonly config: AppConfig) {}

  private debugArtifactDir(): string {
    return join(this.config.valiantPlaywrightProfileDir, "debug-artifacts");
  }

  private async captureDebugArtifact(action: string): Promise<string | undefined> {
    if (!this.page || this.page.isClosed()) {
      return undefined;
    }

    try {
      mkdirSync(this.debugArtifactDir(), { recursive: true });
      const artifactPath = join(this.debugArtifactDir(), `${Date.now()}-${action}.png`);
      await this.page.screenshot({ path: artifactPath, fullPage: true });
      return artifactPath;
    } catch {
      return undefined;
    }
  }

  private async firstVisible(locators: Locator[], timeout = 1_500, preferLast = false): Promise<Locator | undefined> {
    for (const locator of locators) {
      let count = 0;
      try {
        count = await locator.count();
      } catch {
        count = 0;
      }

      if (count === 0) {
        continue;
      }

      const indexes = Array.from({ length: count }, (_, index) => index);
      if (preferLast) {
        indexes.reverse();
      }

      for (const index of indexes) {
        const candidate = locator.nth(index);
        try {
          await candidate.waitFor({ state: "visible", timeout });
          return candidate;
        } catch {
          // Keep scanning candidates.
        }
      }
    }

    return undefined;
  }

  private async clickFirst(
    locators: Locator[],
    description: string,
    options?: { preferLast?: boolean; timeout?: number }
  ): Promise<Locator> {
    const target = await this.firstVisible(locators, options?.timeout ?? 1_500, options?.preferLast ?? false);
    if (!target) {
      throw new Error(description);
    }

    await target.scrollIntoViewIfNeeded().catch(() => undefined);
    await target.click();
    return target;
  }

  private async maybeClickFirst(locators: Locator[], timeout = 1_000): Promise<boolean> {
    const target = await this.firstVisible(locators, timeout);
    if (!target) {
      return false;
    }

    await target.scrollIntoViewIfNeeded().catch(() => undefined);
    await target.click().catch(() => undefined);
    return true;
  }

  private async fillFirst(locators: Locator[], value: string, description: string, timeout = 1_500): Promise<Locator> {
    const target = await this.firstVisible(locators, timeout);
    if (!target) {
      throw new Error(description);
    }

    await target.scrollIntoViewIfNeeded().catch(() => undefined);
    await target.click({ clickCount: 3 }).catch(() => undefined);
    await target.fill("");
    await target.fill(value);
    return target;
  }

  private async hasVisibleText(scope: Page | Locator, pattern: RegExp, timeout = 1_000): Promise<boolean> {
    const match = await this.firstVisible([scope.getByText(pattern)], timeout);
    return Boolean(match);
  }

  private async ensurePage(symbol?: string): Promise<Page> {
    if (!this.page || this.page.isClosed()) {
      mkdirSync(this.config.valiantPlaywrightProfileDir, { recursive: true });
      const executablePath = resolvePlaywrightExecutablePath(this.config.valiantPlaywrightExecutablePath);
      try {
        this.context = await chromium.launchPersistentContext(this.config.valiantPlaywrightProfileDir, {
          headless: this.config.valiantPlaywrightHeadless ?? true,
          viewport: { width: 1600, height: 1200 },
          executablePath,
          channel: executablePath ? undefined : "chrome",
          args: ["--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check"]
        });
      } catch (error) {
        const guidance = executablePath
          ? `Playwright could not launch ${executablePath}`
          : "Playwright could not find a Brave, Chrome, or Chromium executable. Set VALIANT_PLAYWRIGHT_EXECUTABLE_PATH.";
        throw new Error(`${guidance} ${extractErrorMessage(error)}`.trim());
      }

      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      this.page.setDefaultTimeout(10_000);
    }

    const targetUrl = resolveValiantMarketUrl(this.config.valiantBaseUrl, this.config.valiantMarketRoute, symbol);
    await this.page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await this.page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    await this.assertTradingSessionReady(this.page);

    if (symbol && !routeHasSymbolPlaceholder(this.config.valiantMarketRoute)) {
      await this.ensureMarketSelected(this.page, symbol);
    }

    return this.page;
  }

  private async assertTradingSessionReady(page: Page): Promise<void> {
    if (
      (await this.hasVisibleText(page, /log in with fogo|login with fogo|sign in|connect wallet/i, 1_500)) &&
      !(await this.hasVisibleText(page, /positions|open orders|order type|market/i, 500))
    ) {
      throw new Error(
        "The Valiant Playwright profile is not signed in. Open the profile manually, complete the Fogo session, then retry."
      );
    }

    if (await this.hasVisibleText(page, /enable perps trading/i, 1_500)) {
      throw new Error(
        "Perps trading is not enabled for this Valiant profile yet. Complete the one-time Enable Perps Trading flow first."
      );
    }
  }

  private async ensureMarketSelected(page: Page, symbol: string): Promise<void> {
    const symbolPattern = new RegExp(`\\b${symbol}\\b`, "i");

    const alreadySelected = await this.firstVisible(
      [
        page.getByRole("heading", { name: symbolPattern }),
        page.getByRole("button", { name: symbolPattern }),
        page.locator("h1, h2, [data-testid*='market'], [class*='market']").filter({ hasText: symbolPattern })
      ],
      1_000
    );
    if (alreadySelected) {
      return;
    }

    await this.clickFirst(
      [
        page.getByRole("button", { name: /market|pair|asset|select/i }),
        page.getByRole("combobox", { name: /market|pair|asset|select/i }),
        page.locator("button, [role='button']").filter({ hasText: /market|pair|asset|select/i })
      ],
      `Could not find the Valiant market selector for ${symbol}`
    );

    await this.fillFirst(
      [
        page.getByRole("searchbox"),
        page.getByRole("textbox", { name: /search/i }),
        page.getByPlaceholder(/search/i),
        page.locator("input[type='search'], input[placeholder*='Search'], input[placeholder*='search']")
      ],
      symbol,
      `Could not find the market search field after opening the Valiant selector for ${symbol}`,
      3_000
    );

    await this.clickFirst(
      [
        page.getByRole("option", { name: symbolPattern }),
        page.getByRole("button", { name: symbolPattern }),
        page.locator("[role='option'], button, a, li, div").filter({ hasText: symbolPattern })
      ],
      `Could not select ${symbol} from the Valiant market list`,
      { timeout: 5_000 }
    );

    await page.waitForTimeout(400);
  }

  private async chooseTradeSide(page: Page, side: TradeSide): Promise<void> {
    const readableSide = titleCaseSide(side);
    await this.clickFirst(
      [
        page.getByRole("button", { name: new RegExp(`^${readableSide}$`, "i") }),
        page.getByRole("tab", { name: new RegExp(`^${readableSide}$`, "i") }),
        page.locator("button, [role='tab']").filter({ hasText: new RegExp(`^${readableSide}$`, "i") })
      ],
      `Could not find the ${readableSide} trade side toggle`
    );
  }

  private async chooseMarginMode(page: Page): Promise<void> {
    await this.maybeClickFirst(
      [
        page.getByRole("button", { name: /^Isolated$/i }),
        page.getByRole("tab", { name: /^Isolated$/i }),
        page.locator("button, [role='tab']").filter({ hasText: /^Isolated$/i })
      ],
      1_000
    );
  }

  private async setLeverage(page: Page, requestedLeverage: number): Promise<number> {
    const normalizedRequestedLeverage = normalizeLeverage(requestedLeverage);

    await this.clickFirst(
      [
        page.getByRole("button", { name: /leverage|\d+(?:\.\d+)?x/i }),
        page.locator("button, [role='button']").filter({ hasText: /leverage|\d+(?:\.\d+)?x/i })
      ],
      "Could not find the leverage control"
    );

    const leverageButtons = await this.firstVisible(
      [
        page.getByRole("button", { name: /\d+(?:\.\d+)?x/i }),
        page.locator("button, [role='button']").filter({ hasText: /\d+(?:\.\d+)?x/i })
      ],
      3_000
    );

    if (leverageButtons) {
      const candidateLocator = page
        .getByRole("button", { name: /\d+(?:\.\d+)?x/i })
        .or(page.locator("button, [role='button']").filter({ hasText: /\d+(?:\.\d+)?x/i }));
      const count = await candidateLocator.count().catch(() => 0);
      const available: Array<{ label: string; value: number; index: number }> = [];
      for (let index = 0; index < count; index += 1) {
        try {
          const label = normalizeWhitespace((await candidateLocator.nth(index).innerText()).trim());
          const parsed = parseLeverageChoice(label);
          if (parsed) {
            available.push({ label, value: parsed, index });
          }
        } catch {
          // Ignore detached chips.
        }
      }

      const preferred = pickPreferredLeverageChoice(requestedLeverage, available.map((item) => item.value));
      if (preferred) {
        const match = available.find((item) => item.value === preferred);
        if (match) {
          await candidateLocator.nth(match.index).click();
          await this.maybeClickFirst(
            [
              page.getByRole("button", { name: /apply|save|confirm|done/i }),
              page.locator("button, [role='button']").filter({ hasText: /apply|save|confirm|done/i })
            ],
            1_500
          );
          return preferred;
        }
      }
    }

    await this.fillFirst(
      [
        page.getByRole("spinbutton", { name: /leverage/i }),
        page.getByRole("textbox", { name: /leverage/i }),
        page.getByLabel(/leverage/i)
      ],
      formatDecimal(normalizedRequestedLeverage, 0),
      "Could not find a leverage input or selection chip"
    );

    await this.maybeClickFirst(
      [
        page.getByRole("button", { name: /apply|save|confirm|done/i }),
        page.locator("button, [role='button']").filter({ hasText: /apply|save|confirm|done/i })
      ],
      1_500
    );

    return normalizedRequestedLeverage;
  }

  private async chooseMarketOrderType(page: Page): Promise<void> {
    await this.maybeClickFirst(
      [
        page.getByRole("button", { name: /^Market$/i }),
        page.getByRole("tab", { name: /^Market$/i }),
        page.locator("button, [role='tab']").filter({ hasText: /^Market$/i })
      ],
      1_500
    );
  }

  private async fillOrderValue(page: Page, value: string): Promise<void> {
    await this.fillFirst(
      [
        page.getByLabel(/quantity|value|order value|size|amount/i),
        page.getByRole("spinbutton", { name: /quantity|value|order value|size|amount/i }),
        page.getByRole("textbox", { name: /quantity|value|order value|size|amount/i }),
        page.getByPlaceholder(/quantity|value|order value|size|amount/i),
        page.locator("input[inputmode='decimal'], input[type='number'], input")
      ],
      value,
      "Could not find the Valiant order size input",
      3_000
    );
  }

  private async openPositionsTab(page: Page): Promise<void> {
    await this.clickFirst(
      [
        page.getByRole("tab", { name: /^Positions$/i }),
        page.getByRole("button", { name: /^Positions$/i }),
        page.locator("button, [role='tab']").filter({ hasText: /^Positions$/i })
      ],
      "Could not find the Positions tab",
      { timeout: 3_000 }
    );
  }

  private async openOpenOrdersTab(page: Page): Promise<void> {
    await this.clickFirst(
      [
        page.getByRole("tab", { name: /open orders/i }),
        page.getByRole("button", { name: /open orders/i }),
        page.locator("button, [role='tab']").filter({ hasText: /open orders/i })
      ],
      "Could not find the Open Orders tab",
      { timeout: 3_000 }
    );
  }

  private async findRow(page: Page, tabName: "Positions" | "Open Orders", symbol: string, side?: TradeSide): Promise<Locator> {
    if (tabName === "Positions") {
      await this.openPositionsTab(page);
    } else {
      await this.openOpenOrdersTab(page);
    }

    const symbolPattern = side
      ? new RegExp(`\\b${symbol}\\b[\\s\\S]*\\b${side}\\b|\\b${side}\\b[\\s\\S]*\\b${symbol}\\b`, "i")
      : new RegExp(`\\b${symbol}\\b`, "i");

    const row = await this.firstVisible(
      [
        page.getByRole("row").filter({ hasText: symbolPattern }),
        page.locator("tr, [role='row']").filter({ hasText: symbolPattern })
      ],
      5_000
    );

    if (!row) {
      throw new Error(`Could not find ${symbol}${side ? ` ${side}` : ""} in the Valiant ${tabName} tab`);
    }

    return row;
  }

  private async openProtectionEditor(page: Page, position: PositionState): Promise<void> {
    const row = await this.findRow(page, "Positions", position.symbol, position.side);
    await this.clickFirst(
      [
        row.getByRole("button", { name: /tp\/sl|take profit|stop loss|edit|manage/i }),
        row.locator("button, [role='button']").filter({ hasText: /tp\/sl|take profit|stop loss|edit|manage/i })
      ],
      `Could not find the TP/SL editor for ${position.symbol} ${position.side}`,
      { preferLast: true, timeout: 2_000 }
    );
  }

  private async saveProtectionOrders(page: Page, takeProfit: number, stopLoss: number): Promise<void> {
    await this.maybeClickFirst(
      [
        page.getByRole("checkbox", { name: /take profit/i }),
        page.getByRole("switch", { name: /take profit/i }),
        page.locator("[role='checkbox'], [role='switch']").filter({ hasText: /take profit/i })
      ],
      500
    );
    await this.maybeClickFirst(
      [
        page.getByRole("checkbox", { name: /stop loss/i }),
        page.getByRole("switch", { name: /stop loss/i }),
        page.locator("[role='checkbox'], [role='switch']").filter({ hasText: /stop loss/i })
      ],
      500
    );

    await this.fillFirst(
      [
        page.getByLabel(/take profit|tp/i),
        page.getByRole("spinbutton", { name: /take profit|tp/i }),
        page.getByRole("textbox", { name: /take profit|tp/i }),
        page.getByPlaceholder(/take profit|tp/i)
      ],
      formatDecimal(takeProfit, 4),
      "Could not find the Take Profit input",
      3_000
    );

    await this.fillFirst(
      [
        page.getByLabel(/stop loss|sl/i),
        page.getByRole("spinbutton", { name: /stop loss|sl/i }),
        page.getByRole("textbox", { name: /stop loss|sl/i }),
        page.getByPlaceholder(/stop loss|sl/i)
      ],
      formatDecimal(stopLoss, 4),
      "Could not find the Stop Loss input",
      3_000
    );

    await this.clickFirst(
      [
        page.getByRole("button", { name: /save|apply|update|confirm|submit/i }),
        page.locator("button, [role='button']").filter({ hasText: /save|apply|update|confirm|submit/i })
      ],
      "Could not find the TP/SL confirmation button",
      { preferLast: true, timeout: 3_000 }
    );
  }

  private async openCloseDialog(page: Page, position: PositionState): Promise<void> {
    const row = await this.findRow(page, "Positions", position.symbol, position.side);
    await this.clickFirst(
      [
        row.getByRole("button", { name: /close|reduce|market close/i }),
        row.locator("button, [role='button']").filter({ hasText: /close|reduce|market close/i })
      ],
      `Could not find the Close action for ${position.symbol} ${position.side}`,
      { preferLast: true, timeout: 2_000 }
    );
  }

  private async submitClose(page: Page, amount: string, percent?: number): Promise<void> {
    const percentLabel = percent ? new RegExp(`^${formatDecimal(percent, 2)}%$`) : undefined;
    if (percentLabel) {
      await this.maybeClickFirst(
        [
          page.getByRole("button", { name: percentLabel }),
          page.locator("button, [role='button']").filter({ hasText: percentLabel })
        ],
        1_000
      );
    }

    await this.fillFirst(
      [
        page.getByLabel(/amount|size|quantity/i),
        page.getByRole("spinbutton", { name: /amount|size|quantity/i }),
        page.getByRole("textbox", { name: /amount|size|quantity/i }),
        page.getByPlaceholder(/amount|size|quantity/i)
      ],
      amount,
      "Could not find the close amount input",
      3_000
    );

    await this.clickFirst(
      [
        page.getByRole("button", { name: /close position|market close|confirm|close/i }),
        page.locator("button, [role='button']").filter({ hasText: /close position|market close|confirm|close/i })
      ],
      "Could not find the close confirmation button",
      { preferLast: true, timeout: 3_000 }
    );
  }

  private async detectInlineError(page: Page): Promise<string | undefined> {
    const errorCandidate = await this.firstVisible(
      [
        page.getByText(/invalid value|expected a positive number|insufficient|failed|error/i),
        page.locator("[role='alert'], [data-state='error'], .error, .toast-error")
      ],
      1_500
    );

    if (!errorCandidate) {
      return undefined;
    }

    try {
      const text = normalizeWhitespace(await errorCandidate.innerText());
      return text || "Valiant reported an error";
    } catch {
      return "Valiant reported an error";
    }
  }

  private async classifySubmittedEntry(
    page: Page,
    request: ExecutionRequest,
    appliedLeverage: number
  ): Promise<ExecutionResult> {
    const failureText = await this.detectInlineError(page);
    if (failureText) {
      return {
        status: "failed",
        reason: failureText
      };
    }

    try {
      await this.findRow(page, "Positions", request.symbol, request.side);
      return accepted("OPEN", {
        adapter: "playwright",
        verification: "positions-tab",
        marketUrl: page.url(),
        orderValueUsdc: formatValiantOrderValue(request.margin, appliedLeverage),
        appliedLeverage
      });
    } catch {
      // Continue.
    }

    try {
      await this.findRow(page, "Open Orders", request.symbol, request.side);
      return accepted("PENDING", {
        adapter: "playwright",
        verification: "open-orders-tab",
        marketUrl: page.url(),
        orderValueUsdc: formatValiantOrderValue(request.margin, appliedLeverage),
        appliedLeverage
      });
    } catch {
      return accepted("OPEN", {
        adapter: "playwright",
        verification: "assumed-after-submit",
        marketUrl: page.url(),
        orderValueUsdc: formatValiantOrderValue(request.margin, appliedLeverage),
        appliedLeverage
      });
    }
  }

  private async runAction(
    action: string,
    symbol: string | undefined,
    work: (page: Page) => Promise<ExecutionResult>
  ): Promise<ExecutionResult> {
    try {
      const page = await this.ensurePage(symbol);
      return await work(page);
    } catch (error) {
      const artifactPath = await this.captureDebugArtifact(action);
      return {
        status: "failed",
        reason: `Playwright ${action} failed: ${extractErrorMessage(error)}${
          artifactPath ? ` (screenshot: ${artifactPath})` : ""
        }`
      };
    }
  }

  public async placeEntry(request: ExecutionRequest): Promise<ExecutionResult> {
    return this.runAction("placeEntry", request.symbol, async (page) => {
      await this.chooseTradeSide(page, request.side);
      await this.chooseMarginMode(page);
      const appliedLeverage = await this.setLeverage(page, request.leverage);
      await this.chooseMarketOrderType(page);
      await this.fillOrderValue(page, formatValiantOrderValue(request.margin, appliedLeverage));

      await this.clickFirst(
        [
          page.getByRole("button", { name: new RegExp(`open\\s+${titleCaseSide(request.side)}`, "i") }),
          page.getByRole("button", { name: new RegExp(`place\\s+${titleCaseSide(request.side)}`, "i") }),
          page.getByRole("button", { name: new RegExp(`market\\s+${titleCaseSide(request.side)}`, "i") }),
          page.getByRole("button", { name: new RegExp(`\\b${titleCaseSide(request.side)}\\b`, "i") }),
          page.locator("button, [role='button']").filter({ hasText: new RegExp(`\\b${titleCaseSide(request.side)}\\b`, "i") })
        ],
        `Could not find the ${titleCaseSide(request.side)} submit button`,
        { preferLast: true, timeout: 4_000 }
      );

      await this.maybeClickFirst(
        [
          page.getByRole("button", { name: /confirm|place order|submit/i }),
          page.locator("button, [role='button']").filter({ hasText: /confirm|place order|submit/i })
        ],
        2_000
      );

      return this.classifySubmittedEntry(page, request, appliedLeverage);
    });
  }

  public async setProtectionOrders(position: PositionState): Promise<ExecutionResult> {
    return this.runAction("setProtectionOrders", position.symbol, async (page) => {
      await this.openProtectionEditor(page, position);
      await this.saveProtectionOrders(page, position.takeProfit, position.stopLoss);
      const failureText = await this.detectInlineError(page);
      if (failureText) {
        return { status: "failed", reason: failureText };
      }
      return accepted(position.status, {
        adapter: "playwright",
        action: "setProtectionOrders",
        positionId: position.id
      });
    });
  }

  public async moveStopLoss(position: PositionState, stopLoss: number): Promise<ExecutionResult> {
    return this.runAction("moveStopLoss", position.symbol, async (page) => {
      await this.openProtectionEditor(page, position);
      await this.saveProtectionOrders(page, position.takeProfit, stopLoss);
      const failureText = await this.detectInlineError(page);
      if (failureText) {
        return { status: "failed", reason: failureText };
      }
      return accepted(position.status, {
        adapter: "playwright",
        action: "moveStopLoss",
        positionId: position.id,
        stopLoss
      });
    });
  }

  public async partialCloseReduceOnly(position: PositionState, percent: number): Promise<ExecutionResult> {
    return this.runAction("partialCloseReduceOnly", position.symbol, async (page) => {
      await this.openCloseDialog(page, position);
      const closeAmount = formatValiantAssetAmount(position.currentSize * (percent / 100));
      await this.submitClose(page, closeAmount, percent);
      const failureText = await this.detectInlineError(page);
      if (failureText) {
        return { status: "failed", reason: failureText };
      }
      return accepted("OPEN", {
        adapter: "playwright",
        action: "partialCloseReduceOnly",
        positionId: position.id,
        percent,
        closeAmount
      });
    });
  }

  public async closePositionReduceOnly(position: PositionState): Promise<ExecutionResult> {
    return this.runAction("closePositionReduceOnly", position.symbol, async (page) => {
      await this.openCloseDialog(page, position);
      await this.submitClose(page, formatValiantAssetAmount(position.currentSize), 100);
      const failureText = await this.detectInlineError(page);
      if (failureText) {
        return { status: "failed", reason: failureText };
      }
      return accepted("CLOSED", {
        adapter: "playwright",
        action: "closePositionReduceOnly",
        positionId: position.id
      });
    });
  }

  public async cancelPendingByTicker(symbol: string): Promise<ExecutionResult> {
    return this.runAction("cancelPendingByTicker", symbol, async (page) => {
      let row: Locator | undefined;
      try {
        row = await this.findRow(page, "Open Orders", symbol);
      } catch {
        return accepted("CANCELLED", {
          adapter: "playwright",
          action: "cancelPendingByTicker",
          symbol,
          verification: "no-open-order-visible"
        });
      }

      await this.clickFirst(
        [
          row.getByRole("button", { name: /cancel/i }),
          row.locator("button, [role='button']").filter({ hasText: /cancel/i })
        ],
        `Could not find the cancel button for ${symbol}`,
        { preferLast: true, timeout: 2_000 }
      );

      const failureText = await this.detectInlineError(page);
      if (failureText) {
        return { status: "failed", reason: failureText };
      }

      return accepted("CANCELLED", {
        adapter: "playwright",
        action: "cancelPendingByTicker",
        symbol
      });
    });
  }

  public async getPositions(): Promise<PositionSnapshot[]> {
    const result = await this.runAction("getPositions", undefined, async () => accepted("OPEN"));
    if (result.status !== "accepted") {
      return [];
    }
    return [];
  }

  public async applyProfitAction(request: ProfitActionRequest): Promise<ExecutionResult> {
    return this.runAction("applyProfitAction", request.symbol, async (page) => {
      const row = await this.findRow(page, "Positions", request.symbol, request.side);
      await this.openProtectionEditor(page, {
        id: request.positionId,
        symbol: request.symbol,
        side: request.side,
        status: "OPEN",
        entryPrice: request.breakevenPrice,
        currentSize: 0,
        initialSize: 0,
        takeProfit: request.breakevenPrice,
        stopLoss: request.breakevenPrice,
        leverage: 1,
        margin: 0,
        sourceMessageId: "",
        sourceChatId: "",
        senderId: "",
        remoteOrderId: null,
        remotePositionId: null,
        profitActionApplied: false,
        lastError: null,
        createdAt: "",
        updatedAt: ""
      });
      await this.saveProtectionOrders(page, request.breakevenPrice, request.breakevenPrice);

      await this.clickFirst(
        [
          row.getByRole("button", { name: /close|reduce|market close/i }),
          row.locator("button, [role='button']").filter({ hasText: /close|reduce|market close/i })
        ],
        `Could not find the Close action for ${request.symbol} ${request.side}`,
        { preferLast: true, timeout: 2_000 }
      );

      const percentButtonPattern = new RegExp(`^${formatDecimal(request.partialClosePercent, 2)}%$`);
      const percentButton = await this.firstVisible(
        [
          page.getByRole("button", { name: percentButtonPattern }),
          page.locator("button, [role='button']").filter({ hasText: percentButtonPattern })
        ],
        2_000
      );
      if (!percentButton) {
        return {
          status: "failed",
          reason: `Could not find a ${request.partialClosePercent}% close button in the Valiant close dialog`
        };
      }

      await percentButton.click();
      await this.clickFirst(
        [
          page.getByRole("button", { name: /close position|market close|confirm|close/i }),
          page.locator("button, [role='button']").filter({ hasText: /close position|market close|confirm|close/i })
        ],
        "Could not find the close confirmation button",
        { preferLast: true, timeout: 3_000 }
      );

      const failureText = await this.detectInlineError(page);
      if (failureText) {
        return { status: "failed", reason: failureText };
      }

      return accepted("OPEN", {
        adapter: "playwright",
        action: "applyProfitAction",
        positionId: request.positionId,
        partialClosePercent: request.partialClosePercent
      });
    });
  }

  public async syncAgentSession(): Promise<AgentSessionStatus> {
    return {
      ...emptyAgentSessionStatus(this.config),
      approvalStatus: "missing",
      lastCheckedAt: new Date().toISOString(),
      lastSyncAt: null,
      lastError: "Playwright execution does not maintain an API agent session."
    };
  }

  public async getAgentSessionStatus(): Promise<AgentSessionStatus> {
    return this.syncAgentSession();
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

  private adapterSequence(): Array<{ name: string; adapter: ExecutionAdapter }> {
    switch (this.config.valiantExecutionMode) {
      case "dry-run":
        return [{ name: "dry-run", adapter: this.dryRun }];
      case "private":
        return [{ name: "private", adapter: this.privateTransport }];
      case "playwright":
        return [{ name: "playwright", adapter: this.playwright }];
      case "hybrid":
        return [
          { name: "private", adapter: this.privateTransport },
          { name: "playwright", adapter: this.playwright }
        ];
      default:
        return [{ name: "dry-run", adapter: this.dryRun }];
    }
  }

  private shouldTryPlaywrightFallback(method: keyof ExecutionAdapter, adapterName: string, failureReason: string): boolean {
    return this.config.valiantExecutionMode === "private"
      && adapterName === "private"
      && method !== "getPositions"
      && isRetryableHyperliquidAuthFailure(failureReason);
  }

  private async runWithPlaywrightFallback(
    method: keyof ExecutionAdapter,
    args: unknown[],
    failures: string[]
  ): Promise<ExecutionResult | null> {
    try {
      const fn = this.playwright[method] as (...inner: unknown[]) => Promise<ExecutionResult>;
      const result = await fn.apply(this.playwright, args);
      if (result.status === "accepted") {
        return result;
      }

      failures.push(`playwright: ${result.reason ?? result.status}`);
      return null;
    } catch (error) {
      failures.push(`playwright: ${extractErrorMessage(error)}`);
      return null;
    }
  }

  private async run(method: keyof ExecutionAdapter, ...args: unknown[]): Promise<ExecutionResult> {
    const failures: string[] = [];

    for (const { name, adapter } of this.adapterSequence()) {
      try {
        const fn = adapter[method] as (...inner: unknown[]) => Promise<ExecutionResult>;
        const result = await fn.apply(adapter, args);
        if (result.status === "accepted") {
          return result;
        }

        const failureReason = result.reason ?? result.status;
        failures.push(`${name}: ${failureReason}`);
        if (this.shouldTryPlaywrightFallback(method, name, failureReason)) {
          const fallbackResult = await this.runWithPlaywrightFallback(method, args, failures);
          if (fallbackResult) {
            return fallbackResult;
          }
        }
      } catch (error) {
        const failureReason = extractErrorMessage(error);
        failures.push(`${name}: ${failureReason}`);
        if (this.shouldTryPlaywrightFallback(method, name, failureReason)) {
          const fallbackResult = await this.runWithPlaywrightFallback(method, args, failures);
          if (fallbackResult) {
            return fallbackResult;
          }
        }
      }
    }

    return {
      status: "failed",
      reason: failures.length > 0 ? failures.join(" | ") : `No execution adapter succeeded for ${String(method)}`
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
    const failures: string[] = [];

    for (const { adapter } of this.adapterSequence()) {
      try {
        const positions = await adapter.getPositions();
        if (positions.length > 0) {
          return positions;
        }
      } catch (error) {
        failures.push(extractErrorMessage(error));
      }
    }

    if (failures.length > 0) {
      throw new Error(failures.join(" | "));
    }

    return [];
  }

  public applyProfitAction(request: ProfitActionRequest): Promise<ExecutionResult> {
    return this.run("applyProfitAction", request);
  }

  public async syncAgentSession(): Promise<AgentSessionStatus> {
    const privateAdapter = this.privateTransport as ExecutionAdapter;
    if (privateAdapter.syncAgentSession) {
      return privateAdapter.syncAgentSession();
    }
    return {
      ...emptyAgentSessionStatus(this.config),
      approvalStatus: "missing",
      lastCheckedAt: new Date().toISOString(),
      lastSyncAt: null,
      lastError: "The configured execution adapter does not support agent sync."
    };
  }

  public async getAgentSessionStatus(): Promise<AgentSessionStatus> {
    const privateAdapter = this.privateTransport as ExecutionAdapter;
    if (privateAdapter.getAgentSessionStatus) {
      return privateAdapter.getAgentSessionStatus();
    }
    return this.syncAgentSession();
  }
}

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return randomUUID();
}

export function ensureParentDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase();
}

export function normalizeLeverage(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.max(1, Math.round(value));
}

export function round(value: number, decimals = 8): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function leverageMarginMultiplier(requestedLeverage: number, appliedLeverage: number): number {
  if (
    !Number.isFinite(requestedLeverage)
    || requestedLeverage <= 0
    || !Number.isFinite(appliedLeverage)
    || appliedLeverage <= 0
  ) {
    return 1;
  }

  return requestedLeverage / appliedLeverage;
}

export function leverageAdjustedMargin(
  baseMargin: number,
  requestedLeverage: number,
  appliedLeverage: number
): number {
  if (!Number.isFinite(baseMargin) || baseMargin <= 0) {
    return 0;
  }

  return round(baseMargin * leverageMarginMultiplier(requestedLeverage, appliedLeverage), 8);
}

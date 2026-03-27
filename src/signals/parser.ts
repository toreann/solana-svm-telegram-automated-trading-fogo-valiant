import type { ParsedEntrySignal, ParsedProfitSignal, ParsedSignal, TradeSide } from "../types.js";
import { normalizeLeverage, normalizeSymbol } from "../utils.js";

function normalizeNumericString(value: string): string {
  const sanitized = value.replace("$", "").replace(/\s+/g, "").trim();
  const lastComma = sanitized.lastIndexOf(",");
  const lastDot = sanitized.lastIndexOf(".");

  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      return sanitized.replace(/\./g, "").replace(",", ".");
    }
    return sanitized.replace(/,/g, "");
  }

  if (lastComma >= 0) {
    const fractionalDigits = sanitized.length - lastComma - 1;
    if (fractionalDigits > 0 && fractionalDigits <= 2) {
      return sanitized.replace(",", ".");
    }
    return sanitized.replace(/,/g, "");
  }

  if (lastDot >= 0) {
    const fractionalDigits = sanitized.length - lastDot - 1;
    if (fractionalDigits === 3 && sanitized.indexOf(".") === lastDot) {
      return sanitized.replace(/\./g, "");
    }
  }

  return sanitized;
}

function parsePrice(value: string): number {
  return Number.parseFloat(normalizeNumericString(value));
}

function parseRoundedPrice(value: string): number {
  return Math.round(parsePrice(value));
}

function parseCompactDecimal(value: string): number {
  return Number.parseFloat(value.replace(",", ".").trim());
}

function toSearchableText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "");
}

function parseSide(value: string): TradeSide {
  if (value.includes("LONG")) {
    return "LONG";
  }
  if (value.includes("SHORT")) {
    return "SHORT";
  }
  throw new Error(`Unsupported trade side: ${value}`);
}

export function parseSignal(text: string, messageId: string, messageDate: string): ParsedSignal | null {
  const normalized = text.replace(/\r/g, "").trim();
  const searchable = toSearchableText(normalized);
  if (/NOVO SINAL/i.test(searchable)) {
    return parseEntrySignal(normalized, messageId, messageDate);
  }
  if (/LUCRO/i.test(searchable)) {
    return parseProfitSignal(normalized, messageId, messageDate);
  }
  return null;
}

export function parseEntrySignal(text: string, messageId: string, messageDate: string): ParsedEntrySignal {
  const searchable = toSearchableText(text);
  const signalIdMatch = searchable.match(/#([A-Z0-9]+)/i);
  const ativoMatch = searchable.match(/Ativo:\s*([A-Z0-9]+)/i);
  const directionMatch = searchable.match(/Direcao:\s*([^\n]+)/i);
  const entryMatch = searchable.match(/Entrada:\s*\$?\s*([0-9][0-9.,]*)/i);
  const tpMatch = searchable.match(/TP:\s*\$?\s*([0-9][0-9.,]*)/i);
  const slMatch = searchable.match(/SL:\s*\$?\s*([0-9][0-9.,]*)/i);
  const leverageMatch = searchable.match(/Alavancagem max:\s*([0-9]+(?:[.,][0-9]+)?)x/i);
  const statusMatch = searchable.match(/Status:\s*([^\n]+)/i);
  if (!ativoMatch || !directionMatch || !entryMatch || !tpMatch || !slMatch || !leverageMatch || !statusMatch) {
    throw new Error("Message does not match entry signal template");
  }
  return {
    type: "ENTRY",
    symbol: normalizeSymbol(ativoMatch[1]),
    side: parseSide(directionMatch[1]),
    entry: parseRoundedPrice(entryMatch[1]),
    takeProfit: parseRoundedPrice(tpMatch[1]),
    stopLoss: parseRoundedPrice(slMatch[1]),
    leverage: normalizeLeverage(parseCompactDecimal(leverageMatch[1])),
    statusText: statusMatch[1].trim(),
    signalId: signalIdMatch?.[1],
    messageId,
    messageDate,
    rawText: text
  };
}

export function parseProfitSignal(text: string, messageId: string, messageDate: string): ParsedProfitSignal {
  const searchable = toSearchableText(text);
  const signalIdMatch = searchable.match(/#([A-Z0-9]+)/i);
  const headerMatch = searchable.match(/\n([A-Z0-9]+)\s+[^\n]*\b(LONG|SHORT)\b/i);
  const currentProfitMatch = searchable.match(/Lucro atual:\s*([+-]?[0-9]+(?:[.,][0-9]+)?)%/i);
  const leveragedProfitMatch = searchable.match(/\(ou\s*([+-]?[0-9]+(?:[.,][0-9]+)?)%\s+com alav/i);
  const priceMatch = searchable.match(/Preco:\s*\$?\s*([0-9][0-9.,]*)\s*[^0-9$]+\s*\$?\s*([0-9][0-9.,]*)/i);
  if (!headerMatch || !currentProfitMatch || !priceMatch) {
    throw new Error("Message does not match profit signal template");
  }
  return {
    type: "PROFIT",
    symbol: normalizeSymbol(headerMatch[1]),
    side: parseSide(headerMatch[2]),
    currentProfitPct: parseCompactDecimal(currentProfitMatch[1]),
    leveragedProfitPct: leveragedProfitMatch ? parseCompactDecimal(leveragedProfitMatch[1]) : null,
    priceFrom: parsePrice(priceMatch[1]),
    priceTo: parsePrice(priceMatch[2]),
    signalId: signalIdMatch?.[1],
    messageId,
    messageDate,
    rawText: text
  };
}

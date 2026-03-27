import type { ParsedEntrySignal, ParsedProfitSignal, ParsedSignal, TradeSide } from "../types.js";
import { normalizeSymbol } from "../utils.js";

function parsePrice(value: string): number {
  return Number.parseFloat(value.replace("$", "").trim());
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
  if (/NOVO SINAL/i.test(normalized)) {
    return parseEntrySignal(normalized, messageId, messageDate);
  }
  if (/LUCRO/i.test(normalized)) {
    return parseProfitSignal(normalized, messageId, messageDate);
  }
  return null;
}

export function parseEntrySignal(text: string, messageId: string, messageDate: string): ParsedEntrySignal {
  const signalIdMatch = text.match(/#([A-Z0-9]+)/i);
  const ativoMatch = text.match(/Ativo:\s*([A-Z0-9]+)/i);
  const directionMatch = text.match(/Direção:\s*([^\n]+)/i);
  const entryMatch = text.match(/Entrada:\s*\$?([0-9]+(?:\.[0-9]+)?)/i);
  const tpMatch = text.match(/TP:\s*\$?([0-9]+(?:\.[0-9]+)?)/i);
  const slMatch = text.match(/SL:\s*\$?([0-9]+(?:\.[0-9]+)?)/i);
  const leverageMatch = text.match(/Alavancagem máx:\s*([0-9]+(?:\.[0-9]+)?)x/i);
  const statusMatch = text.match(/Status:\s*([^\n]+)/i);
  if (!ativoMatch || !directionMatch || !entryMatch || !tpMatch || !slMatch || !leverageMatch || !statusMatch) {
    throw new Error("Message does not match entry signal template");
  }
  return {
    type: "ENTRY",
    symbol: normalizeSymbol(ativoMatch[1]),
    side: parseSide(directionMatch[1]),
    entry: parsePrice(entryMatch[1]),
    takeProfit: parsePrice(tpMatch[1]),
    stopLoss: parsePrice(slMatch[1]),
    leverage: Number.parseFloat(leverageMatch[1]),
    statusText: statusMatch[1].trim(),
    signalId: signalIdMatch?.[1],
    messageId,
    messageDate,
    rawText: text
  };
}

export function parseProfitSignal(text: string, messageId: string, messageDate: string): ParsedProfitSignal {
  const signalIdMatch = text.match(/#([A-Z0-9]+)/i);
  const headerMatch = text.match(/\n([A-Z0-9]+)\s+[^\n]*\b(LONG|SHORT)\b/i);
  const currentProfitMatch = text.match(/Lucro atual:\s*([+-]?[0-9]+(?:\.[0-9]+)?)%/i);
  const leveragedProfitMatch = text.match(/\(ou\s*([+-]?[0-9]+(?:\.[0-9]+)?)%\s+com alav/i);
  const priceMatch = text.match(/Preço:\s*\$?([0-9]+(?:\.[0-9]+)?)\s*[^0-9$]+\s*\$?([0-9]+(?:\.[0-9]+)?)/i);
  if (!headerMatch || !currentProfitMatch || !priceMatch) {
    throw new Error("Message does not match profit signal template");
  }
  return {
    type: "PROFIT",
    symbol: normalizeSymbol(headerMatch[1]),
    side: parseSide(headerMatch[2]),
    currentProfitPct: Number.parseFloat(currentProfitMatch[1]),
    leveragedProfitPct: leveragedProfitMatch ? Number.parseFloat(leveragedProfitMatch[1]) : null,
    priceFrom: parsePrice(priceMatch[1]),
    priceTo: parsePrice(priceMatch[2]),
    signalId: signalIdMatch?.[1],
    messageId,
    messageDate,
    rawText: text
  };
}
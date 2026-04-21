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

function requireFinitePositiveNumber(attribute: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Signal ${attribute} is invalid`);
  }
  return value;
}

function toSearchableText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "");
}

function parseRequiredLineValue(searchable: string, expression: RegExp, attribute: string): string {
  const match = searchable.match(expression);
  const value = match?.[1]?.trim();
  if (!value) {
    throw new Error(`Signal ${attribute} is missing`);
  }
  return value;
}

function validateEntrySignalAttributes(signal: ParsedEntrySignal): ParsedEntrySignal {
  if (!signal.symbol) {
    throw new Error("Signal symbol is missing");
  }
  if (!signal.statusText) {
    throw new Error("Signal status text is missing");
  }
  signal.entry = requireFinitePositiveNumber("entry", signal.entry);
  signal.takeProfit = requireFinitePositiveNumber("take profit", signal.takeProfit);
  signal.stopLoss = requireFinitePositiveNumber("stop loss", signal.stopLoss);
  signal.leverage = requireFinitePositiveNumber("leverage", signal.leverage);

  if (signal.signalId && !signal.signalId.toUpperCase().startsWith(signal.symbol)) {
    throw new Error(`Signal id ${signal.signalId} does not match symbol ${signal.symbol}`);
  }

  if (signal.entry === signal.takeProfit || signal.entry === signal.stopLoss || signal.takeProfit === signal.stopLoss) {
    throw new Error("Signal entry, TP, and SL must resolve to distinct values");
  }

  return signal;
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
  const symbol = normalizeSymbol(parseRequiredLineValue(searchable, /(?:^|\n)[^\n]*Ativo:\s*([A-Z0-9]+)/i, "symbol"));
  const side = parseSide(parseRequiredLineValue(searchable, /(?:^|\n)[^\n]*Direcao:\s*([^\n]+)/i, "direction"));
  const entry = requireFinitePositiveNumber(
    "entry",
    parseRoundedPrice(parseRequiredLineValue(searchable, /(?:^|\n)[^\n]*Entrada:\s*\$?\s*([0-9][0-9.,]*)/i, "entry"))
  );
  const takeProfit = requireFinitePositiveNumber(
    "take profit",
    parseRoundedPrice(parseRequiredLineValue(searchable, /(?:^|\n)[^\n]*TP:\s*\$?\s*([0-9][0-9.,]*)/i, "take profit"))
  );
  const stopLoss = requireFinitePositiveNumber(
    "stop loss",
    parseRoundedPrice(parseRequiredLineValue(searchable, /(?:^|\n)[^\n]*SL:\s*\$?\s*([0-9][0-9.,]*)/i, "stop loss"))
  );
  const leverage = normalizeLeverage(
    requireFinitePositiveNumber(
      "leverage",
      parseCompactDecimal(
        parseRequiredLineValue(
          searchable,
          /(?:^|\n)[^\n]*Alavancagem\s+max(?:ima)?\.?:\s*([0-9]+(?:[.,][0-9]+)?)x\b/i,
          "leverage"
        )
      )
    )
  );
  const statusText = parseRequiredLineValue(searchable, /(?:^|\n)[^\n]*Status:\s*([^\n]+)/i, "status");

  return validateEntrySignalAttributes({
    type: "ENTRY",
    symbol,
    side,
    entry,
    takeProfit,
    stopLoss,
    leverage,
    statusText,
    signalId: signalIdMatch?.[1],
    messageId,
    messageDate,
    rawText: text
  });
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

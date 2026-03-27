import test from "node:test";
import assert from "node:assert/strict";

import { parseSignal } from "../src/signals/parser.js";

const entryMessage = `LIVE

NOVO SINAL | #SOL26032601V13

Ativo: SOL
Direção: LONG
Entrada: $86.62

TP: $90.86 (4.90%)
SL: $84.50 (2.45%)
R:R = 1:2.0
Alavancagem máx: 16.3x

Status: Aguardando confirmação`;

const profitMessage = `LIVE

LUCRO | #BNB26032601V13

BNB LONG
Lucro atual: +1.0% (ou +18% com alav.)
Preço: $625.25 -> $631.56`;

test("parse entry messages", () => {
  const parsed = parseSignal(entryMessage, "1", "2026-03-26T12:00:00.000Z");
  assert.ok(parsed);
  assert.equal(parsed.type, "ENTRY");
  if (parsed.type === "ENTRY") {
    assert.equal(parsed.symbol, "SOL");
    assert.equal(parsed.side, "LONG");
    assert.equal(parsed.entry, 86.62);
    assert.equal(parsed.takeProfit, 90.86);
    assert.equal(parsed.stopLoss, 84.5);
    assert.equal(parsed.leverage, 16.3);
  }
});

test("parse profit messages", () => {
  const parsed = parseSignal(profitMessage, "2", "2026-03-26T12:00:00.000Z");
  assert.ok(parsed);
  assert.equal(parsed.type, "PROFIT");
  if (parsed.type === "PROFIT") {
    assert.equal(parsed.symbol, "BNB");
    assert.equal(parsed.side, "LONG");
    assert.equal(parsed.currentProfitPct, 1);
    assert.equal(parsed.leveragedProfitPct, 18);
    assert.equal(parsed.priceFrom, 625.25);
    assert.equal(parsed.priceTo, 631.56);
  }
});

test("ignore unrelated messages", () => {
  assert.equal(parseSignal("hello", "3", "2026-03-26T12:00:00.000Z"), null);
});
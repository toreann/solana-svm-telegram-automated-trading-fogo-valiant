import test from "node:test";
import assert from "node:assert/strict";

import { parseSignal } from "../src/signals/parser.js";

const entryMessage = `⚡️ LIVE

🚨 NOVO SINAL | #BTC26032601V13

Ativo: BTC
Direção: 🟢 LONG
Entrada: $68,497.25

🎯 TP: $71,059.05 (3.74%)
🛑 SL: $67,216.35 (1.87%)
📊 R:R = 1:2.0
⚡️ Alavancagem máx: 20.0x

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
    assert.equal(parsed.symbol, "BTC");
    assert.equal(parsed.side, "LONG");
    assert.equal(parsed.entry, 68497);
    assert.equal(parsed.takeProfit, 71059);
    assert.equal(parsed.stopLoss, 67216);
    assert.equal(parsed.leverage, 20);
  }
});

test("round entry prices to the nearest whole number", () => {
  const parsed = parseSignal(
    `⚡️ LIVE

🚨 NOVO SINAL | #ETH26032601V13

Ativo: ETH
Direção: 🟢 LONG
Entrada: $1,999.56

🎯 TP: $2,200.32 (10.04%)
🛑 SL: $1,899.18 (5.02%)
📊 R:R = 1:2.0
⚡️ Alavancagem máx: 10.0x

Status: Aguardando confirmação`,
    "rounded-entry",
    "2026-03-26T12:00:00.000Z"
  );
  assert.ok(parsed);
  assert.equal(parsed?.type, "ENTRY");
  if (parsed?.type === "ENTRY") {
    assert.equal(parsed.entry, 2000);
    assert.equal(parsed.takeProfit, 2200);
    assert.equal(parsed.stopLoss, 1899);
  }
});

test("round entry prices that use comma decimals", () => {
  const parsed = parseSignal(
    `⚡️ LIVE

🚨 NOVO SINAL | #ETH26032601V13

Ativo: ETH
Direção: 🟢 LONG
Entrada: $1.999,56

🎯 TP: $2.200,32 (10,04%)
🛑 SL: $1.899,18 (5,02%)
📊 R:R = 1:2.0
⚡️ Alavancagem máx: 10,0x

Status: Aguardando confirmação`,
    "rounded-entry-comma",
    "2026-03-26T12:00:00.000Z"
  );
  assert.ok(parsed);
  assert.equal(parsed?.type, "ENTRY");
  if (parsed?.type === "ENTRY") {
    assert.equal(parsed.entry, 2000);
    assert.equal(parsed.takeProfit, 2200);
    assert.equal(parsed.stopLoss, 1899);
    assert.equal(parsed.leverage, 10);
  }
});

test("round fractional leverage in entry messages", () => {
  const parsed = parseSignal(
    entryMessage.replace("20.0x", "16.3x").replace("BTC", "SOL"),
    "fractional",
    "2026-03-26T12:00:00.000Z"
  );
  assert.ok(parsed);
  assert.equal(parsed?.type, "ENTRY");
  if (parsed?.type === "ENTRY") {
    assert.equal(parsed.leverage, 16);
  }
});

test("round fractional leverage written with a comma", () => {
  const parsed = parseSignal(
    entryMessage.replace("20.0x", "16,3x").replace("BTC", "SOL"),
    "fractional-comma",
    "2026-03-26T12:00:00.000Z"
  );
  assert.ok(parsed);
  assert.equal(parsed?.type, "ENTRY");
  if (parsed?.type === "ENTRY") {
    assert.equal(parsed.leverage, 16);
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

test("parse profit messages with comma decimals", () => {
  const parsed = parseSignal(
    profitMessage.replace("+1.0%", "+1,0%").replace("+18%", "+18,5%"),
    "profit-comma",
    "2026-03-26T12:00:00.000Z"
  );
  assert.ok(parsed);
  assert.equal(parsed?.type, "PROFIT");
  if (parsed?.type === "PROFIT") {
    assert.equal(parsed.currentProfitPct, 1);
    assert.equal(parsed.leveragedProfitPct, 18.5);
  }
});

test("ignore unrelated messages", () => {
  assert.equal(parseSignal("hello", "3", "2026-03-26T12:00:00.000Z"), null);
});

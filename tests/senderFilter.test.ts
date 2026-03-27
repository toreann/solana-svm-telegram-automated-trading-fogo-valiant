import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { AppDatabase } from "../src/db.js";
import { SenderFilter } from "../src/signals/senderFilter.js";

const dbPath = "./data/test-sender-filter.db";

function cleanup(): void {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    // no-op
  }
}

test("accept configured usernames and persist sender ID", async () => {
  cleanup();
  const db = await AppDatabase.open(dbPath, {
    marginPerTrade: 25,
    maxLeverageCap: 20,
    profitPartialClosePercent: 25,
    paused: false,
    dryRun: true
  });

  const filter = new SenderFilter(db, [], ["@MacacoClub_bot", "Mr. Robot"]);
  const allowed = filter.isAllowed({
    telegramUserId: "100",
    username: "MacacoClub_bot",
    displayName: "Macaco Club"
  });

  assert.equal(allowed, true);
  assert.equal(db.getAllowedSenders().length, 1);
  db.close();
  cleanup();
});

test("reject non-allowed senders", async () => {
  cleanup();
  const db = await AppDatabase.open(dbPath, {
    marginPerTrade: 25,
    maxLeverageCap: 20,
    profitPartialClosePercent: 25,
    paused: false,
    dryRun: true
  });

  const filter = new SenderFilter(db, [], ["@MacacoClub_bot"]);
  const allowed = filter.isAllowed({
    telegramUserId: "200",
    username: "other_bot",
    displayName: "Other Bot"
  });

  assert.equal(allowed, false);
  db.close();
  cleanup();
});
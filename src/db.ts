import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import initSqlJs from "sql.js";

import type {
  NotificationEvent,
  ParsedSignal,
  PositionSnapshot,
  PositionState,
  RuntimeConfig,
  SenderIdentity
} from "./types.js";
import { ensureParentDir, nowIso } from "./utils.js";

const require = createRequire(import.meta.url);

type SenderRow = Omit<SenderIdentity, "isAllowed"> & { isAllowed: number };
type PositionRow = Omit<PositionState, "profitActionApplied"> & { profitActionApplied: number };

type SqlResult = { columns: string[]; values: unknown[][] };

function toRows<T>(results: SqlResult[]): T[] {
  if (results.length === 0) {
    return [];
  }
  const [{ columns, values }] = results;
  return values.map((valueRow: unknown[]) =>
    Object.fromEntries(columns.map((column: string, index: number) => [column, valueRow[index]])) as T
  );
}

export class AppDatabase {
  private constructor(private readonly path: string, private readonly db: any) {}

  public static async open(path: string, defaultRuntimeConfig: RuntimeConfig): Promise<AppDatabase> {
    ensureParentDir(path);
    const SQL = await AppDatabase.loadSqlJs();
    const buffer = existsSync(path) ? readFileSync(path) : undefined;
    const db = buffer ? new SQL.Database(buffer) : new SQL.Database();
    const instance = new AppDatabase(path, db);
    instance.migrate();
    instance.seedRuntimeConfig(defaultRuntimeConfig);
    instance.persist();
    return instance;
  }

  private static async loadSqlJs(): Promise<any> {
    const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
    return initSqlJs({
      locateFile: () => pathToFileURL(wasmPath).href
    });
  }

  private run(sql: string, params?: Record<string, unknown>): void {
    this.db.run(sql, params);
    this.persist();
  }

  private all<T>(sql: string, params?: Record<string, unknown>): T[] {
    return toRows<T>(this.db.exec(sql, params) as SqlResult[]);
  }

  private get<T>(sql: string, params?: Record<string, unknown>): T | undefined {
    return this.all<T>(sql, params)[0];
  }

  private persist(): void {
    const data = this.db.export() as Uint8Array;
    writeFileSync(this.path, Buffer.from(data));
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        signal_type TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        raw_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(message_id, chat_id)
      );

      CREATE TABLE IF NOT EXISTS sender_identities (
        telegram_user_id TEXT PRIMARY KEY,
        username TEXT,
        display_name TEXT,
        is_allowed INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        status TEXT NOT NULL,
        entry_price REAL NOT NULL,
        current_size REAL NOT NULL,
        initial_size REAL NOT NULL,
        take_profit REAL NOT NULL,
        stop_loss REAL NOT NULL,
        leverage REAL NOT NULL,
        margin REAL NOT NULL,
        source_message_id TEXT NOT NULL,
        source_chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        signal_id TEXT,
        remote_order_id TEXT,
        remote_position_id TEXT,
        profit_action_applied INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notifications (
        dedupe_key TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS control_actions (
        id TEXT PRIMARY KEY,
        action_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  private seedRuntimeConfig(defaultRuntimeConfig: RuntimeConfig): void {
    const existingKeys = new Set(this.all<{ key: string }>("SELECT key FROM runtime_config").map((row) => String(row.key)));
    const now = nowIso();
    const entries: Record<string, string> = {
      marginPerTrade: String(defaultRuntimeConfig.marginPerTrade),
      maxLeverageCap: String(defaultRuntimeConfig.maxLeverageCap),
      profitPartialClosePercent: String(defaultRuntimeConfig.profitPartialClosePercent),
      paused: String(defaultRuntimeConfig.paused),
      dryRun: String(defaultRuntimeConfig.dryRun)
    };

    for (const [key, value] of Object.entries(entries)) {
      if (!existingKeys.has(key)) {
        this.run(
          "INSERT INTO runtime_config (key, value, updated_at) VALUES ($key, $value, $updatedAt)",
          { $key: key, $value: value, $updatedAt: now }
        );
      }
    }
  }

  public close(): void {
    this.persist();
    this.db.close();
  }

  public hasProcessedMessage(messageId: string, chatId: string): boolean {
    const row = this.get<{ found: number }>(
      "SELECT 1 as found FROM processed_messages WHERE message_id = $messageId AND chat_id = $chatId",
      { $messageId: messageId, $chatId: chatId }
    );
    return Boolean(row);
  }

  public markMessageProcessed(signal: ParsedSignal, chatId: string, senderId: string): void {
    this.run(
      `INSERT OR IGNORE INTO processed_messages
       (message_id, chat_id, signal_type, sender_id, raw_text, created_at)
       VALUES ($messageId, $chatId, $signalType, $senderId, $rawText, $createdAt)`,
      {
        $messageId: signal.messageId,
        $chatId: chatId,
        $signalType: signal.type,
        $senderId: senderId,
        $rawText: signal.rawText,
        $createdAt: nowIso()
      }
    );
  }

  public upsertSenderIdentity(sender: SenderIdentity): void {
    const now = nowIso();
    this.run(
      `INSERT INTO sender_identities
       (telegram_user_id, username, display_name, is_allowed, created_at, updated_at)
       VALUES ($telegramUserId, $username, $displayName, $isAllowed, $createdAt, $updatedAt)
       ON CONFLICT(telegram_user_id) DO UPDATE SET
         username = excluded.username,
         display_name = excluded.display_name,
         is_allowed = excluded.is_allowed,
         updated_at = excluded.updated_at`,
      {
        $telegramUserId: sender.telegramUserId,
        $username: sender.username ?? null,
        $displayName: sender.displayName ?? null,
        $isAllowed: sender.isAllowed ? 1 : 0,
        $createdAt: now,
        $updatedAt: now
      }
    );
  }

  public getAllowedSenders(): SenderIdentity[] {
    return this.all<SenderRow>(
      `SELECT telegram_user_id as telegramUserId,
              username,
              display_name as displayName,
              is_allowed as isAllowed
       FROM sender_identities
       WHERE is_allowed = 1`
    ).map((row) => ({
      telegramUserId: row.telegramUserId,
      username: row.username,
      displayName: row.displayName,
      isAllowed: Boolean(row.isAllowed)
    }));
  }

  public getRuntimeConfig(): RuntimeConfig {
    const rows = this.all<{ key: string; value: string }>("SELECT key, value FROM runtime_config");
    const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return {
      marginPerTrade: Number(values.marginPerTrade),
      maxLeverageCap: Number(values.maxLeverageCap),
      profitPartialClosePercent: Number(values.profitPartialClosePercent),
      paused: values.paused === "true",
      dryRun: values.dryRun === "true"
    };
  }

  public updateRuntimeConfig(patch: Partial<RuntimeConfig>): RuntimeConfig {
    const next = { ...this.getRuntimeConfig(), ...patch };
    const updatedAt = nowIso();
    for (const [key, value] of Object.entries(next)) {
      this.run(
        `INSERT INTO runtime_config (key, value, updated_at)
         VALUES ($key, $value, $updatedAt)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        { $key: key, $value: String(value), $updatedAt: updatedAt }
      );
    }
    return next;
  }

  public upsertPosition(position: PositionState): void {
    this.run(
      `INSERT INTO positions (
        id, symbol, side, status, entry_price, current_size, initial_size,
        take_profit, stop_loss, leverage, margin, source_message_id, source_chat_id, sender_id,
        signal_id, remote_order_id, remote_position_id, profit_action_applied, last_error,
        created_at, updated_at
      ) VALUES (
        $id, $symbol, $side, $status, $entryPrice, $currentSize, $initialSize,
        $takeProfit, $stopLoss, $leverage, $margin, $sourceMessageId, $sourceChatId, $senderId,
        $signalId, $remoteOrderId, $remotePositionId, $profitActionApplied, $lastError,
        $createdAt, $updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        symbol = excluded.symbol,
        side = excluded.side,
        status = excluded.status,
        entry_price = excluded.entry_price,
        current_size = excluded.current_size,
        initial_size = excluded.initial_size,
        take_profit = excluded.take_profit,
        stop_loss = excluded.stop_loss,
        leverage = excluded.leverage,
        margin = excluded.margin,
        remote_order_id = excluded.remote_order_id,
        remote_position_id = excluded.remote_position_id,
        profit_action_applied = excluded.profit_action_applied,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at`,
      {
        $id: position.id,
        $symbol: position.symbol,
        $side: position.side,
        $status: position.status,
        $entryPrice: position.entryPrice,
        $currentSize: position.currentSize,
        $initialSize: position.initialSize,
        $takeProfit: position.takeProfit,
        $stopLoss: position.stopLoss,
        $leverage: position.leverage,
        $margin: position.margin,
        $sourceMessageId: position.sourceMessageId,
        $sourceChatId: position.sourceChatId,
        $senderId: position.senderId,
        $signalId: position.signalId ?? null,
        $remoteOrderId: position.remoteOrderId ?? null,
        $remotePositionId: position.remotePositionId ?? null,
        $profitActionApplied: position.profitActionApplied ? 1 : 0,
        $lastError: position.lastError ?? null,
        $createdAt: position.createdAt,
        $updatedAt: position.updatedAt
      }
    );
  }

  private mapPositions(sql: string, params?: Record<string, unknown>): PositionState[] {
    return this.all<PositionRow>(sql, params).map((row) => ({
      id: row.id,
      symbol: row.symbol,
      side: row.side,
      status: row.status,
      entryPrice: row.entryPrice,
      currentSize: row.currentSize,
      initialSize: row.initialSize,
      takeProfit: row.takeProfit,
      stopLoss: row.stopLoss,
      leverage: row.leverage,
      margin: row.margin,
      sourceMessageId: row.sourceMessageId,
      sourceChatId: row.sourceChatId,
      senderId: row.senderId,
      signalId: row.signalId,
      remoteOrderId: row.remoteOrderId,
      remotePositionId: row.remotePositionId,
      profitActionApplied: Boolean(row.profitActionApplied),
      lastError: row.lastError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }));
  }

  public listActivePositions(): PositionState[] {
    return this.mapPositions(
      `SELECT
        id,
        symbol,
        side,
        status,
        entry_price as entryPrice,
        current_size as currentSize,
        initial_size as initialSize,
        take_profit as takeProfit,
        stop_loss as stopLoss,
        leverage,
        margin,
        source_message_id as sourceMessageId,
        source_chat_id as sourceChatId,
        sender_id as senderId,
        signal_id as signalId,
        remote_order_id as remoteOrderId,
        remote_position_id as remotePositionId,
        profit_action_applied as profitActionApplied,
        last_error as lastError,
        created_at as createdAt,
        updated_at as updatedAt
      FROM positions
      WHERE status IN ('PENDING', 'OPEN')
      ORDER BY created_at DESC`
    );
  }

  public listAllPositions(): PositionState[] {
    return this.mapPositions(
      `SELECT
        id,
        symbol,
        side,
        status,
        entry_price as entryPrice,
        current_size as currentSize,
        initial_size as initialSize,
        take_profit as takeProfit,
        stop_loss as stopLoss,
        leverage,
        margin,
        source_message_id as sourceMessageId,
        source_chat_id as sourceChatId,
        sender_id as senderId,
        signal_id as signalId,
        remote_order_id as remoteOrderId,
        remote_position_id as remotePositionId,
        profit_action_applied as profitActionApplied,
        last_error as lastError,
        created_at as createdAt,
        updated_at as updatedAt
      FROM positions
      ORDER BY created_at DESC`
    );
  }

  public findActivePositionBySymbol(symbol: string): PositionState | undefined {
    return this.mapPositions(
      `SELECT
        id,
        symbol,
        side,
        status,
        entry_price as entryPrice,
        current_size as currentSize,
        initial_size as initialSize,
        take_profit as takeProfit,
        stop_loss as stopLoss,
        leverage,
        margin,
        source_message_id as sourceMessageId,
        source_chat_id as sourceChatId,
        sender_id as senderId,
        signal_id as signalId,
        remote_order_id as remoteOrderId,
        remote_position_id as remotePositionId,
        profit_action_applied as profitActionApplied,
        last_error as lastError,
        created_at as createdAt,
        updated_at as updatedAt
      FROM positions
      WHERE symbol = $symbol AND status IN ('PENDING', 'OPEN')
      ORDER BY created_at DESC
      LIMIT 1`,
      { $symbol: symbol }
    )[0];
  }

  public findOpenPosition(symbol: string, side: string): PositionState | undefined {
    return this.mapPositions(
      `SELECT
        id,
        symbol,
        side,
        status,
        entry_price as entryPrice,
        current_size as currentSize,
        initial_size as initialSize,
        take_profit as takeProfit,
        stop_loss as stopLoss,
        leverage,
        margin,
        source_message_id as sourceMessageId,
        source_chat_id as sourceChatId,
        sender_id as senderId,
        signal_id as signalId,
        remote_order_id as remoteOrderId,
        remote_position_id as remotePositionId,
        profit_action_applied as profitActionApplied,
        last_error as lastError,
        created_at as createdAt,
        updated_at as updatedAt
      FROM positions
      WHERE symbol = $symbol AND side = $side AND status = 'OPEN'
      ORDER BY created_at DESC
      LIMIT 1`,
      { $symbol: symbol, $side: side }
    )[0];
  }

  public getPositionById(id: string): PositionState | undefined {
    return this.mapPositions(
      `SELECT
        id,
        symbol,
        side,
        status,
        entry_price as entryPrice,
        current_size as currentSize,
        initial_size as initialSize,
        take_profit as takeProfit,
        stop_loss as stopLoss,
        leverage,
        margin,
        source_message_id as sourceMessageId,
        source_chat_id as sourceChatId,
        sender_id as senderId,
        signal_id as signalId,
        remote_order_id as remoteOrderId,
        remote_position_id as remotePositionId,
        profit_action_applied as profitActionApplied,
        last_error as lastError,
        created_at as createdAt,
        updated_at as updatedAt
      FROM positions
      WHERE id = $id`,
      { $id: id }
    )[0];
  }

  public recordNotification(event: NotificationEvent): boolean {
    const exists = this.get<{ dedupeKey: string }>(
      "SELECT dedupe_key as dedupeKey FROM notifications WHERE dedupe_key = $dedupeKey",
      { $dedupeKey: event.dedupeKey }
    );
    if (exists) {
      return false;
    }
    this.run(
      `INSERT INTO notifications (dedupe_key, type, title, body, created_at)
       VALUES ($dedupeKey, $type, $title, $body, $createdAt)`,
      {
        $dedupeKey: event.dedupeKey,
        $type: event.type,
        $title: event.title,
        $body: event.body,
        $createdAt: nowIso()
      }
    );
    return true;
  }

  public appendControlAction(id: string, actionType: string, payload: string, status: string): void {
    this.run(
      `INSERT INTO control_actions (id, action_type, payload, status, created_at)
       VALUES ($id, $actionType, $payload, $status, $createdAt)`,
      {
        $id: id,
        $actionType: actionType,
        $payload: payload,
        $status: status,
        $createdAt: nowIso()
      }
    );
  }

  public listSnapshotsFromPositions(): PositionSnapshot[] {
    return this.listActivePositions().map((position) => ({
      symbol: position.symbol,
      side: position.side,
      size: position.currentSize,
      entryPrice: position.entryPrice,
      status: position.status,
      remotePositionId: position.remotePositionId
    }));
  }
}

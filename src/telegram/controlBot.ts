import { spawn } from "node:child_process";

import type { Logger } from "pino";
import { Markup, Telegraf, type Context, type NarrowedContext } from "telegraf";
import type { CallbackQuery, Update } from "telegraf/types";

import type { AppDatabase } from "../db.js";
import type { TradeOrchestrator } from "../orchestrator.js";
import type { AccountBalance, AgentSessionStatus, PositionState, RetryPositioningPayload, RuntimeConfig } from "../types.js";
import { newId } from "../utils.js";

type PromptKey = "marginPerTrade" | "maxLeverageCap" | "profitPartialClosePercent";
type PromptState = { key: PromptKey };

export interface SelfRestartPlan {
  command: string;
  args: string[];
  cwd: string;
}

const SELF_RESTART_HANDOFF_SCRIPT = `
const [payloadJson, parentPidValue] = process.argv.slice(1);
const payload = JSON.parse(payloadJson);
const parentPid = Number(parentPidValue);
const { spawn } = require("node:child_process");

const relaunch = () => {
  const child = spawn(payload.command, payload.args, {
    cwd: payload.cwd,
    env: { ...process.env },
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  process.exit(0);
};

const waitForParentExit = () => {
  if (!Number.isFinite(parentPid) || parentPid <= 0) {
    relaunch();
    return;
  }

  try {
    process.kill(parentPid, 0);
    setTimeout(waitForParentExit, 250);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      relaunch();
      return;
    }
    setTimeout(waitForParentExit, 250);
  }
};

waitForParentExit();
`.trim();

export function buildSelfRestartPlan(
  execPath = process.execPath,
  argv = process.argv.slice(1),
  cwd = process.cwd()
): SelfRestartPlan {
  return {
    command: execPath,
    args: argv,
    cwd
  };
}

export function buildSelfRestartHandoffArgs(
  plan: SelfRestartPlan,
  parentPid = process.pid
): string[] {
  return ["-e", SELF_RESTART_HANDOFF_SCRIPT, JSON.stringify(plan), String(parentPid)];
}

export function isSystemdSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.INVOCATION_ID || env.JOURNAL_STREAM);
}

function statusLabel(paused: boolean): string {
  return paused ? "PAUSED" : "ACTIVE";
}

function formatCurrency(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

export function formatBalanceLine(balance: AccountBalance | null): string {
  if (!balance) {
    return "Account balance: *unavailable*";
  }

  const accountBalance = balance.perpsBalance ?? balance.accountValue;
  return `Account balance: *$${formatCurrency(accountBalance)} ${balance.currency}*`;
}

function formatMenu(
  runtimeConfig: RuntimeConfig,
  positions: PositionState[],
  executionMode: TradeOrchestrator["getExecutionMode"] extends () => infer T ? T : string,
  accountBalance: AccountBalance | null
): string {
  return [
    "*Trade Bot - Main Menu*",
    "",
    formatBalanceLine(accountBalance),
    `Margin per trade: *$${runtimeConfig.marginPerTrade.toFixed(2)} USDC*`,
    `Leverage cap: *${runtimeConfig.maxLeverageCap}x*`,
    `Partial close: *${runtimeConfig.profitPartialClosePercent}%*`,
    `Status: *${statusLabel(runtimeConfig.paused)}*`,
    `Open/pending positions: *${positions.length}*`,
    `Execution adapter: *${executionMode}*`,
    `Local dry-run flag: *${runtimeConfig.dryRun ? "ON" : "OFF"}*`
  ].join("\n");
}

function mainKeyboard(paused: boolean) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Status", "menu:status"), Markup.button.callback("Positions", "menu:positions")],
    [Markup.button.callback("Configs", "menu:configs"), Markup.button.callback("P&L", "menu:pnl")],
    [Markup.button.callback("Sync Agent", "agent:sync"), Markup.button.callback("Check Agent Approval", "agent:check")],
    [Markup.button.callback("Reset Positions", "positions:reset"), Markup.button.callback("Sync From Exchange", "positions:sync")],
    [Markup.button.callback(paused ? "Resume" : "Pause", "menu:toggle"), Markup.button.callback("Restart Bot", "bot:restart")]
  ]);
}

function configKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Margin per trade", "config:marginPerTrade")],
    [Markup.button.callback("Leverage cap", "config:maxLeverageCap")],
    [Markup.button.callback("Partial close %", "config:profitPartialClosePercent")],
    [Markup.button.callback("Dry-run on/off", "config:dryRun")],
    [Markup.button.callback("Sync Agent", "agent:sync"), Markup.button.callback("Check Agent Approval", "agent:check")],
    [Markup.button.callback("Reset Positions", "positions:reset"), Markup.button.callback("Sync From Exchange", "positions:sync")],
    [Markup.button.callback("Restart Bot", "bot:restart")],
    [Markup.button.callback("Back", "menu:home")]
  ]);
}

function positionsKeyboard(positions: PositionState[]) {
  const rows = positions.flatMap((position) => [
    [
      Markup.button.callback(`Close ${position.symbol}`, `position:close:${position.id}`),
      Markup.button.callback(`Move SL ${position.symbol}`, `position:sl:${position.id}`)
    ],
    [
      Markup.button.callback(`Reapply TP/SL ${position.symbol}`, `position:tpsl:${position.id}`),
      Markup.button.callback(`Reapply Entry ${position.symbol}`, `position:entry:${position.id}`)
    ]
  ]);
  rows.push([Markup.button.callback("Reset Positions", "positions:reset")]);
  rows.push([Markup.button.callback("Sync From Exchange", "positions:sync")]);
  rows.push([Markup.button.callback("Sync Agent", "agent:sync"), Markup.button.callback("Check Agent Approval", "agent:check")]);
  rows.push([Markup.button.callback("Restart Bot", "bot:restart")]);
  rows.push([Markup.button.callback("Back", "menu:home")]);
  return Markup.inlineKeyboard(rows);
}

function formatAgentStatus(status: AgentSessionStatus): string {
  return [
    "*Agent Approval*",
    `Trading state: *${status.tradingState}*`,
    `Approval status: *${status.approvalStatus}*`,
    `Browser wallet: *${status.browserConnectionStatus}*`,
    `Master account: ${status.masterAccountAddress ?? "n/a"}`,
    `Approved exchange agent: ${status.approvedAgentAddress ?? "n/a"}`,
    `Active in-memory agent: ${status.activeAgentAddress ?? "n/a"}`,
    `Env fallback agent: ${status.envFallbackAgentAddress ?? "n/a"}`,
    `Last checked: ${status.lastCheckedAt ?? "n/a"}`,
    `Last synced: ${status.lastSyncAt ?? "n/a"}`,
    `Last error: ${status.lastError ?? "none"}`
  ].join("\n");
}

function isAuthorized(ctx: Context, ownerChatId: string, ownerUserId: string): boolean {
  return String(ctx.chat?.id ?? "") === ownerChatId && String(ctx.from?.id ?? "") === ownerUserId;
}

export class TelegramControlBot {
  public readonly bot: Telegraf;
  private readonly prompts = new Map<string, PromptState>();
  private readonly callbacksInFlight = new Set<string>();
  private cachedAccountBalance: AccountBalance | null = null;
  private balanceRefreshInFlight?: Promise<void>;
  private orchestrator?: TradeOrchestrator;
  private handlersRegistered = false;

  public constructor(
    botToken: string,
    private readonly ownerChatId: string,
    private readonly ownerUserId: string,
    private readonly database: AppDatabase,
    private readonly logger: Logger
  ) {
    this.bot = new Telegraf(botToken);
  }

  public attachOrchestrator(orchestrator: TradeOrchestrator): void {
    this.orchestrator = orchestrator;
    if (!this.handlersRegistered) {
      this.registerHandlers();
      this.handlersRegistered = true;
    }
  }

  private getOrchestrator(): TradeOrchestrator {
    if (!this.orchestrator) {
      throw new Error("Orchestrator is not attached");
    }
    return this.orchestrator;
  }

  private registerHandlers(): void {
    this.bot.use(async (ctx, next) => {
      if (!isAuthorized(ctx, this.ownerChatId, this.ownerUserId)) {
        if (ctx.chat?.id && ctx.from?.id) {
          this.logger.warn({ chatId: ctx.chat.id, userId: ctx.from.id }, "Unauthorized control bot access");
        }
        if ("reply" in ctx) {
          await ctx.reply("Unauthorized.");
        }
        return;
      }
      await next();
    });

    this.bot.start(async (ctx) => {
      await ctx.reply("Control menu ready. Use the buttons below to configure the bot or reset local positions.");
      await this.renderMenu(ctx);
    });

    this.bot.command("menu", async (ctx) => {
      await this.renderMenu(ctx);
    });

    this.bot.command("resetpositions", async (ctx) => {
      await this.resetPositionsAndConfirm(ctx);
    });

    this.bot.command("syncpositions", async (ctx) => {
      await this.dispatchSlowCommand(ctx, "positions:sync", () => this.syncPositionsAndConfirm(ctx));
    });

    this.bot.command("restartbot", async (ctx) => {
      await this.dispatchSlowCommand(ctx, "bot:restart", async () => {
        await ctx.reply(await this.requestSelfRestart("command"));
      });
    });

    this.bot.command("syncagent", async (ctx) => {
      await this.dispatchSlowCommand(ctx, "agent:sync", () => this.syncAgentAndConfirm(ctx));
    });

    this.bot.command("checkagent", async (ctx) => {
      await this.dispatchSlowCommand(ctx, "agent:check", () => this.checkAgentAndConfirm(ctx));
    });

    this.bot.on("text", async (ctx, next) => {
      const prompt = this.prompts.get(String(ctx.chat?.id ?? this.ownerChatId));
      if (!prompt) {
        await next();
        return;
      }

      const rawValue = ctx.message.text.trim();
      try {
        const orchestrator = this.getOrchestrator();
        if (prompt.key === "marginPerTrade") {
          orchestrator.updateRuntimeConfig({ marginPerTrade: this.parsePositive(rawValue) });
        } else if (prompt.key === "maxLeverageCap") {
          orchestrator.updateRuntimeConfig({ maxLeverageCap: this.parsePositive(rawValue) });
        } else if (prompt.key === "profitPartialClosePercent") {
          const percent = this.parsePositive(rawValue);
          if (percent > 100) {
            throw new Error("Partial close must be <= 100");
          }
          orchestrator.updateRuntimeConfig({ profitPartialClosePercent: percent });
        }

        this.prompts.delete(String(ctx.chat?.id ?? this.ownerChatId));
        this.database.appendControlAction(newId(), "config_update", JSON.stringify(prompt), "success");
        await ctx.reply("Config updated.");
        await this.renderMenu(ctx);
      } catch (error) {
        await ctx.reply(`Invalid value. ${String(error)}`);
      }
    });

    this.bot.on("callback_query", async (ctx) => {
      const callback = (ctx.callbackQuery as CallbackQuery.DataQuery).data;
      const callbackContext = ctx as NarrowedContext<Context<Update>, Update.CallbackQueryUpdate<CallbackQuery.DataQuery>>;
      await this.dispatchCallback(callbackContext, callback);
    });
  }

  private async dispatchCallback(
    ctx: NarrowedContext<Context<Update>, Update.CallbackQueryUpdate<CallbackQuery.DataQuery>>,
    callback: string
  ): Promise<void> {
    await ctx.answerCbQuery("Working…").catch((error) => {
      this.logger.debug({ error, callback }, "Could not acknowledge Telegram callback query");
    });

    const inFlightKey = this.inFlightKey(callback);
    if (!inFlightKey) {
      await this.executeCallback(ctx, callback);
      return;
    }
    if (this.callbacksInFlight.has(inFlightKey)) {
      await ctx.reply("That action is already in progress.");
      return;
    }

    this.callbacksInFlight.add(inFlightKey);
    await ctx.reply("Working… I will send the result when it is ready.");
    void this.executeCallback(ctx, callback).finally(() => {
      this.callbacksInFlight.delete(inFlightKey);
    });
  }

  private async dispatchSlowCommand(ctx: Context, inFlightKey: string, work: () => Promise<void>): Promise<void> {
    if (this.callbacksInFlight.has(inFlightKey)) {
      await ctx.reply("That action is already in progress.");
      return;
    }

    this.callbacksInFlight.add(inFlightKey);
    await ctx.reply("Working… I will send the result when it is ready.");
    void work().catch(async (error) => {
      this.logger.error({ error, inFlightKey }, "Telegram command action failed");
      await ctx.reply(`Action failed.\n\n${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
    }).finally(() => {
      this.callbacksInFlight.delete(inFlightKey);
    });
  }

  private inFlightKey(callback: string): string | undefined {
    if (
      callback === "menu:pnl"
      || callback === "positions:sync"
      || callback === "agent:sync"
      || callback === "agent:check"
      || callback === "bot:restart"
      || callback.startsWith("retry:positioning:")
      || callback.startsWith("position:")
    ) {
      return callback;
    }
    return undefined;
  }

  private async executeCallback(
    ctx: NarrowedContext<Context<Update>, Update.CallbackQueryUpdate<CallbackQuery.DataQuery>>,
    callback: string
  ): Promise<void> {
    try {
      await this.handleCallback(ctx, callback);
    } catch (error) {
      this.logger.error({ error, callback }, "Telegram callback action failed");
      await ctx.reply(`Action failed.\n\n${error instanceof Error ? error.message : String(error)}`).catch((replyError) => {
        this.logger.error({ error: replyError, callback }, "Could not deliver Telegram callback failure");
      });
    }
  }

  private parsePositive(value: string): number {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error("Expected a positive number");
    }
    return parsed;
  }

  private async renderMenu(ctx: Context): Promise<void> {
    const orchestrator = this.getOrchestrator();
    const runtimeConfig = orchestrator.getRuntimeConfig();
    const positions = orchestrator.listPositions();
    await ctx.reply(formatMenu(runtimeConfig, positions, orchestrator.getExecutionMode(), this.cachedAccountBalance), {
      parse_mode: "Markdown",
      ...mainKeyboard(runtimeConfig.paused)
    });
    this.refreshAccountBalance(ctx);
  }

  private refreshAccountBalance(ctx: Context): void {
    if (this.balanceRefreshInFlight) {
      return;
    }

    const hadCachedBalance = Boolean(this.cachedAccountBalance);
    const refresh = this.getOrchestrator().getAccountBalance().then(async (balance) => {
      this.cachedAccountBalance = balance;
      if (!hadCachedBalance && balance) {
        await ctx.reply(formatBalanceLine(balance), { parse_mode: "Markdown" });
      }
    }).catch((error) => {
      this.logger.warn({ error }, "Could not fetch account balance for status menu");
    }).finally(() => {
      if (this.balanceRefreshInFlight === refresh) {
        this.balanceRefreshInFlight = undefined;
      }
    });
    this.balanceRefreshInFlight = refresh;
  }

  private async handleCallback(
    ctx: NarrowedContext<Context<Update>, Update.CallbackQueryUpdate<CallbackQuery.DataQuery>>,
    callback: string
  ): Promise<void> {
    const orchestrator = this.getOrchestrator();

    if (callback === "menu:home" || callback === "menu:status") {
      await this.renderMenu(ctx);
      return;
    }

    if (callback === "menu:positions") {
      const positions = orchestrator.listPositions();
      const text =
        positions.length === 0
          ? "No active positions."
          : positions
              .map(
                (position) =>
                  `*${position.symbol}* ${position.side}\nStatus: ${position.status}\nEntry: ${position.entryPrice}\nSize: ${position.currentSize}\nTP: ${position.takeProfit}\nSL: ${position.stopLoss}`
              )
              .join("\n\n");
      await ctx.reply(text, {
        parse_mode: "Markdown",
        ...positionsKeyboard(positions)
      });
      return;
    }

    if (callback === "menu:configs") {
      const runtimeConfig = orchestrator.getRuntimeConfig();
      await ctx.reply(
        [
          "*Configs*",
          `Execution adapter: ${orchestrator.getExecutionMode()} (restart required to change)`,
          `Margin per trade: ${runtimeConfig.marginPerTrade}`,
          `Leverage cap: ${runtimeConfig.maxLeverageCap}`,
          `Partial close %: ${runtimeConfig.profitPartialClosePercent}`,
          `Local dry-run flag: ${runtimeConfig.dryRun}`
        ].join("\n"),
        {
          parse_mode: "Markdown",
          ...configKeyboard()
        }
      );
      return;
    }

    if (callback === "menu:pnl") {
      const pnl = await orchestrator.getPnlSummary();
      await ctx.reply(
        [
          "*P&L*",
          `Realized: ${pnl.realizedPnl.toFixed(2)}`,
          `Unrealized: ${pnl.unrealizedPnl.toFixed(2)}`,
          `Open positions: ${pnl.openPositions}`,
          `Closed positions: ${pnl.closedPositions}`
        ].join("\n"),
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (callback === "menu:toggle") {
      const current = orchestrator.getRuntimeConfig();
      const next = orchestrator.updateRuntimeConfig({ paused: !current.paused });
      await ctx.reply(`Bot is now ${next.paused ? "paused" : "active"}.`);
      await this.renderMenu(ctx);
      return;
    }

    if (callback === "config:dryRun") {
      const current = orchestrator.getRuntimeConfig();
      const next = orchestrator.updateRuntimeConfig({ dryRun: !current.dryRun });
      await ctx.reply(
        `Local dry-run flag is now ${next.dryRun ? "enabled" : "disabled"}. Execution adapter remains ${orchestrator.getExecutionMode()}.`
      );
      await this.renderMenu(ctx);
      return;
    }

    if (callback.startsWith("config:")) {
      const key = callback.replace("config:", "") as PromptKey;
      this.prompts.set(String(ctx.chat?.id ?? this.ownerChatId), { key });
      await ctx.reply(`Send the new value for ${key}.`);
      return;
    }

    if (callback === "positions:reset") {
      await this.resetPositionsAndConfirm(ctx);
      await this.renderMenu(ctx);
      return;
    }

    if (callback === "positions:sync") {
      await this.syncPositionsAndConfirm(ctx);
      await this.renderMenu(ctx);
      return;
    }

    if (callback === "agent:sync") {
      await this.syncAgentAndConfirm(ctx);
      return;
    }

    if (callback === "agent:check") {
      await this.checkAgentAndConfirm(ctx);
      return;
    }

    if (callback === "bot:restart") {
      await ctx.reply(await this.requestSelfRestart("button"));
      return;
    }

    if (callback.startsWith("retry:positioning:")) {
      const actionId = callback.split(":")[2];
      const action = this.database.getControlActionById(actionId);
      if (!action || action.actionType !== "retry_positioning") {
        await ctx.reply("Could not find that retry request.");
        return;
      }

      try {
        const payload = JSON.parse(action.payload) as RetryPositioningPayload;
        const outcome = await orchestrator.retryPositioning(payload.signal, payload.chatId, payload.sender);
        this.database.appendControlAction(
          newId(),
          "retry_positioning_execute",
          JSON.stringify({ actionId, outcome }),
          "success"
        );
        await ctx.reply(
          outcome.status === "accepted"
            ? (outcome.reason
              ? `Retry positioning submitted. Entry was placed, but there was a warning:\n\n${outcome.reason}`
              : "Retry positioning submitted successfully.")
            : outcome.status === "rejected"
              ? `Retry positioning ran, but the entry was rejected again.\n\nReason: ${outcome.reason ?? "unknown"}`
              : `Retry positioning was ignored.\n\nReason: ${outcome.reason ?? "unknown"}`
        );
      } catch (error) {
        this.database.appendControlAction(
          newId(),
          "retry_positioning_execute",
          JSON.stringify({ actionId, error: String(error) }),
          "failed"
        );
        await ctx.reply(`Retry positioning failed.\n\n${String(error)}`);
      }
      return;
    }

    if (callback.startsWith("position:close:")) {
      const positionId = callback.split(":")[2];
      const position = await orchestrator.closePosition(positionId);
      await ctx.reply(position ? "Position close submitted." : "Could not find that position locally.");
      return;
    }

    if (callback.startsWith("position:sl:")) {
      const positionId = callback.split(":")[2];
      const position = await orchestrator.moveStopLossToEntry(positionId);
      await ctx.reply(position ? "Stop loss moved to entry." : "Could not find that position locally.");
      return;
    }

    if (callback.startsWith("position:tpsl:")) {
      const positionId = callback.split(":")[2];
      const position = await orchestrator.reapplyProtectionOrders(positionId);
      await ctx.reply(position ? "TP/SL reapplied for the current position." : "Could not find that position locally.");
      return;
    }

    if (callback.startsWith("position:entry:")) {
      const positionId = callback.split(":")[2];
      const position = await orchestrator.reapplyEntry(positionId);
      if (!position) {
        await ctx.reply("Could not find that position locally.");
        return;
      }
      await ctx.reply(
        position.lastError
          ? `Entry reapplied, but there was a TP/SL warning:\n\n${position.lastError}`
          : "Entry reapplied for the current position."
      );
      return;
    }
  }

  private async requestSelfRestart(source: "button" | "command"): Promise<string> {
    const plan = buildSelfRestartPlan();
    try {
      if (isSystemdSupervised()) {
        this.database.appendControlAction(
          newId(),
          "bot_restart",
          JSON.stringify({ source, supervisor: "systemd", handoff: false }),
          "requested"
        );
        setTimeout(() => {
          process.kill(process.pid, "SIGTERM");
        }, 500);
        return "Restart requested. The systemd service will relaunch the bot after this process shuts down.";
      }

      const handoff = spawn(process.execPath, buildSelfRestartHandoffArgs(plan), {
        cwd: plan.cwd,
        env: { ...process.env },
        detached: true,
        stdio: "ignore"
      });
      handoff.unref();
      this.database.appendControlAction(
        newId(),
        "bot_restart",
        JSON.stringify({ source, pid: handoff.pid ?? null, command: plan.command, args: plan.args, handoff: true }),
        "requested"
      );
      setTimeout(() => {
        process.kill(process.pid, "SIGTERM");
      }, 500);
      return handoff.pid
        ? `Restart requested. Spawned self-restart handoff ${handoff.pid} and shutting this one down.`
        : "Restart requested. Spawned a self-restart handoff and shutting this one down.";
    } catch (error) {
      const reason = String(error);
      this.database.appendControlAction(newId(), "bot_restart", JSON.stringify({ source, error: reason }), "failed");
      this.logger.error({ error, source, plan }, "Failed to self-restart the bot");
      throw new Error(`Could not self-restart the bot.\n\n${reason}`);
    }
  }

  public launch(onError: (error: unknown) => void): void {
    void this.bot.launch().catch(onError);
  }

  public stop(reason = "SIGINT"): void {
    this.bot.stop(reason);
  }

  private async resetPositionsAndConfirm(ctx: Context): Promise<void> {
    const resetCount = this.getOrchestrator().resetLocalPositions();
    this.database.appendControlAction(newId(), "positions_reset", JSON.stringify({ count: resetCount }), "success");
    await ctx.reply(
      resetCount === 0
        ? "No active local positions to reset."
        : `Reset ${resetCount} local position${resetCount === 1 ? "" : "s"}. This only clears local bot state, not live Valiant orders.`
    );
  }

  private async syncPositionsAndConfirm(ctx: Context): Promise<void> {
    try {
      const summary = await this.getOrchestrator().syncPositionsFromExchange();
      this.database.appendControlAction(newId(), "positions_sync", JSON.stringify(summary), "success");
      await ctx.reply(
        [
          "Exchange sync complete.",
          `Updated existing positions: ${summary.synced}`,
          `Imported new positions: ${summary.created}`,
          `Closed stale local positions: ${summary.closed}`
        ].join("\n")
      );
    } catch (error) {
      this.database.appendControlAction(
        newId(),
        "positions_sync",
        JSON.stringify({ error: String(error) }),
        "failed"
      );
      await ctx.reply(`Exchange sync failed.\n\n${String(error)}`);
    }
  }

  private async syncAgentAndConfirm(ctx: Context): Promise<void> {
    try {
      const status = await this.getOrchestrator().syncAgentSession();
      this.database.appendControlAction(newId(), "agent_sync", JSON.stringify(status), "success");
      await ctx.reply(formatAgentStatus(status), { parse_mode: "Markdown" });
    } catch (error) {
      this.database.appendControlAction(newId(), "agent_sync", JSON.stringify({ error: String(error) }), "failed");
      await ctx.reply(`Agent sync failed.\n\n${String(error)}`);
    }
  }

  private async checkAgentAndConfirm(ctx: Context): Promise<void> {
    try {
      const status = await this.getOrchestrator().getAgentSessionStatus();
      this.database.appendControlAction(newId(), "agent_check", JSON.stringify(status), "success");
      await ctx.reply(formatAgentStatus(status), { parse_mode: "Markdown" });
    } catch (error) {
      this.database.appendControlAction(newId(), "agent_check", JSON.stringify({ error: String(error) }), "failed");
      await ctx.reply(`Agent approval check failed.\n\n${String(error)}`);
    }
  }
}

import { readFileSync, writeFileSync } from "node:fs";
import type { Logger } from "pino";
import { TelegramClient } from "telegram/client/TelegramClient.js";
import { NewMessage } from "telegram/events/NewMessage.js";
import { StringSession } from "telegram/sessions/index.js";

import type { TradeOrchestrator } from "../orchestrator.js";
import { parseSignal } from "../signals/parser.js";
import type { SenderFilter } from "../signals/senderFilter.js";
import type { AppConfig, NotificationEvent, SenderIdentity } from "../types.js";
import { ensureParentDir } from "../utils.js";

type TelegramMessageLike = {
  id?: string | number;
  message?: string;
  chatId?: string | number;
  date?: string | number;
  getChat?: () => Promise<unknown>;
  getSender?: () => Promise<unknown>;
};

type TelegramExitNotifier = {
  notify(event: NotificationEvent): Promise<void>;
};

function readSession(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export class TelegramSignalIngestor {
  private readonly client: TelegramClient;
  private readonly discoveredChatIds = new Set<string>();
  private readonly pollSeenMessageKeys = new Set<string>();
  private pollInterval: NodeJS.Timeout | null = null;
  private pollInFlight = false;
  private lastSuccessfulPollAt = Date.now();

  public constructor(
    private readonly config: AppConfig,
    private readonly senderFilter: SenderFilter,
    private readonly orchestrator: TradeOrchestrator,
    private readonly logger: Logger,
    private readonly exitNotifier?: TelegramExitNotifier
  ) {
    const session = new StringSession(readSession(config.telegramSessionFile));
    this.client = new TelegramClient(session, config.telegramApiId, config.telegramApiHash, {
      connectionRetries: 5
    });
  }

  public async connect(): Promise<void> {
    await this.client.start({
      phoneNumber: async () => {
        throw new Error("Interactive Telegram login is not supported in-code. Provide a saved session file.");
      },
      password: async () => {
        throw new Error("Interactive Telegram login is not supported in-code. Provide a saved session file.");
      },
      phoneCode: async () => {
        throw new Error("Interactive Telegram login is not supported in-code. Provide a saved session file.");
      },
      onError: (error) => this.logger.error({ error }, "Telegram client error")
    });

    ensureParentDir(this.config.telegramSessionFile);
    writeFileSync(this.config.telegramSessionFile, String(this.client.session.save()), "utf8");

    this.logger.info(
      {
        signalChatId: this.config.telegramSignalChatId || null,
        allowedSenderIdsConfigured: this.config.telegramAllowedSenderIds.length,
        allowedSenderLabelsConfigured: this.config.telegramAllowedSenderLabels.length
      },
      this.config.telegramSignalChatId
        ? "Telegram client connected and listening for the configured signal chat"
        : "Telegram client connected in discovery mode. Incoming messages will log chatId and sender info"
    );

    this.client.addEventHandler(async (event) => {
      await this.processIncomingMessage(event.message as TelegramMessageLike, "event");
    }, new NewMessage({}));

    this.startPollingCatchup();
  }

  private startPollingCatchup(): void {
    if (!this.config.telegramSignalChatId) {
      return;
    }

    const intervalMs = this.config.telegramPollIntervalSeconds * 1000;
    this.pollInterval = setInterval(() => {
      void this.pollRecentMessages();
    }, intervalMs);
    this.pollInterval.unref();
    void this.pollRecentMessages();

    this.logger.info(
      {
        intervalSeconds: this.config.telegramPollIntervalSeconds,
        limit: this.config.telegramPollLimit,
        maxSignalAgeSeconds: this.config.telegramMaxSignalAgeSeconds,
        staleExitSeconds: this.config.telegramStaleExitSeconds
      },
      "Telegram polling catch-up enabled"
    );
  }

  private async pollRecentMessages(): Promise<void> {
    if (this.pollInFlight) {
      return;
    }

    this.pollInFlight = true;
    try {
      const messages = await this.client.getMessages(this.config.telegramSignalChatId, {
        limit: this.config.telegramPollLimit
      }) as TelegramMessageLike[];
      this.lastSuccessfulPollAt = Date.now();
      const cutoffMs = Date.now() - (this.config.telegramMaxSignalAgeSeconds * 1000);
      const recentMessages = messages
        .filter((message) => this.messageDateMs(message) >= cutoffMs)
        .filter((message) => this.messageLooksLikeSignal(message.message))
        .sort((left, right) => this.messageDateMs(left) - this.messageDateMs(right));

      for (const message of recentMessages) {
        const messageKey = `${this.config.telegramSignalChatId}:${String(message.id ?? "")}`;
        if (this.pollSeenMessageKeys.has(messageKey)) {
          continue;
        }

        try {
          await this.processIncomingMessage(message, "poll", this.config.telegramSignalChatId);
          this.rememberPollSeenMessage(messageKey);
        } catch (error) {
          this.logger.error({ error, messageId: message.id }, "Failed to process polled Telegram message");
        }
      }
    } catch (error) {
      this.logger.error({ error }, "Telegram polling catch-up failed");
      await this.exitIfPollingIsStale(error);
    } finally {
      this.pollInFlight = false;
    }
  }

  private async exitIfPollingIsStale(error: unknown): Promise<void> {
    const staleMs = Date.now() - this.lastSuccessfulPollAt;
    if (staleMs < this.config.telegramStaleExitSeconds * 1000) {
      return;
    }

    this.logger.fatal(
      {
        error,
        staleSeconds: Math.round(staleMs / 1000),
        staleExitSeconds: this.config.telegramStaleExitSeconds
      },
      "Telegram polling has been stale too long; exiting so the service manager can restart the bot"
    );

    await this.exitNotifier?.notify({
      type: "ERROR",
      title: "Trade Bot restarting",
      body: [
        "Telegram polling has been stale too long, so the bot is exiting now.",
        "The user systemd service is configured to restart it automatically.",
        `Signal chat: ${this.config.telegramSignalChatId}`,
        `Stale seconds: ${Math.round(staleMs / 1000)}`,
        `Threshold seconds: ${this.config.telegramStaleExitSeconds}`,
        `Last error: ${error instanceof Error ? error.message : String(error)}`
      ].join("\n"),
      dedupeKey: `telegram-poll-stale:${new Date().toISOString().slice(0, 16)}`
    });
    process.exit(1);
  }

  private async processIncomingMessage(
    message: TelegramMessageLike | undefined,
    source: "event" | "poll",
    chatIdOverride?: string
  ): Promise<void> {
    if (!message?.message) {
      return;
    }

    const chatId = chatIdOverride ?? String(message.chatId ?? "");
    if (!chatId) {
      this.logger.warn({ source, messageId: message.id }, "Skipping message without chat identity");
      return;
    }

    const chat = source === "event" ? await this.safeGetChat(message) : null;
    const chatIdentity = {
      chatId,
      title: this.buildChatTitle(chat),
      username: this.readField(chat, "username")
    };
    const sender = await message.getSender?.();
    const senderIdentity: SenderIdentity = {
      telegramUserId: String((sender as { id?: string | number } | undefined)?.id ?? ""),
      username: this.readField(sender, "username"),
      displayName: this.buildDisplayName(sender),
      isAllowed: false
    };

    if (!this.config.telegramSignalChatId) {
      this.logDiscovery(chatIdentity, senderIdentity);
      return;
    }

    if (chatId !== this.config.telegramSignalChatId) {
      this.logNonSignalChat(chatIdentity);
      return;
    }

    if (!senderIdentity.telegramUserId) {
      this.logger.warn({ source, messageId: message.id }, "Skipping message without sender identity");
      return;
    }

    if (!this.senderFilter.isAllowed(senderIdentity)) {
      this.logger.info(
        {
          source,
          chatIdentity,
          senderIdentity,
          hint: `Set TELEGRAM_ALLOWED_SENDER_IDS=${senderIdentity.telegramUserId}`
        },
        "Ignoring message from unauthorized sender"
      );
      return;
    }

    let parsed;
    try {
      parsed = parseSignal(message.message, String(message.id), new Date(this.messageDateMs(message)).toISOString());
    } catch (error) {
      this.logger.error({ error, source, messageId: message.id }, "Failed to parse Telegram signal message");
      return;
    }

    if (!parsed) {
      return;
    }

    await this.orchestrator.handleParsedSignal(parsed, chatId, {
      ...senderIdentity,
      isAllowed: true
    });
  }

  private rememberPollSeenMessage(messageKey: string): void {
    this.pollSeenMessageKeys.add(messageKey);
    if (this.pollSeenMessageKeys.size <= 1000) {
      return;
    }

    const [oldest] = this.pollSeenMessageKeys;
    if (oldest) {
      this.pollSeenMessageKeys.delete(oldest);
    }
  }

  private messageLooksLikeSignal(text?: string): boolean {
    if (!text) {
      return false;
    }

    const searchable = text.normalize("NFD").replace(/\p{M}/gu, "");
    return /NOVO SINAL|LUCRO/i.test(searchable);
  }

  private messageDateMs(message: TelegramMessageLike): number {
    const raw = Number(message.date ?? 0);
    const value = raw > 1_000_000_000_000 ? raw : raw * 1000;
    return Number.isFinite(value) && value > 0 ? value : Date.now();
  }

  private readField(sender: unknown, key: string): string | null {
    if (!sender || !(key in (sender as Record<string, unknown>))) {
      return null;
    }
    const value = (sender as Record<string, unknown>)[key];
    return value ? String(value) : null;
  }

  private buildDisplayName(sender: unknown): string | null {
    const firstName = this.readField(sender, "firstName");
    const lastName = this.readField(sender, "lastName");
    const title = this.readField(sender, "title");
    const combined = [firstName, lastName].filter(Boolean).join(" ").trim();
    return combined || title;
  }

  private buildChatTitle(chat: unknown): string | null {
    return this.readField(chat, "title") ?? this.buildDisplayName(chat);
  }

  private logDiscovery(
    chatIdentity: { chatId: string; title: string | null; username: string | null },
    senderIdentity: SenderIdentity
  ): void {
    this.logger.info(
      {
        chatIdentity,
        senderIdentity,
        hint: `Set TELEGRAM_SIGNAL_CHAT_ID=${chatIdentity.chatId}`,
        senderHint: senderIdentity.telegramUserId
          ? `Set TELEGRAM_ALLOWED_SENDER_IDS=${senderIdentity.telegramUserId}`
          : undefined
      },
      "Observed Telegram message while signal chat discovery is enabled"
    );
  }

  private logNonSignalChat(chatIdentity: { chatId: string; title: string | null; username: string | null }): void {
    if (this.discoveredChatIds.has(chatIdentity.chatId)) {
      return;
    }
    this.discoveredChatIds.add(chatIdentity.chatId);
    this.logger.info(
      {
        chatIdentity,
        configuredSignalChatId: this.config.telegramSignalChatId
      },
      "Ignoring message from a non-signal chat"
    );
  }

  private async safeGetChat(message: { getChat?: () => Promise<unknown> }): Promise<unknown> {
    try {
      return message.getChat ? await message.getChat() : null;
    } catch {
      return null;
    }
  }

  public async disconnect(): Promise<void> {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    await this.client.disconnect();
  }
}

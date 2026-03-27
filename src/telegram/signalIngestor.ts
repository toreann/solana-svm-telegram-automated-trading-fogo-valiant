import { readFileSync, writeFileSync } from "node:fs";
import type { Logger } from "pino";
import { TelegramClient } from "telegram/client/TelegramClient.js";
import { NewMessage } from "telegram/events/NewMessage.js";
import { StringSession } from "telegram/sessions/index.js";

import type { TradeOrchestrator } from "../orchestrator.js";
import { parseSignal } from "../signals/parser.js";
import type { SenderFilter } from "../signals/senderFilter.js";
import type { AppConfig, SenderIdentity } from "../types.js";
import { ensureParentDir } from "../utils.js";

function readSession(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export class TelegramSignalIngestor {
  private readonly client: TelegramClient;

  public constructor(
    private readonly config: AppConfig,
    private readonly senderFilter: SenderFilter,
    private readonly orchestrator: TradeOrchestrator,
    private readonly logger: Logger
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

    this.client.addEventHandler(async (event) => {
      const message = event.message;
      if (!message?.message) {
        return;
      }

      const chatId = String(message.chatId ?? "");
      if (chatId !== this.config.telegramSignalChatId) {
        return;
      }

      const sender = await message.getSender();
      const senderIdentity: SenderIdentity = {
        telegramUserId: String((sender as { id?: string | number } | undefined)?.id ?? ""),
        username: this.readField(sender, "username"),
        displayName: this.buildDisplayName(sender),
        isAllowed: false
      };

      if (!senderIdentity.telegramUserId) {
        this.logger.warn("Skipping message without sender identity");
        return;
      }

      if (!this.senderFilter.isAllowed(senderIdentity)) {
        this.logger.info({ senderIdentity }, "Ignoring message from unauthorized sender");
        return;
      }

      const messageDate = new Date(Number(message.date) * 1000).toISOString();
      const parsed = parseSignal(message.message, String(message.id), messageDate);
      if (!parsed) {
        return;
      }

      await this.orchestrator.handleParsedSignal(parsed, chatId, {
        ...senderIdentity,
        isAllowed: true
      });
    }, new NewMessage({}));
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

  public async disconnect(): Promise<void> {
    await this.client.disconnect();
  }
}
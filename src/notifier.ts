import type { Telegraf } from "telegraf";

import type { AppDatabase } from "./db.js";
import type { NotificationEvent } from "./types.js";

export class Notifier {
  public constructor(
    private readonly database: AppDatabase,
    private readonly controlBot: Telegraf,
    private readonly ownerChatId: string
  ) {}

  public async notify(event: NotificationEvent): Promise<void> {
    const inserted = this.database.recordNotification(event);
    if (!inserted) {
      return;
    }

    await this.controlBot.telegram.sendMessage(this.ownerChatId, `*${event.title}*\n\n${event.body}`, {
      parse_mode: "Markdown"
    });
  }
}
import { newId } from "./utils.js";
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

    try {
      const extra = (() => {
        if (!event.retryPositioning) {
          return undefined;
        }

        const actionId = newId();
        this.database.appendControlAction(
          actionId,
          "retry_positioning",
          JSON.stringify(event.retryPositioning),
          "pending"
        );
        return {
          reply_markup: {
            inline_keyboard: [[
              {
                text: "Retry positioning",
                callback_data: `retry:positioning:${actionId}`
              }
            ]]
          }
        };
      })();

      await this.controlBot.telegram.sendMessage(this.ownerChatId, `${event.title}\n\n${event.body}`, extra);
    } catch (error) {
      console.error("Failed to deliver Telegram notification", error);
    }
  }
}

import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { writeFileSync } from "node:fs";

import { TelegramClient } from "telegram/client/TelegramClient.js";
import { StringSession } from "telegram/sessions/index.js";

import { loadConfig } from "../config.js";
import { ensureParentDir } from "../utils.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const rl = createInterface({ input, output });
  const client = new TelegramClient(new StringSession(""), config.telegramApiId, config.telegramApiHash, {
    connectionRetries: 5
  });

  const phoneNumber = await rl.question("Telegram phone number (with country code): ");
  await client.start({
    phoneNumber: async () => phoneNumber,
    password: async () => rl.question("2FA password (leave empty if none): "),
    phoneCode: async () => rl.question("Telegram login code: "),
    onError: (error) => {
      throw error;
    }
  });

  ensureParentDir(config.telegramSessionFile);
  writeFileSync(config.telegramSessionFile, String(client.session.save()), "utf8");
  console.log(`Telegram session saved to ${config.telegramSessionFile}`);

  await client.disconnect();
  rl.close();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

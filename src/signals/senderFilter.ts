import type { AppDatabase } from "../db.js";
import type { AllowedSenderRule, SenderIdentity } from "../types.js";

export interface SenderCandidate {
  telegramUserId: string;
  username?: string | null;
  displayName?: string | null;
}

function matchesRule(rule: AllowedSenderRule, sender: SenderCandidate): boolean {
  if (rule.id && rule.id === sender.telegramUserId) {
    return true;
  }
  if (rule.username && sender.username && rule.username.toLowerCase() === sender.username.toLowerCase()) {
    return true;
  }
  if (
    rule.displayName &&
    sender.displayName &&
    rule.displayName.trim().toLowerCase() === sender.displayName.trim().toLowerCase()
  ) {
    return true;
  }
  return false;
}

export class SenderFilter {
  private readonly bootstrapRules: AllowedSenderRule[];

  public constructor(private readonly database: AppDatabase, ids: string[], labels: string[]) {
    this.bootstrapRules = [
      ...ids.map((id) => ({ id })),
      ...labels.map((label) => {
        if (label.startsWith("@")) {
          return { username: label.slice(1) };
        }
        return { displayName: label };
      })
    ];
  }

  public isAllowed(sender: SenderCandidate): boolean {
    const allowedSenders = this.database.getAllowedSenders();
    if (allowedSenders.some((existing) => existing.telegramUserId === sender.telegramUserId)) {
      this.database.upsertSenderIdentity({ ...sender, isAllowed: true });
      return true;
    }

    const bootstrapMatch = this.bootstrapRules.some((rule) => matchesRule(rule, sender));
    this.database.upsertSenderIdentity({ ...sender, isAllowed: bootstrapMatch });
    return bootstrapMatch;
  }

  public formatAllowedSenders(): string {
    const rows = this.database.getAllowedSenders();
    if (rows.length === 0) {
      return "None discovered yet";
    }
    return rows
      .map((row: SenderIdentity) => row.username ?? row.displayName ?? row.telegramUserId)
      .join(", ");
  }
}
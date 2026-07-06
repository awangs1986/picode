export const TELEGRAM_MAIN_ACCOUNT_ID = "telegram-main";
export const TELEGRAM_MAIN_CHANNEL_ID = "dm-main";

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_bot?: boolean;
}

export interface TelegramBotIdentity {
  id: string;
  name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface ObservedTelegramDm {
  chatId: string;
  chatName: string;
  userId: string;
  userName?: string;
}

interface ChatConfigLike {
  accounts?: Record<string, ChatAccountLike>;
  [key: string]: unknown;
}

interface ChatAccountLike {
  service?: string;
  [key: string]: unknown;
}

export interface TelegramDmSetupInput {
  botToken: string;
  identity: TelegramBotIdentity;
  dm: ObservedTelegramDm;
}

function displayName(user: TelegramUser | undefined): string | undefined {
  if (!user) return undefined;
  return (
    user.username || [user.first_name, user.last_name].filter(Boolean).join(" ") || String(user.id)
  );
}

function chatDisplayName(chat: TelegramChat): string {
  return (
    chat.title ||
    chat.username ||
    [chat.first_name, chat.last_name].filter(Boolean).join(" ") ||
    String(chat.id)
  );
}

async function callTelegram<T>(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: options?.signal,
  });
  const data = (await response.json()) as TelegramApiResponse<T>;
  if (!response.ok || !data.ok || data.result === undefined) {
    throw new Error(data.description || `Telegram API ${method} failed`);
  }
  return data.result;
}

export async function getTelegramBotIdentity(
  botToken: string,
  options?: { signal?: AbortSignal },
): Promise<TelegramBotIdentity> {
  const user = await callTelegram<TelegramUser>(botToken, "getMe", {}, options);
  const name =
    [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || String(user.id);
  return {
    id: String(user.id),
    name,
    username: user.username,
  };
}

async function getLatestUpdateId(
  botToken: string,
  options?: { signal?: AbortSignal },
): Promise<number | undefined> {
  const updates = await callTelegram<TelegramUpdate[]>(
    botToken,
    "getUpdates",
    {
      offset: -1,
      limit: 1,
      timeout: 0,
    },
    options,
  );
  return updates.at(-1)?.update_id;
}

function matchPrivateDm(message: TelegramMessage | undefined, botUserId: string): ObservedTelegramDm | undefined {
  if (!message || message.chat.type !== "private") return undefined;
  const userId = message.from ? String(message.from.id) : String(message.chat.id);
  if (!userId || userId === botUserId) return undefined;
  return {
    chatId: String(message.chat.id),
    chatName: chatDisplayName(message.chat),
    userId,
    userName: displayName(message.from),
  };
}

export async function observeTelegramPrivateDm(
  botToken: string,
  botUserId: string,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<ObservedTelegramDm | undefined> {
  const timeoutMs = Math.max(5_000, Math.min(options?.timeoutMs ?? 90_000, 180_000));
  const deadline = Date.now() + timeoutMs;
  await callTelegram(botToken, "deleteWebhook", { drop_pending_updates: false }, options);
  let offset = (await getLatestUpdateId(botToken, options)) ?? 0;

  while (Date.now() < deadline) {
    if (options?.signal?.aborted) return undefined;
    const remainingMs = Math.max(0, deadline - Date.now());
    const timeoutSeconds = Math.max(1, Math.min(30, Math.ceil(remainingMs / 1000)));
    const updates = await callTelegram<TelegramUpdate[]>(
      botToken,
      "getUpdates",
      {
        offset: offset + 1,
        timeout: timeoutSeconds,
        allowed_updates: ["message", "edited_message"],
      },
      options,
    );
    for (const update of updates) {
      offset = update.update_id;
      const observed = matchPrivateDm(update.message || update.edited_message, botUserId);
      if (observed) return observed;
    }
  }
  return undefined;
}

export function buildTelegramDmConfig(
  existingConfig: ChatConfigLike | undefined,
  setup: TelegramDmSetupInput,
): ChatConfigLike {
  const existingAccounts = existingConfig?.accounts ?? {};
  const nonTelegramAccounts = Object.fromEntries(
    Object.entries(existingAccounts).filter(([, account]) => account?.service !== "telegram"),
  );
  return {
    ...(existingConfig ?? {}),
    accounts: {
      ...nonTelegramAccounts,
      [TELEGRAM_MAIN_ACCOUNT_ID]: {
        service: "telegram",
        name: "Telegram",
        botToken: setup.botToken,
        botUserId: setup.identity.id,
        botUsername: setup.identity.username,
        channels: {
          [TELEGRAM_MAIN_CHANNEL_ID]: {
            id: setup.dm.chatId,
            name: setup.dm.userName || setup.dm.chatName,
            dm: true,
            access: {
              ignoreBots: true,
              allowedUserIds: [setup.dm.userId],
            },
          },
        },
      },
    },
  };
}

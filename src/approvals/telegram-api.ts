/**
 * Thin wrapper around the Telegram Bot HTTP API for the calls this repo
 * makes beyond sendMessage (which lives in notifier.ts with its retry).
 *
 * The API base URL is overridable via TELEGRAM_API_BASE_URL so integration
 * tests can point it at a local stub instead of api.telegram.org. The token
 * is only ever interpolated into request URLs, never logged.
 */
import { defaultSender, type TelegramSender } from './notifier.js';

export function telegramApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.TELEGRAM_API_BASE_URL ?? 'https://api.telegram.org').replace(/\/+$/, '');
}

export class TelegramApi {
  private readonly url: string;

  constructor(
    botToken: string,
    private readonly sender: TelegramSender = defaultSender,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    // The token lives only in the request URL, built here and never logged.
    this.url = `${telegramApiBase(env)}/bot${botToken}`;
  }

  private async post(method: string, body: unknown): Promise<void> {
    const { ok, status } = await this.sender(`${this.url}/${method}`, body);
    if (!ok) throw new Error(`telegram ${method} failed (status ${status})`);
  }

  /** Acknowledge a callback query — shows a toast on the owner's phone. */
  async answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
    await this.post('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: text.slice(0, 200),
      show_alert: false,
    });
  }

  /** Rewrite the hold message so the outcome is visible in chat history. */
  async editMessageText(chatId: string | number, messageId: number, text: string): Promise<void> {
    await this.post('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: text.slice(0, 4096),
    });
  }
}

import {
  handleMessage,
  handleQuickExpenseDatePostback,
  recordUnansweredQuestion,
} from "./expenses.ts";
import type { Env, LineReply, LineWebhookEvent } from "./shared.ts";

export async function processEvents(events: LineWebhookEvent[], env: Env): Promise<void> {
  for (const event of events) {
    const messageText =
      event.message?.type === "text" ? event.message.text?.trim() : undefined;
    const isQuickExpenseDatePostback = event.postback?.data === "quick-expense-date";
    if ((!messageText && !isQuickExpenseDatePostback) || !event.replyToken) {
      continue;
    }

    const userId = event.source?.userId;
    if (!userId || userId !== env.LINE_ALLOWED_USER_ID) {
      continue;
    }

    const eventId = event.webhookEventId;
    if (eventId) {
      // 只讓白名單使用者進入流程，並以資料庫唯一鍵避免 webhook 重送造成重複操作。
      const claim = await env.DB.prepare("INSERT OR IGNORE INTO processed_line_events (event_id) VALUES (?)")
        .bind(eventId)
        .run();
      if (claim.meta.changes === 0) {
        continue;
      }
    }

    try {
      const reply = messageText
        ? await handleMessage(messageText, userId, env)
        : await handleQuickExpenseDatePostback(event.postback?.params?.date, userId, env);
      if (reply !== null) {
        await replyToLine(event.replyToken, reply, env.LINE_CHANNEL_ACCESS_TOKEN);
      }
    } catch (error) {
      console.error("LINE message processing failed", error);
      try {
        await replyToLine(
          event.replyToken,
          "目前無法處理這則訊息，請稍後再試。",
          env.LINE_CHANNEL_ACCESS_TOKEN,
        );
      } catch (replyError) {
        if (eventId) {
          await env.DB.prepare("DELETE FROM processed_line_events WHERE event_id = ?")
            .bind(eventId)
            .run();
        }
        throw replyError;
      }
      const unansweredText =
        messageText ?? `LINE 日期選擇操作：${event.postback?.params?.date ?? "未提供日期"}`;
      await recordUnansweredQuestion(unansweredText, env);
    }
  }
}

export async function replyToLine(replyToken: string, reply: LineReply, accessToken: string): Promise<void> {
  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      replyToken,
      messages:
        typeof reply === "string"
          ? [{ type: "text", text: reply.slice(0, 5000) }]
          : reply.map((message) =>
              message.type === "text" ? { ...message, text: message.text.slice(0, 5000) } : message,
            ),
    }),
  });

  if (!response.ok) {
    console.error("LINE reply failed", response.status, await response.text());
    throw new Error(`LINE reply failed with status ${response.status}`);
  }
}

export async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(digest)));
  if (signature.length !== expected.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < signature.length; index += 1) {
    difference |= signature.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

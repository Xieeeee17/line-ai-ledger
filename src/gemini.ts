import { CATEGORIES, GEMINI_MODEL, MAX_AMOUNT, MAX_MONTHLY_BUDGET } from "./shared.ts";
import { isDate, taipeiDate } from "./shared.ts";
import type {
  Env,
  Expense,
  ExpenseDeletionCriteria,
  ExpenseEditChanges,
  GeminiUsage,
  ParsedMessage,
} from "./shared.ts";

export class GeminiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiUnavailableError";
  }
}

export async function parseMessage(text: string, userId: string, env: Env): Promise<ParsedMessage> {
  const today = taipeiDate();
  const systemInstruction = [
    "你是台灣個人記帳助理。判斷使用者是在記錄支出、查詢、設定預算、刪除或修改記帳、詢問使用方式，還是其他內容。",
    "查詢最近消費明細（例如「最近買了什麼？」）輸出 {\"intent\":\"recent_expenses\"}，代表查詢最近 5 筆。",
    "查詢本月支出合計（例如「這個月花了多少？」）輸出 {\"intent\":\"monthly_total\"}。",
    "查詢本月記帳列表（例如「列出本月記帳」、「本月花了哪些錢？」）輸出 {\"intent\":\"monthly_list\"}。",
    "查詢某段日期範圍的記帳（例如「查 2026 年 10 月的消費」）輸出 {\"intent\":\"expense_search\",\"startDate\":\"YYYY-MM-DD\",\"endDate\":\"YYYY-MM-DD\",\"category\":類別或null}。",
    "查詢類別支出圖表（例如「本月各類花多少？」）輸出 {\"intent\":\"category_summary\"}。",
    "詢問預算輸出 {\"intent\":\"budget_query\"}；設定預算輸出 {\"intent\":\"budget_set\",\"amount\":正整數}。",
    "刪除記帳輸出 JSON：{\"intent\":\"delete_expense\",\"description\":品項關鍵字或null,\"category\":類別或null,\"amount\":金額或null,\"date\":\"YYYY-MM-DD\"或null,\"latest\":布林值}。",
    "修改記帳輸出 JSON：{\"intent\":\"edit_expense\",\"criteria\":{\"description\":品項關鍵字或null,\"category\":類別或null,\"amount\":金額或null,\"date\":\"YYYY-MM-DD\"或null,\"latest\":布林值},\"changes\":{\"amount\":新金額或null,\"category\":新類別或null,\"description\":新品項或null,\"date\":\"YYYY-MM-DD\"或null}}。",
    "如果使用者只要求編輯某筆紀錄、但尚未提供新值（例如「編輯上一筆記帳」或「編輯 11/17 公車記帳」），仍輸出 edit_expense，changes 中所有欄位設為 null，讓助理接著詢問新金額；不可回覆 unknown，也不可猜新值。日期如 11/17 未寫年份時，使用目前年份。",
    "如果使用者在編輯引導中只回覆新金額（例如「改成 150 元」），輸出 edit_expense，criteria 使用 latest=true，changes.amount 設為 150。",
    "詢問如何使用或如何記帳（例如「我要怎麼記帳？」）輸出 {\"intent\":\"help\"}。",
    `記錄一筆明確支出時，只輸出 JSON：{"intent":"expense","amount":整數,"category":"${CATEGORIES.join("|")}","description":"簡短品項","date":"YYYY-MM-DD"}。`,
    `指令格式「指令記帳 金額 類別 品項 [YYYY-MM-DD]」也視為支出，例如「指令記帳 120 餐飲 午餐」。類別只能是 ${CATEGORIES.join("、")}。`,
    `今天是 ${today}（台北時間）。未提日期時使用今天。`,
    "刪除/修改條件中的相對日期請換算成 YYYY-MM-DD；只有明確要求最近一筆才將 latest 設為 true。金額以新台幣整數表示；類別只能從提供的類別選。不能猜測缺失條件或修改值。收入、無法判斷的內容輸出 {\"intent\":\"unknown\"}。",
    "只輸出 JSON。查詢、預算、刪除、修改或詢問用法不可當作新增支出。",
  ].join(" ");

  let response: Response;
  try {
    response = await callGeminiApi(env.GEMINI_API_KEY, systemInstruction, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Network request failed";
    console.error("Gemini API request could not be completed", message);
    throw new GeminiUnavailableError(message);
  }

  if (!response.ok) {
    const errorMessage = await getGeminiErrorMessage(response);
    console.error("Gemini API request failed", response.status, errorMessage);
    throw new GeminiUnavailableError(
      `Gemini API request failed with status ${response.status}: ${errorMessage}`,
    );
  }

  const result: unknown = await response.json();
  const usage = getGeminiUsage(result);
  await env.DB.prepare(
    `INSERT INTO gemini_usage
      (user_id, model, input_tokens, output_tokens, total_tokens)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(userId, GEMINI_MODEL, usage.inputTokens, usage.outputTokens, usage.totalTokens)
    .run();

  const responseText = getGeminiResponse(result);
  if (!responseText) {
    return { intent: "unknown" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return { intent: "unknown" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { intent: "unknown" };
  }

  const value = parsed as Record<string, unknown>;
  if (
    value.intent === "recent_expenses" ||
    value.intent === "monthly_total" ||
    value.intent === "monthly_list" ||
    value.intent === "category_summary" ||
    value.intent === "budget_query" ||
    value.intent === "help"
  ) {
    return { intent: value.intent };
  }
  if (value.intent === "budget_set") {
    if (
      typeof value.amount !== "number" ||
      !Number.isSafeInteger(value.amount) ||
      value.amount < 1 ||
      value.amount > MAX_MONTHLY_BUDGET
    ) {
      return { intent: "unknown" };
    }
    return { intent: "budget_set", amount: value.amount };
  }
  if (value.intent === "expense_search") {
    const category =
      typeof value.category === "string" && CATEGORIES.includes(value.category as (typeof CATEGORIES)[number])
        ? value.category
        : undefined;
    if (
      typeof value.startDate !== "string" ||
      !isDate(value.startDate) ||
      typeof value.endDate !== "string" ||
      !isDate(value.endDate) ||
      value.startDate > value.endDate ||
      (value.category !== undefined &&
        value.category !== null &&
        (typeof value.category !== "string" ||
          !CATEGORIES.includes(value.category as (typeof CATEGORIES)[number])))
    ) {
      return { intent: "unknown" };
    }
    return {
      intent: "expense_search",
      startDate: value.startDate,
      endDate: value.endDate,
      ...(category ? { category } : {}),
    };
  }
  if (value.intent === "delete_expense") {
    const criteria = parseDeletionCriteria(value);
    if (!criteria) return { intent: "unknown" };
    return {
      intent: "delete_expense",
      criteria,
    };
  }
  if (value.intent === "edit_expense") {
    const criteria =
      typeof value.criteria === "object" && value.criteria !== null
        ? parseDeletionCriteria(value.criteria as Record<string, unknown>)
        : null;
    const changes = parseEditChanges(value.changes);
    if (!criteria || (hasEditChangeValues(value.changes) && !changes)) {
      return { intent: "unknown" };
    }
    return {
      intent: "edit_expense",
      criteria,
      ...(changes ? { changes } : {}),
    };
  }
  if (value.intent !== "expense") {
    return { intent: "unknown" };
  }

  if (
    typeof value.amount !== "number" ||
    !Number.isSafeInteger(value.amount) ||
    value.amount < 1 ||
    value.amount > MAX_AMOUNT ||
    typeof value.category !== "string" ||
    !CATEGORIES.includes(value.category as (typeof CATEGORIES)[number]) ||
    typeof value.description !== "string" ||
    !value.description.trim() ||
    value.description.length > 100 ||
    typeof value.date !== "string" ||
    !isDate(value.date)
  ) {
    return { intent: "unknown" };
  }

  return {
    intent: "expense",
    expense: {
      amount: value.amount,
      category: value.category,
      description: value.description.trim(),
      occurredAt: new Date(`${value.date}T12:00:00+08:00`).toISOString(),
    },
  };
}

function parseDeletionCriteria(value: Record<string, unknown>): ExpenseDeletionCriteria | null {
  const description = typeof value.description === "string" ? value.description.trim() : "";
  const category = typeof value.category === "string" ? value.category : undefined;
  const amount = typeof value.amount === "number" ? value.amount : undefined;
  const date = typeof value.date === "string" ? value.date : undefined;
  if (
    (value.description !== undefined &&
      value.description !== null &&
      (typeof value.description !== "string" || !description || description.length > 100)) ||
    (value.category !== undefined &&
      value.category !== null &&
      (typeof value.category !== "string" ||
        !CATEGORIES.includes(value.category as (typeof CATEGORIES)[number]))) ||
    (value.amount !== undefined &&
      value.amount !== null &&
      (typeof value.amount !== "number" ||
        !Number.isSafeInteger(value.amount) ||
        value.amount < 1 ||
        value.amount > MAX_AMOUNT)) ||
    (value.date !== undefined &&
      value.date !== null &&
      (typeof value.date !== "string" || !isDate(value.date))) ||
    (value.latest !== undefined && typeof value.latest !== "boolean")
  ) {
    return null;
  }
  return {
    ...(description ? { description } : {}),
    ...(category ? { category } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...(date ? { date } : {}),
    latest: value.latest === true,
  };
}

function parseEditChanges(value: unknown): ExpenseEditChanges | null {
  if (typeof value !== "object" || value === null) return null;
  const changes = value as Record<string, unknown>;
  const amount = typeof changes.amount === "number" ? changes.amount : undefined;
  const category = typeof changes.category === "string" ? changes.category : undefined;
  const description =
    typeof changes.description === "string" ? changes.description.trim() : undefined;
  const date = typeof changes.date === "string" ? changes.date : undefined;
  if (
    (changes.amount !== undefined &&
      changes.amount !== null &&
      (typeof changes.amount !== "number" ||
        !Number.isSafeInteger(changes.amount) ||
        changes.amount < 1 ||
        changes.amount > MAX_AMOUNT)) ||
    (changes.category !== undefined &&
      changes.category !== null &&
      (typeof changes.category !== "string" ||
        !CATEGORIES.includes(changes.category as (typeof CATEGORIES)[number]))) ||
    (changes.description !== undefined &&
      changes.description !== null &&
      (typeof changes.description !== "string" ||
        !description ||
        description.length > 100)) ||
    (changes.date !== undefined &&
      changes.date !== null &&
      (typeof changes.date !== "string" || !isDate(changes.date)))
  ) {
    return null;
  }
  if (
    amount === undefined &&
    category === undefined &&
    description === undefined &&
    date === undefined
  ) {
    return null;
  }
  return {
    ...(amount !== undefined ? { amount } : {}),
    ...(category ? { category } : {}),
    ...(description ? { description } : {}),
    ...(date ? { date } : {}),
  };
}

function hasEditChangeValues(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const changes = value as Record<string, unknown>;
  return ["amount", "category", "description", "date"].some(
    (key) => changes[key] !== undefined && changes[key] !== null,
  );
}

async function getGeminiErrorMessage(response: Response): Promise<string> {
  const body = await response.text();
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const error = parsed.error;
      if (typeof error === "object" && error !== null && "message" in error) {
        const code = "code" in error && typeof error.code === "string" ? `${error.code}: ` : "";
        if (typeof error.message === "string") {
          return `${code}${error.message}`.slice(0, 500);
        }
      }
    }
  } catch {
    return body.slice(0, 500) || "No error details returned";
  }

  return body.slice(0, 500) || "No error details returned";
}

async function callGeminiApi(
  apiKey: string,
  systemInstruction: string,
  input: string,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
          "Api-Revision": "2026-05-20",
        },
        body: JSON.stringify({
          model: GEMINI_MODEL,
          system_instruction: systemInstruction,
          input,
          response_format: { type: "text", mime_type: "application/json" },
          generation_config: { thinking_level: "low" },
          // 不保留 Gemini 對話；用量統計僅寫入本機器人的 D1。
          store: false,
        }),
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      if (attempt >= 1) {
        throw error;
      }

      await new Promise<void>((resolve) =>
        setTimeout(resolve, 500 + Math.floor(Math.random() * 250)),
      );
      continue;
    }

    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= 1) {
      return response;
    }

    const delay = 500 + Math.floor(Math.random() * 250);
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
}

function getGeminiUsage(result: unknown): GeminiUsage {
  if (typeof result !== "object" || result === null || !("usage" in result)) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
  const usage = result.usage;
  if (typeof usage !== "object" || usage === null) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  const inputTokens = getTokenCount("total_input_tokens" in usage ? usage.total_input_tokens : 0);
  const outputTokens = getTokenCount("total_output_tokens" in usage ? usage.total_output_tokens : 0);
  const totalTokens = getTokenCount("total_tokens" in usage ? usage.total_tokens : 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens || inputTokens + outputTokens,
  };
}

function getTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function getGeminiResponse(result: unknown): string | null {
  if (typeof result !== "object" || result === null || !("steps" in result)) {
    return null;
  }

  const steps = result.steps;
  if (!Array.isArray(steps)) {
    return null;
  }

  const textParts: string[] = [];
  for (const step of steps) {
    if (typeof step !== "object" || step === null || !("type" in step) || step.type !== "model_output") {
      continue;
    }
    if (!("content" in step) || !Array.isArray(step.content)) {
      continue;
    }
    for (const part of step.content) {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        textParts.push(part.text);
      }
    }
  }

  return textParts.join("").trim() || null;
}

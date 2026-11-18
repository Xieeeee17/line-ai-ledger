import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";

const USER_ID = "allowed-user";
const SECRET = "test-line-secret";

class FakeStatement {
  constructor(database, query) {
    this.database = database;
    this.query = query.replace(/\s+/g, " ").trim();
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    const query = this.query;
    if (query.includes("FROM bot_model_status")) {
      return this.database.modelStatus;
    }
    if (query.includes("FROM pending_expense_deletions JOIN expenses")) {
      const [userId] = this.values;
      const pendingId = this.database.pendingDeletions.get(userId);
      const expense = this.database.expenses.find(
        (item) => item.id === pendingId && item.user_id === userId,
      );
      return expense ? { ...expense, occurred_at: expense.occurred_at } : null;
    }
    if (query.includes("FROM pending_expense_edits")) {
      return this.database.pendingEdits.get(this.values[0]) ?? null;
    }
    if (query.includes("FROM pending_expense_edit_targets")) {
      const [userId] = this.values;
      const expenseId = this.database.pendingEditTargets.get(userId)?.expense_id;
      const expense = this.database.expenses.find(
        (item) => item.id === expenseId && item.user_id === userId,
      );
      if (!expense) return null;
      return {
        ...expense,
        created_at: this.database.pendingEditTargets.get(userId).created_at,
      };
    }
    if (query.includes("FROM pending_expenses")) {
      return this.database.pendingExpenses.get(this.values[0]) ?? null;
    }
    if (query.includes("FROM monthly_expense_list_sessions")) {
      return this.database.monthlyListSessions.get(this.values[0]) ?? null;
    }
    if (query.includes("FROM quick_expense_sessions")) {
      return this.database.quickExpenseSessions.get(this.values[0]) ?? null;
    }
    if (query.includes("FROM unanswered_questions") && query.includes("COUNT(*)")) {
      const month = this.values[0];
      return {
        count: this.database.unansweredQuestions.filter(
          (item) => item.created_at.slice(0, 7) === month,
        ).length,
      };
    }
    if (query.includes("FROM gemini_usage")) {
      return {
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      };
    }
    if (query.includes("FROM line_rich_menu_config")) {
      return this.database.richMenuConfig;
    }
    if (query.includes("COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count")) {
      const [, month] = this.values;
      const expenses = this.database.expenses.filter(
        (item) => item.user_id === this.values[0] && item.occurred_at.slice(0, 7) === month,
      );
      return {
        total: expenses.reduce((sum, item) => sum + item.amount, 0),
        count: expenses.length,
      };
    }
    if (query.includes("COUNT(*) AS count FROM expenses")) {
      return { count: this.database.expenses.length };
    }
    if (query.includes("SELECT amount FROM monthly_budgets")) return null;
    return null;
  }

  async all() {
    const query = this.query;
    if (
      query.includes("ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?") &&
      query.includes("substr(occurred_at, 1, 7) = ?")
    ) {
      const [userId, month, limit, offset] = this.values;
      const results = this.database.expenses
        .filter(
          (item) =>
            item.user_id === userId && item.occurred_at.slice(0, 7) === month,
        )
        .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at) || right.id - left.id)
        .slice(offset, offset + limit);
      return { results };
    }
    if (query.includes("SELECT id, question, created_at FROM unanswered_questions")) {
      const month = this.values[0];
      const questions = this.database.unansweredQuestions
        .filter((item) => item.created_at.slice(0, 7) === month)
        .sort((left, right) =>
          query.includes("ORDER BY created_at ASC")
            ? left.id - right.id
            : right.id - left.id,
        );
      return {
        results: query.includes("LIMIT 20") ? questions.slice(0, 20) : questions,
      };
    }
    if (query.includes("SELECT category, SUM(amount) AS total FROM expenses")) {
      const [userId, month] = this.values;
      const totals = new Map();
      for (const expense of this.database.expenses) {
        if (expense.user_id === userId && expense.occurred_at.slice(0, 7) === month) {
          totals.set(expense.category, (totals.get(expense.category) ?? 0) + expense.amount);
        }
      }
      return {
        results: [...totals].map(([category, total]) => ({ category, total })),
      };
    }
    if (query.includes("FROM expenses WHERE user_id = ?")) {
      const [userId, ...filters] = this.values;
      let results = this.database.expenses.filter((item) => item.user_id === userId);
      let index = 0;
      if (query.includes("instr(lower(description)")) {
        const description = String(filters[index++]).toLowerCase();
        results = results.filter((item) => item.description.toLowerCase().includes(description));
      }
      if (query.includes("AND category = ?")) {
        const category = filters[index++];
        results = results.filter((item) => item.category === category);
      }
      if (query.includes("AND amount = ?")) {
        const amount = filters[index++];
        results = results.filter((item) => item.amount === amount);
      }
      if (query.includes("substr(occurred_at, 1, 10) = ?")) {
        const date = filters[index++];
        results = results.filter((item) => item.occurred_at.slice(0, 10) === date);
      }
      return { results: results.slice(0, 6) };
    }
    return { results: [] };
  }

  async run() {
    const query = this.query;
    const values = this.values;
    if (query.startsWith("INSERT OR IGNORE INTO processed_line_events")) {
      const eventId = values[0];
      if (this.database.processedEvents.has(eventId)) return { meta: { changes: 0 } };
      this.database.processedEvents.add(eventId);
      return { meta: { changes: 1 } };
    }
    if (query.startsWith("INSERT INTO pending_expense_edit_targets")) {
      this.database.pendingEditTargets.set(values[0], {
        expense_id: values[1],
        created_at: new Date().toISOString().replace("T", " ").slice(0, 19),
      });
      return { meta: { changes: 1 } };
    }
    if (query.startsWith("DELETE FROM pending_expense_edit_targets")) {
      const deleted = this.database.pendingEditTargets.delete(values[0]);
      return { meta: { changes: deleted ? 1 : 0 } };
    }
    if (query.startsWith("INSERT INTO monthly_expense_list_sessions")) {
      this.database.monthlyListSessions.set(values[0], { page: values[1] });
      return { meta: { changes: 1 } };
    }
    if (query.startsWith("DELETE FROM monthly_expense_list_sessions")) {
      const deleted = this.database.monthlyListSessions.delete(values[0]);
      return { meta: { changes: deleted ? 1 : 0 } };
    }
    if (query.startsWith("INSERT INTO quick_expense_sessions")) {
      this.database.quickExpenseSessions.set(values[0], {
        step: values[1],
        amount: values[2],
        category: values[3],
        description: values[4],
        updated_at: new Date().toISOString().replace("T", " ").slice(0, 19),
      });
      return { meta: { changes: 1 } };
    }
    if (query.startsWith("DELETE FROM quick_expense_sessions")) {
      const deleted = this.database.quickExpenseSessions.delete(values[0]);
      return { meta: { changes: deleted ? 1 : 0 } };
    }
    if (query.startsWith("DELETE FROM processed_line_events")) {
      this.database.processedEvents.delete(values[0]);
      return { meta: { changes: 1 } };
    }
    if (query.startsWith("INSERT INTO gemini_usage")) return { meta: { changes: 1 } };
    if (query.startsWith("DELETE FROM unanswered_questions")) {
      return { meta: { changes: 0 } };
    }
    if (query.startsWith("INSERT INTO unanswered_questions")) {
      const item = {
        id: this.database.unansweredQuestions.length + 1,
        question: values[0],
        created_at: `${currentTaipeiMonth()}-15 12:00:00`,
      };
      this.database.unansweredQuestions.push(item);
      return { meta: { changes: 1 } };
    }
    if (query.startsWith("INSERT INTO line_rich_menu_config")) {
      this.database.richMenuConfig = {
        rich_menu_id: values[0],
        image_uploaded: 0,
      };
      return { meta: { changes: 1 } };
    }
    if (query.startsWith("UPDATE line_rich_menu_config SET image_uploaded = 1")) {
      this.database.richMenuConfig.image_uploaded = 1;
      return { meta: { changes: 1 } };
    }
    if (query.startsWith("INSERT INTO expenses")) {
      this.database.expenses.push({
        id: this.database.expenses.length + 1,
        user_id: values[0],
        amount: values[1],
        category: values[2],
        description: values[3],
        occurred_at: values[4],
      });
      return { meta: { changes: 1 } };
    }
    if (query.startsWith("INSERT INTO bot_model_status")) {
      this.database.modelStatus = {
        available: values[1],
        checked_at: new Date().toISOString().replace("T", " ").slice(0, 19),
      };
      return { meta: { changes: 1 } };
    }
    if (query.startsWith("INSERT INTO pending_expenses")) {
      this.database.pendingExpenses.set(values[0], {
        amount: values[1],
        category: values[2],
        description: values[3],
        occurred_at: values[4],
      });
      return { meta: { changes: 1 } };
    }
    if (query.startsWith("DELETE FROM pending_expenses")) {
      const deleted = this.database.pendingExpenses.delete(values[0]);
      return { meta: { changes: deleted ? 1 : 0 } };
    }
    if (query.startsWith("INSERT INTO pending_expense_deletions")) {
      this.database.pendingDeletions.set(values[0], values[1]);
      return { meta: { changes: 1 } };
    }
    if (query.startsWith("INSERT INTO pending_expense_edits")) {
      this.database.pendingEdits.set(values[0], {
        expense_id: values[1],
        amount: values[2],
        category: values[3],
        description: values[4],
        occurred_at: values[5],
      });
      return { meta: { changes: 1 } };
    }
    if (query.startsWith("INSERT OR REPLACE INTO expense_undo")) {
      const expense = this.database.expenses.find(
        (item) => item.id === values[0] && item.user_id === values[1],
      );
      if (expense) this.database.undo.set(values[1], { ...expense });
      return { meta: { changes: expense ? 1 : 0 } };
    }
    if (query.startsWith("DELETE FROM expenses WHERE id = ? AND user_id = ? AND EXISTS")) {
      const [id, userId] = values;
      const index = this.database.expenses.findIndex(
        (item) => item.id === id && item.user_id === userId,
      );
      if (index >= 0) this.database.expenses.splice(index, 1);
      return { meta: { changes: index >= 0 ? 1 : 0 } };
    }
    if (query.startsWith("DELETE FROM pending_expense_deletions")) {
      const [userId, expenseId] = values;
      const existing = this.database.pendingDeletions.get(userId);
      if (expenseId === undefined || existing === expenseId) {
        this.database.pendingDeletions.delete(userId);
      }
      return { meta: { changes: existing === undefined ? 0 : 1 } };
    }
    if (query.startsWith("UPDATE expenses SET amount = ?")) {
      const [amount, category, description, occurredAt, id, userId] = values;
      const expense = this.database.expenses.find(
        (item) => item.id === id && item.user_id === userId,
      );
      if (expense) Object.assign(expense, { amount, category, description, occurred_at: occurredAt });
      return { meta: { changes: expense ? 1 : 0 } };
    }
    if (query.startsWith("DELETE FROM pending_expense_edits")) {
      const deleted = this.database.pendingEdits.delete(values[0]);
      return { meta: { changes: deleted ? 1 : 0 } };
    }
    return { meta: { changes: 0 } };
  }
}

class FakeDatabase {
  constructor() {
    this.processedEvents = new Set();
    this.pendingDeletions = new Map();
    this.pendingEdits = new Map();
    this.pendingEditTargets = new Map();
    this.pendingExpenses = new Map();
    this.monthlyListSessions = new Map();
    this.quickExpenseSessions = new Map();
    this.expenses = [];
    this.unansweredQuestions = [];
    this.undo = new Map();
    this.modelStatus = null;
    this.richMenuConfig = null;
  }

  prepare(query) {
    return new FakeStatement(this, query);
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

function makeEnv(database) {
  return {
    DB: database,
    GEMINI_API_KEY: "test-key",
    LINE_ALLOWED_USER_ID: USER_ID,
    LINE_CHANNEL_ACCESS_TOKEN: "test-access-token",
    LINE_CHANNEL_SECRET: SECRET,
    DASHBOARD_PASSWORD: "dashboard-password",
    ASSETS: {
      fetch: async () => new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": "image/png" },
      }),
    },
  };
}

function makeModelResponse(intent) {
  return Response.json({
    steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(intent) }] }],
    usage: { total_input_tokens: 1, total_output_tokens: 1, total_tokens: 2 },
  });
}

async function sendWebhookEvent(database, event) {
  const body = JSON.stringify({ events: [event] });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
      ),
    ),
  );
  const tasks = [];
  const response = await worker.fetch(
    new Request("https://worker.test/webhook", {
      method: "POST",
      headers: { "x-line-signature": signature },
      body,
    }),
    makeEnv(database),
    { waitUntil: (task) => tasks.push(task) },
  );
  await Promise.all(tasks);
  return response;
}

async function sendWebhook(database, message, eventId, sourceUserId = USER_ID) {
  return sendWebhookEvent(database, {
    type: "message",
    webhookEventId: eventId,
    replyToken: `reply-${eventId}`,
    source: { userId: sourceUserId },
    message: { type: "text", text: message },
  });
}

async function sendDatePostback(database, date, eventId, sourceUserId = USER_ID) {
  return sendWebhookEvent(database, {
    type: "postback",
    webhookEventId: eventId,
    replyToken: `reply-${eventId}`,
    source: { userId: sourceUserId },
    postback: { data: "quick-expense-date", params: { date } },
  });
}

function currentTaipeiMonth() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  return `${parts.find((part) => part.type === "year").value}-${parts.find((part) => part.type === "month").value}`;
}

function currentTaipeiMonthDay(day) {
  const [year, month] = currentTaipeiMonth().split("-");
  return `${year}-${month}-${String(day).padStart(2, "0")}`;
}

test("duplicate LINE webhook events are processed only once", async () => {
  const database = new FakeDatabase();
  const replies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      return makeModelResponse({ intent: "monthly_total" });
    }
    replies.push(JSON.parse(options.body));
    return new Response(null, { status: 200 });
  };
  try {
    await sendWebhook(database, "這個月花多少", "event-duplicate");
    await sendWebhook(database, "這個月花多少", "event-duplicate");
    assert.equal(replies.length, 1);
    assert.equal(database.processedEvents.size, 1);

    await sendWebhook(database, "本月", "event-other-user", "another-user");
    assert.equal(replies.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("manual commands work during model outages and model recovery is detected", async () => {
  const database = new FakeDatabase();
  const replies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      if (JSON.parse(options.body).input.startsWith("指令記帳")) {
        return Response.json({ error: { message: "temporarily unavailable" } }, { status: 503 });
      }
      return makeModelResponse({ intent: "monthly_total" });
    }
    replies.push(JSON.parse(options.body));
    return new Response(null, { status: 200 });
  };
  try {
    await sendWebhook(database, "指令記帳 120 餐飲 午餐", "event-model-down");
    assert.equal(database.pendingExpenses.get(USER_ID).amount, 120);
    assert.ok(JSON.stringify(replies[0]).includes("切換至指令記帳模式"));
    assert.equal(database.modelStatus.available, 0);

    database.modelStatus.checked_at = new Date(Date.now() - 6 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    await sendWebhook(database, "這個月花了多少", "event-model-recovered");
    assert.equal(database.modelStatus.available, 1);
    assert.ok(JSON.stringify(replies.at(-1)).includes("模型已恢復"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("deletion requires confirmation and only affects the matched user's expense", async () => {
  const database = new FakeDatabase();
  database.expenses.push({
    id: 1,
    user_id: USER_ID,
    amount: 120,
    category: "餐飲",
    description: "午餐",
    occurred_at: "2026-10-12T04:00:00.000Z",
  });
  database.expenses.push({
    id: 2,
    user_id: "another-user",
    amount: 500,
    category: "餐飲",
    description: "午餐",
    occurred_at: "2026-10-12T04:00:00.000Z",
  });
  const replies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      return makeModelResponse({
        intent: "delete_expense",
        description: "午餐",
        category: null,
        amount: null,
        date: null,
        latest: false,
      });
    }
    replies.push(JSON.parse(options.body));
    return new Response(null, { status: 200 });
  };
  try {
    await sendWebhook(database, "刪除午餐", "event-delete-request");
    assert.equal(database.expenses.length, 2);
    assert.equal(database.pendingDeletions.get(USER_ID), 1);
    assert.ok(JSON.stringify(replies[0]).includes("確認刪除"));

    await sendWebhook(database, "確認刪除", "event-delete-confirmation");
    assert.deepEqual(database.expenses.map((expense) => expense.id), [2]);
    assert.equal(database.undo.get(USER_ID).id, 1);
    assert.equal(database.undo.get("another-user"), undefined);
    assert.ok(JSON.stringify(replies.at(-1)).includes("復原刪除"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("editing an expense is staged until the user confirms", async () => {
  const database = new FakeDatabase();
  database.expenses.push({
    id: 1,
    user_id: USER_ID,
    amount: 120,
    category: "餐飲",
    description: "午餐",
    occurred_at: "2026-10-12T04:00:00.000Z",
  });
  const replies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      return makeModelResponse({
        intent: "edit_expense",
        criteria: {
          description: "午餐",
          category: null,
          amount: null,
          date: null,
          latest: false,
        },
        changes: { amount: 150, category: null, description: null, date: null },
      });
    }
    replies.push(JSON.parse(options.body));
    return new Response(null, { status: 200 });
  };
  try {
    await sendWebhook(database, "把午餐改成 150 元", "event-edit-request");
    assert.equal(database.expenses[0].amount, 120);
    assert.equal(database.pendingEdits.get(USER_ID).amount, 150);
    assert.ok(JSON.stringify(replies[0]).includes("確認修改"));

    await sendWebhook(database, "確認修改", "event-edit-confirm");
    assert.equal(database.expenses[0].amount, 150);
    assert.equal(database.pendingEdits.has(USER_ID), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("guided edit asks for the new amount before staging a confirmation", async () => {
  const database = new FakeDatabase();
  database.expenses.push({
    id: 1,
    user_id: USER_ID,
    amount: 40,
    category: "交通",
    description: "公車",
    occurred_at: `${currentTaipeiMonthDay(17)}T04:00:00.000Z`,
  });
  const replies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      return makeModelResponse({ intent: "unknown" });
    }
    replies.push(JSON.parse(options.body));
    return new Response(null, { status: 200 });
  };
  try {
    const month = currentTaipeiMonth().split("-")[1];
    await sendWebhook(database, `編輯${month}/17公車記帳`, "event-edit-guided-start");
    assert.equal(database.expenses[0].amount, 40);
    assert.equal(database.pendingEditTargets.get(USER_ID).expense_id, 1);
    assert.ok(JSON.stringify(replies[0]).includes("請直接回覆新金額"));

    await sendWebhook(database, "改成 55 元", "event-edit-guided-amount");
    assert.equal(database.expenses[0].amount, 40);
    assert.equal(database.pendingEditTargets.has(USER_ID), false);
    assert.equal(database.pendingEdits.get(USER_ID).amount, 55);
    assert.ok(JSON.stringify(replies.at(-1)).includes("確認修改"));

    await sendWebhook(database, "確認修改", "event-edit-guided-confirm");
    assert.equal(database.expenses[0].amount, 55);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("monthly expense list is a paginated visual Flex message", async () => {
  const database = new FakeDatabase();
  for (let index = 1; index <= 7; index += 1) {
    database.expenses.push({
      id: index,
      user_id: USER_ID,
      amount: index * 100,
      category: index % 2 === 0 ? "交通" : "餐飲",
      description: `品項${index}`,
      occurred_at: `${currentTaipeiMonth()}-${String(index).padStart(2, "0")}T04:00:00.000Z`,
    });
  }
  const replies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      return makeModelResponse({ intent: "monthly_list" });
    }
    replies.push(JSON.parse(options.body));
    return new Response(null, { status: 200 });
  };
  try {
    await sendWebhook(database, "列出本月記帳", "event-monthly-list");
    const firstPage = replies[0].messages[0];
    assert.equal(firstPage.type, "flex");
    assert.match(firstPage.altText, /合計/);
    const firstText = JSON.stringify(firstPage.contents);
    assert.match(firstText, /品項7/);
    assert.match(firstText, /品項3/);
    assert.doesNotMatch(firstText, /品項2/);
    assert.ok(firstPage.quickReply.items.some((item) => item.action.text === "下一頁"));

    await sendWebhook(database, "下一頁", "event-monthly-list-next");
    const secondPage = replies.at(-1).messages[0];
    assert.equal(secondPage.type, "flex");
    const secondText = JSON.stringify(secondPage.contents);
    assert.match(secondText, /品項2/);
    assert.match(secondText, /品項1/);
    assert.doesNotMatch(secondText, /品項3/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LINE chart response is a labeled horizontal bar chart with amounts", async () => {
  const database = new FakeDatabase();
  database.expenses.push(
    {
      id: 1,
      user_id: USER_ID,
      amount: 1200,
      category: "餐飲",
      description: "午餐",
      occurred_at: `${currentTaipeiMonth()}-12T04:00:00.000Z`,
    },
    {
      id: 2,
      user_id: USER_ID,
      amount: 300,
      category: "交通",
      description: "捷運",
      occurred_at: `${currentTaipeiMonth()}-12T04:00:00.000Z`,
    },
  );
  const replies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      return makeModelResponse({ intent: "category_summary" });
    }
    replies.push(JSON.parse(options.body));
    return new Response(null, { status: 200 });
  };
  try {
    await sendWebhook(database, "本月各類支出圖表", "event-chart");
    const chart = replies[0].messages[0];
    assert.equal(chart.type, "flex");
    assert.match(chart.altText, /長條圖/);
    const chartText = JSON.stringify(chart.contents);
    assert.match(chartText, /餐飲/);
    assert.match(chartText, /交通/);
    assert.match(chartText, /NT\$1,200/);
    assert.match(chartText, /NT\$300/);
    assert.doesNotMatch(chartText, /金額（X 軸）|NT\$600/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unknown questions are saved in D1 and shown in the authenticated dashboard", async () => {
  const database = new FakeDatabase();
  const replies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      return makeModelResponse({ intent: "unknown" });
    }
    replies.push(JSON.parse(options.body));
    return new Response(null, { status: 200 });
  };
  try {
    await sendWebhook(database, "能不能幫我規劃一趟旅行", "event-unanswered-question");
    assert.equal(database.unansweredQuestions.length, 1);
    assert.equal(database.unansweredQuestions[0].question, "能不能幫我規劃一趟旅行");

    const dashboardResponse = await worker.fetch(
      new Request("https://worker.test/api/dashboard?page=1", {
        headers: {
          Authorization: `Basic ${btoa("admin:dashboard-password")}`,
        },
      }),
      makeEnv(database),
      { waitUntil: () => {} },
    );
    assert.equal(dashboardResponse.status, 200);
    const dashboard = await dashboardResponse.json();
    assert.equal(dashboard.unanswered.count, 1);
    assert.equal(dashboard.unanswered.recent[0].question, "能不能幫我規劃一趟旅行");

    for (let id = 2; id <= 22; id += 1) {
      database.unansweredQuestions.push({
        id,
        question: id === 2 ? '=HYPERLINK("https://example.test")' : `未處理問題${id}`,
        created_at: `${currentTaipeiMonth()}-16 12:00:00`,
      });
    }
    const authHeaders = {
      Authorization: `Basic ${btoa("admin:dashboard-password")}`,
    };
    const unauthenticatedExport = await worker.fetch(
      new Request("https://worker.test/api/unanswered-questions.json"),
      makeEnv(database),
      { waitUntil: () => {} },
    );
    assert.equal(unauthenticatedExport.status, 401);

    const jsonResponse = await worker.fetch(
      new Request("https://worker.test/api/unanswered-questions.json", {
        headers: authHeaders,
      }),
      makeEnv(database),
      { waitUntil: () => {} },
    );
    const exportedJson = await jsonResponse.json();
    assert.equal(exportedJson.count, 22);
    assert.equal(exportedJson.questions.length, 22);
    assert.equal(exportedJson.questions[0].question, "能不能幫我規劃一趟旅行");
    assert.equal(exportedJson.questions.at(-1).question, "未處理問題22");

    const csvResponse = await worker.fetch(
      new Request("https://worker.test/api/unanswered-questions.csv", {
        headers: authHeaders,
      }),
      makeEnv(database),
      { waitUntil: () => {} },
    );
    const exportedCsv = await csvResponse.text();
    assert.match(exportedCsv, /使用者問題/);
    assert.match(exportedCsv, /'=HYPERLINK/);
    assert.match(exportedCsv, /未處理問題22/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("processing failures are recorded when the fallback reply is sent", async () => {
  const database = new FakeDatabase();
  const prepare = database.prepare.bind(database);
  database.prepare = (query) => {
    const statement = prepare(query);
    if (query.includes("FROM bot_model_status")) {
      statement.first = async () => {
        throw new Error("test database read failure");
      };
    }
    return statement;
  };
  const replies = [];
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  globalThis.fetch = async (_url, options) => {
    replies.push(JSON.parse(options.body));
    return new Response(null, { status: 200 });
  };
  console.error = () => {};
  try {
    await sendWebhook(database, "這筆訊息無法正常處理", "event-processing-failure");
    assert.equal(
      replies[0].messages[0].text,
      "目前無法處理這則訊息，請稍後再試。",
    );
    assert.equal(database.unansweredQuestions[0].question, "這筆訊息無法正常處理");
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test("function menu guides quick entry through amount, category, item, and date picker", async () => {
  const database = new FakeDatabase();
  const replies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    replies.push(JSON.parse(options.body));
    return new Response(null, { status: 200 });
  };
  try {
    await sendWebhook(database, "功能選單", "event-function-menu");
    const menuMessage = replies[0].messages[0];
    assert.deepEqual(
      menuMessage.quickReply.items.map((item) => item.action.text),
      ["快速記帳", "修改記帳", "本月支出明細", "本月支出長條圖"],
    );

    await sendWebhook(database, "快速記帳", "event-quick-entry");
    assert.match(replies[1].messages[0].text, /請輸入金額/);
    await sendWebhook(database, "250", "event-quick-entry-amount");
    assert.ok(replies[2].messages[0].quickReply.items.some(
      (item) => item.action.text === "快速記帳類型:交通",
    ));
    await sendWebhook(database, "快速記帳類型:交通", "event-quick-entry-category");
    assert.match(replies[3].messages[0].text, /請輸入品項/);
    await sendWebhook(database, "公車", "event-quick-entry-item");
    assert.ok(replies[4].messages[0].quickReply.items.some(
      (item) => item.action.type === "datetimepicker",
    ));
    await sendDatePostback(database, "2026-11-16", "event-quick-entry-date");
    assert.ok(replies[5].messages[0].quickReply.items.some(
      (item) => item.action.text === "確認",
    ));
    assert.equal(database.pendingExpenses.get(USER_ID).amount, 250);
    assert.equal(database.pendingExpenses.get(USER_ID).category, "交通");
    assert.equal(database.pendingExpenses.get(USER_ID).description, "公車");
    assert.equal(database.pendingExpenses.get(USER_ID).occurred_at, "2026-11-16T04:00:00.000Z");
    assert.equal(database.quickExpenseSessions.has(USER_ID), false);
    await sendWebhook(database, "確認", "event-quick-entry-confirm");
    assert.equal(database.expenses[0].amount, 250);
    assert.equal(database.expenses[0].occurred_at, "2026-11-16T04:00:00.000Z");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authenticated dashboard setup creates and links a LINE Rich Menu", async () => {
  const database = new FakeDatabase();
  const apiCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    apiCalls.push({ url: String(url), options });
    if (String(url) === "https://api.line.me/v2/bot/richmenu") {
      return Response.json({ richMenuId: "richmenu-test" });
    }
    return new Response(null, { status: 200 });
  };
  try {
    const response = await worker.fetch(
      new Request("https://worker.test/api/line-rich-menu/setup", {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa("admin:dashboard-password")}`,
        },
      }),
      makeEnv(database),
      { waitUntil: () => {} },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { configured: true });
    assert.equal(database.richMenuConfig.rich_menu_id, "richmenu-test");
    assert.equal(database.richMenuConfig.image_uploaded, 1);
    assert.equal(apiCalls.length, 3);
    assert.ok(apiCalls.at(-1).url.includes(`/user/${USER_ID}/richmenu/richmenu-test`));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

import { GeminiUnavailableError, parseMessage } from "./gemini.ts";
import {
  CATEGORIES,
  CATEGORY_CHART_COLORS,
  EXPENSES_PAGE_SIZE,
  FUNCTION_MENU_ACTIONS,
  MANUAL_EXPENSE_PATTERN,
  MAX_AMOUNT,
  MAX_MONTHLY_BUDGET,
  MONTHLY_LIST_PAGE_SIZE,
  PENDING_EDIT_TARGET_MINUTES,
  QUICK_EXPENSE_SESSION_TTL_MS,
  REPORT_NUMBER_FORMATTER,
} from "./shared.ts";
import { isDate, taipeiDate } from "./shared.ts";
import type {
  Env,
  Expense,
  ExpenseDeletionCriteria,
  ExpenseEditChanges,
  LineFlexComponent,
  LineFlexMessage,
  LineQuickReplyItem,
  LineReply,
  ParsedMessage,
  QuickExpenseSession,
} from "./shared.ts";

export async function handleMessage(text: string, userId: string, env: Env): Promise<LineReply> {
  const quickExpenseReply = await handleQuickExpenseFlow(text, userId, env);
  if (quickExpenseReply !== null) return quickExpenseReply;

  const modelStatus = await env.DB.prepare(
    "SELECT available, checked_at FROM bot_model_status WHERE user_id = ?",
  )
    .bind(userId)
    .first<{ available: number; checked_at: string }>();
  const modelUnavailable = modelStatus?.available === 0;
  const probeTime = modelStatus
    ? Date.parse(`${modelStatus.checked_at.replace(" ", "T")}Z`)
    : Number.NaN;
  const canProbe =
    !modelUnavailable || !Number.isFinite(probeTime) || Date.now() - probeTime >= 5 * 60 * 1000;

  if (modelUnavailable && !canProbe) {
    return runCommandFallback(text, userId, env, false);
  }

  let parsedMessage: ParsedMessage | undefined;
  let recoveryNotice = "";
  if (modelUnavailable) {
    try {
      parsedMessage = await parseMessage(text, userId, env);
      await setModelAvailability(userId, true, env);
      recoveryNotice = "模型已恢復，已自動回到模型優先模式。";
    } catch (error) {
      if (!(error instanceof GeminiUnavailableError)) {
        throw error;
      }
      await setModelAvailability(userId, false, env);
      return runCommandFallback(text, userId, env, false);
    }
  }

  const localReply = await handleLocalCommand(text, userId, env);
  if (localReply !== null) {
    return recoveryNotice ? addNotice(localReply, recoveryNotice) : localReply;
  }

  const pendingEditReply = await applyPendingEditAmountFollowUp(text, userId, env);
  if (pendingEditReply !== null) {
    return recoveryNotice ? addNotice(pendingEditReply, recoveryNotice) : pendingEditReply;
  }

  if (!parsedMessage) {
    try {
      parsedMessage = await parseMessage(text, userId, env);
    } catch (error) {
      if (!(error instanceof GeminiUnavailableError)) {
        throw error;
      }
      await setModelAvailability(userId, false, env);
      return runCommandFallback(text, userId, env, true);
    }
  }

  if (parsedMessage.intent === "unknown") {
    const manualExpense = parseManualExpenseCommand(text);
    if (manualExpense) {
      const reply = await savePendingExpense(userId, manualExpense, env);
      return recoveryNotice ? addNotice(reply, recoveryNotice) : reply;
    }
    const editRequest = parseEditTargetRequest(text);
    if (editRequest) {
      const reply = editRequest.criteria
        ? await requestExpenseEdit(userId, editRequest.criteria, undefined, env)
        : "請說明要編輯哪一筆，例如「編輯上一筆記帳」或「編輯 11/17 公車記帳」。";
      return recoveryNotice ? addNotice(reply, recoveryNotice) : reply;
    }
    await recordUnansweredQuestion(text, env);
  }

  const reply = await handleParsedMessage(parsedMessage, userId, env);
  return recoveryNotice ? addNotice(reply, recoveryNotice) : reply;
}

async function runCommandFallback(
  text: string,
  userId: string,
  env: Env,
  justFailed: boolean,
): Promise<LineReply> {
  const localReply = await handleLocalCommand(text, userId, env);
  if (localReply !== null) {
    return justFailed
      ? addNotice(localReply, "目前模型無法使用，已切換至指令記帳模式。")
      : localReply;
  }

  const pendingEditReply = await applyPendingEditAmountFollowUp(text, userId, env);
  if (pendingEditReply !== null) {
    return justFailed
      ? addNotice(pendingEditReply, "目前模型無法使用，已切換至指令記帳模式。")
      : pendingEditReply;
  }

  const manualExpense = parseManualExpenseCommand(text);
  if (manualExpense) {
    const reply = await savePendingExpense(userId, manualExpense, env);
    return addNotice(
      reply,
      justFailed
        ? "目前模型無法使用，已切換至指令記帳模式。"
        : "模型仍無法使用，已使用指令記帳模式。",
    );
  }

  const status = justFailed
    ? "目前模型無法使用，已切換至指令記帳模式。"
    : "模型仍無法使用，請先使用指令記帳。";
  return quickReplyMessage(
    `${status}\n${getManualCommandHelp()}`,
    [{ label: "指令格式", text: "指令格式" }, ...FUNCTION_MENU_ACTIONS],
  );
}

async function handleQuickExpenseFlow(
  text: string,
  userId: string,
  env: Env,
): Promise<LineReply | null> {
  let session = await getActiveQuickExpenseSession(userId, env);

  if (text === "快速記帳") {
    await saveQuickExpenseSession(userId, {
      step: "amount",
      amount: null,
      category: null,
      description: null,
      updated_at: "",
    }, env);
    return quickReplyMessage(
      "快速記帳 1/4：請輸入金額（新台幣整數）。",
      [{ label: "取消", text: "取消快速記帳" }],
    );
  }
  if (!session) return null;
  if (text === "取消快速記帳" || text === "取消") {
    await deleteQuickExpenseSession(userId, env);
    return "已取消快速記帳。";
  }

  if (session.step === "amount") {
    const completeInput = parseQuickExpenseInput(text);
    if (completeInput) {
      await deleteQuickExpenseSession(userId, env);
      return savePendingExpense(userId, completeInput, env);
    }
    const amount = /^\d{1,9}$/u.test(text) ? Number(text) : Number.NaN;
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_AMOUNT) {
      return quickReplyMessage(
        `金額請輸入 1 至 ${MAX_AMOUNT} 的整數。`,
        [{ label: "取消", text: "取消快速記帳" }],
      );
    }
    session = { ...session, step: "category", amount };
    await saveQuickExpenseSession(userId, session, env);
    return quickReplyMessage(
      `金額 NT$${amount}。請選擇類型：`,
      [
        ...CATEGORIES.map((category) => ({
          label: category,
          text: `快速記帳類型:${category}`,
        })),
        { label: "取消", text: "取消快速記帳" },
      ],
    );
  }

  if (session.step === "category") {
    const categoryText = text.startsWith("快速記帳類型:")
      ? text.slice("快速記帳類型:".length)
      : text;
    const category = CATEGORIES.find((item) => item === categoryText);
    if (!category) {
      return quickReplyMessage(
        "請使用下方按鈕選擇類型。",
        [
          ...CATEGORIES.map((item) => ({
            label: item,
            text: `快速記帳類型:${item}`,
          })),
          { label: "取消", text: "取消快速記帳" },
        ],
      );
    }
    session = { ...session, step: "description", category };
    await saveQuickExpenseSession(userId, session, env);
    return quickReplyMessage(
      `類型：${category}。請輸入品項，例如「午餐」或「公車」。`,
      [{ label: "取消", text: "取消快速記帳" }],
    );
  }

  if (session.step === "description") {
    const description = text.trim();
    if (!description || description.length > 100) {
      return quickReplyMessage(
        "品項請輸入 1 至 100 個字。",
        [{ label: "取消", text: "取消快速記帳" }],
      );
    }
    session = { ...session, step: "date", description };
    await saveQuickExpenseSession(userId, session, env);
    return quickExpenseDatePrompt();
  }

  const dateText = text.startsWith("快速記帳日期 ")
    ? text.slice("快速記帳日期 ".length)
    : text;
  const date = ["今天", "今日"].includes(dateText) ? taipeiDate() : dateText;
  if (!isDate(date)) return quickExpenseDatePrompt();
  return finishQuickExpenseSession(session, date, userId, env);
}

export async function handleQuickExpenseDatePostback(
  date: string | undefined,
  userId: string,
  env: Env,
): Promise<LineReply | null> {
  const session = await getActiveQuickExpenseSession(userId, env);
  if (!session || session.step !== "date") {
    return "快速記帳已逾時，請重新點選功能選單。";
  }
  if (!date || !isDate(date)) return quickExpenseDatePrompt();
  return finishQuickExpenseSession(session, date, userId, env);
}

function quickExpenseDatePrompt(): LineReply {
  return [
    {
      type: "text",
      text: "請選擇支出日期，或按「今天」使用今日日期；也可直接輸入 YYYY-MM-DD。",
      quickReply: {
        items: [
          {
            type: "action",
            action: {
              type: "datetimepicker",
              label: "選擇日期",
              data: "quick-expense-date",
              mode: "date",
              initial: taipeiDate(),
            },
          },
          ...makeQuickReplyItems([
            { label: "今天", text: "快速記帳日期 今天" },
            { label: "取消", text: "取消快速記帳" },
          ]),
        ],
      },
    },
  ];
}

async function finishQuickExpenseSession(
  session: QuickExpenseSession,
  date: string,
  userId: string,
  env: Env,
): Promise<LineReply> {
  if (
    session.amount === null ||
    session.category === null ||
    session.description === null
  ) {
    return "快速記帳資料不完整，請重新開始。";
  }
  const reply = await savePendingExpense(
    userId,
    {
      amount: session.amount,
      category: session.category,
      description: session.description,
      occurredAt: new Date(`${date}T12:00:00+08:00`).toISOString(),
    },
    env,
  );
  await deleteQuickExpenseSession(userId, env);
  return reply;
}

async function getQuickExpenseSession(
  userId: string,
  env: Env,
): Promise<QuickExpenseSession | null> {
  return env.DB.prepare(
    `SELECT step, amount, category, description, updated_at
     FROM quick_expense_sessions WHERE user_id = ?`,
  )
    .bind(userId)
    .first<QuickExpenseSession>();
}

async function getActiveQuickExpenseSession(
  userId: string,
  env: Env,
): Promise<QuickExpenseSession | null> {
  const session = await getQuickExpenseSession(userId, env);
  if (!session) return null;
  const age = Date.now() - Date.parse(`${session.updated_at.replace(" ", "T")}Z`);
  if (Number.isFinite(age) && age <= QUICK_EXPENSE_SESSION_TTL_MS) return session;
  await deleteQuickExpenseSession(userId, env);
  return null;
}

async function saveQuickExpenseSession(
  userId: string,
  session: QuickExpenseSession,
  env: Env,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO quick_expense_sessions
       (user_id, step, amount, category, description, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       step = excluded.step,
       amount = excluded.amount,
       category = excluded.category,
       description = excluded.description,
       updated_at = datetime('now')`,
  )
    .bind(userId, session.step, session.amount, session.category, session.description)
    .run();
}

async function deleteQuickExpenseSession(userId: string, env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM quick_expense_sessions WHERE user_id = ?")
    .bind(userId)
    .run();
}

export async function recordUnansweredQuestion(question: string, env: Env): Promise<void> {
  const month = taipeiDate().slice(0, 7);
  // 只有明確確認才會新增正式記帳，並在同一批次清除草稿避免重複確認。
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM unanswered_questions
       WHERE strftime('%Y-%m', datetime(created_at, '+8 hours')) < ?`,
    ).bind(month),
    env.DB.prepare("INSERT INTO unanswered_questions (question) VALUES (?)").bind(question),
  ]);
}

async function setModelAvailability(userId: string, available: boolean, env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO bot_model_status (user_id, available, checked_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       available = excluded.available,
       checked_at = excluded.checked_at`,
  )
    .bind(userId, available ? 1 : 0)
    .run();
}

function addNotice(reply: LineReply, notice: string): LineReply {
  return typeof reply === "string"
    ? `${notice}\n${reply}`
    : [{ type: "text", text: notice }, ...reply];
}

function quickReplyMessage(
  text: string,
  actions: { label: string; text: string }[],
): LineReply {
  return [
    {
      type: "text",
      text,
      quickReply: {
        items: makeQuickReplyItems(actions),
      },
    },
  ];
}

function makeQuickReplyItems(actions: { label: string; text: string }[]): LineQuickReplyItem[] {
  return actions.map((action) => ({
    type: "action",
    action: { type: "message", label: action.label, text: action.text },
  }));
}

async function handleLocalCommand(
  text: string,
  userId: string,
  env: Env,
): Promise<LineReply | null> {
  const command = text.toLowerCase();
  if (["選單", "功能選單", "menu"].includes(command)) {
    return quickReplyMessage("請選擇功能：", FUNCTION_MENU_ACTIONS);
  }
  if (text === "指令格式") return getManualCommandHelp();
  if (["說明", "help", "幫助"].includes(command)) {
    return quickReplyMessage(
      [
        "📒 記帳：直接說「午餐 120」，再按確認或取消。",
        "📋 查詢：可看本月明細、每月類別長條圖或最近紀錄。",
        "✏️ 編輯：說「修改記帳」開始，或說「把昨天午餐改成 150 元」。",
        "🗑️ 刪除：說「刪除昨天午餐」，確認後可在 5 分鐘內按復原。",
        "💰 預算：說「本月預算 15000」設定或查詢。",
        "⚡ 輸入「功能選單」或點聊天室選單，可快速記帳、修改、看明細及圖表。",
        "🧾 模型無法使用時，輸入「指令格式」查看備用記帳格式。",
      ].join("\n"),
      FUNCTION_MENU_ACTIONS,
    );
  }
  if (text === "取消快速記帳") return "已取消快速記帳。";
  if (text === "修改記帳") {
    return quickReplyMessage(
      "可直接描述修改內容，例如「把昨天午餐改成 150 元」；也可先選一筆紀錄再輸入新金額。",
      [
        { label: "編輯上一筆", text: "編輯上一筆記帳" },
        { label: "取消", text: "取消修改" },
      ],
    );
  }
  const quickExpense = parseQuickExpenseInput(text);
  if (quickExpense) return savePendingExpense(userId, quickExpense, env);
  if (text === "確認刪除") return confirmPendingExpenseDeletion(userId, env);
  if (text === "取消刪除") return cancelPendingExpenseDeletion(userId, env);
  if (text === "確認修改") return confirmPendingExpenseEdit(userId, env);
  if (text === "取消修改") return cancelPendingExpenseEdit(userId, env);
  if (text === "復原刪除") {
    return (await restoreExpense(userId, env))
      ? "已復原最近刪除的記帳。"
      : "沒有可復原的記帳（復原期限為 5 分鐘）。";
  }
  if (["確認", "是", "存檔"].includes(text)) return confirmPendingExpense(userId, env);
  if (["取消", "不要"].includes(text)) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM pending_expenses WHERE user_id = ?").bind(userId),
      env.DB.prepare("DELETE FROM pending_expense_edits WHERE user_id = ?").bind(userId),
      env.DB.prepare("DELETE FROM pending_expense_edit_targets WHERE user_id = ?").bind(userId),
    ]);
    return "已取消待確認的操作。";
  }
  if (["最近", "紀錄", "記錄", "最近紀錄"].includes(text)) {
    return listRecentExpenses(userId, env);
  }
  if (
    ["本月列表", "本月記帳", "本月記帳列表", "本月明細", "本月支出明細"].includes(
      text,
    )
  ) {
    return getMonthlyExpensesPage(userId, 0, env);
  }
  if (["本月", "月結", "本月支出"].includes(text)) return getMonthlyTotal(userId, env);
  if (
    [
      "圖表",
      "長條圖",
      "本月圖表",
      "類別支出",
      "本月類別支出",
      "本月支出長條圖",
      "分類統計",
    ].includes(text)
  ) {
    return getCategoryChartReply(userId, env);
  }
  if (["預算", "本月預算"].includes(text)) return getBudgetSummary(userId, env);

  const budgetMatch = /^(?:設定)?(?:本月)?預算\s+(\d+)$/u.exec(text);
  if (budgetMatch) return setMonthlyBudget(userId, Number(budgetMatch[1]), env);

  const rangeMatch = /^查詢\s+(\d{4}-\d{2}-\d{2})\s*(?:至|到|~)\s*(\d{4}-\d{2}-\d{2})$/u.exec(
    text,
  );
  if (rangeMatch) {
    return getExpenseSearchPage(userId, rangeMatch[1], rangeMatch[2], null, 0, env);
  }
  if (["下一頁", "下頁"].includes(text)) return changeExpensePage(userId, 1, env);
  if (["上一頁", "上頁"].includes(text)) return changeExpensePage(userId, -1, env);
  return null;
}

function getManualCommandHelp(): string {
  return [
    "指令記帳格式：",
    "指令記帳 金額 類型 品項 [YYYY-MM-DD]",
    "例：指令記帳 120 餐飲 午餐",
    "例：指令記帳 45 交通 公車 2026-11-16",
    `類型：${CATEGORIES.join("、")}。日期可省略，預設今天。`,
    "送出後按「確認記帳」才會保存；按「取消」不會記帳。",
  ].join("\n");
}

function parseManualExpenseCommand(text: string): Expense | null {
  const match = MANUAL_EXPENSE_PATTERN.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  const description = match[3].trim();
  const date = match[4] ?? taipeiDate();
  if (
    !Number.isSafeInteger(amount) ||
    amount < 1 ||
    amount > MAX_AMOUNT ||
    !description ||
    description.length > 100 ||
    !isDate(date)
  ) {
    return null;
  }
  return {
    amount,
    category: match[2],
    description,
    occurredAt: new Date(`${date}T12:00:00+08:00`).toISOString(),
  };
}

function parseQuickExpenseInput(text: string): Expense | null {
  const value = text.startsWith("快速記帳 ") ? text.slice("快速記帳 ".length) : text;
  if (!/^\d{1,9}\s/u.test(value)) return null;
  return parseManualExpenseCommand(`指令記帳 ${value}`);
}

async function savePendingExpense(
  userId: string,
  expense: Expense,
  env: Env,
): Promise<LineReply> {
  await env.DB.prepare(
    `INSERT INTO pending_expenses (user_id, amount, category, description, occurred_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       amount = excluded.amount,
       category = excluded.category,
       description = excluded.description,
       occurred_at = excluded.occurred_at`,
  )
    .bind(userId, expense.amount, expense.category, expense.description, expense.occurredAt)
    .run();

  return quickReplyMessage(
    `請確認這筆記帳：\n${expense.occurredAt.slice(0, 10)}｜${expense.category}｜${expense.description}｜NT$${expense.amount}`,
    [
      { label: "確認記帳", text: "確認" },
      { label: "取消", text: "取消" },
    ],
  );
}

async function handleParsedMessage(
  parsedMessage: ParsedMessage,
  userId: string,
  env: Env,
): Promise<LineReply> {
  if (parsedMessage.intent === "recent_expenses") return listRecentExpenses(userId, env);
  if (parsedMessage.intent === "monthly_total") return getMonthlyTotal(userId, env);
  if (parsedMessage.intent === "monthly_list") return getMonthlyExpensesPage(userId, 0, env);
  if (parsedMessage.intent === "category_summary") return getCategoryChartReply(userId, env);
  if (parsedMessage.intent === "budget_query") return getBudgetSummary(userId, env);
  if (parsedMessage.intent === "budget_set") {
    return setMonthlyBudget(userId, parsedMessage.amount, env);
  }
  if (parsedMessage.intent === "expense_search") {
    return getExpenseSearchPage(
      userId,
      parsedMessage.startDate,
      parsedMessage.endDate,
      parsedMessage.category ?? null,
      0,
      env,
    );
  }
  if (parsedMessage.intent === "delete_expense") {
    return requestExpenseDeletion(userId, parsedMessage.criteria, env);
  }
  if (parsedMessage.intent === "edit_expense") {
    return requestExpenseEdit(userId, parsedMessage.criteria, parsedMessage.changes, env);
  }
  if (parsedMessage.intent === "help") {
    return handleLocalCommand("說明", userId, env).then((reply) => reply ?? "");
  }
  if (parsedMessage.intent === "unknown") {
    return "我無法判斷這筆訊息。可試「午餐 120」或輸入「說明」。";
  }
  return savePendingExpense(userId, parsedMessage.expense, env);
}

async function findExpenseMatches(
  userId: string,
  criteria: ExpenseDeletionCriteria,
  env: Env,
): Promise<ExpenseMatch[]> {
  if (
    !criteria.latest &&
    !criteria.description &&
    !criteria.category &&
    criteria.amount === undefined &&
    !criteria.date
  ) {
    return [];
  }

  let query =
    `SELECT id, amount, category, description, occurred_at
     FROM expenses WHERE user_id = ?`;
  const bindings: (string | number)[] = [userId];
  if (criteria.description) {
    query += " AND instr(lower(description), lower(?)) > 0";
    bindings.push(criteria.description);
  }
  if (criteria.category) {
    query += " AND category = ?";
    bindings.push(criteria.category);
  }
  if (criteria.amount !== undefined) {
    query += " AND amount = ?";
    bindings.push(criteria.amount);
  }
  if (criteria.date) {
    query += " AND substr(occurred_at, 1, 10) = ?";
    bindings.push(criteria.date);
  }
  query += ` ORDER BY occurred_at DESC, id DESC LIMIT ${criteria.latest ? 1 : 6}`;
  const { results } = await env.DB.prepare(query)
    .bind(...bindings)
    .all<ExpenseMatch>();
  return results;
}

interface ExpenseMatch {
  id: number;
  amount: number;
  category: string;
  description: string;
  occurred_at: string;
}

function formatExpenseMatch(expense: ExpenseMatch): string {
  return `${expense.occurred_at.slice(0, 10)}｜${expense.category}｜${expense.description}｜NT$${expense.amount}`;
}

async function requestExpenseDeletion(
  userId: string,
  criteria: ExpenseDeletionCriteria,
  env: Env,
): Promise<LineReply> {
  const results = await findExpenseMatches(userId, criteria, env);
  if (results.length === 0) {
    return "找不到符合條件的記帳，請補充品項、日期或金額再試一次。";
  }
  if (results.length > 1) {
    return [
      "找到多筆符合的記帳，為避免誤刪，請補充日期、品項或金額：",
      ...results.slice(0, 5).map(formatExpenseMatch),
    ].join("\n");
  }

  const expense = results[0];
  await env.DB.prepare(
    `INSERT INTO pending_expense_deletions (user_id, expense_id)
     VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET expense_id = excluded.expense_id`,
  )
    .bind(userId, expense.id)
    .run();
  return quickReplyMessage(
    `找到這筆記帳：\n${formatExpenseMatch(expense)}\n請選擇是否刪除。`,
    [
      { label: "確認刪除", text: "確認刪除" },
      { label: "取消", text: "取消刪除" },
    ],
  );
}

async function requestExpenseEdit(
  userId: string,
  criteria: ExpenseDeletionCriteria,
  changes: ExpenseEditChanges | undefined,
  env: Env,
): Promise<LineReply> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pending_expense_edits WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM pending_expense_edit_targets WHERE user_id = ?").bind(userId),
  ]);
  const results = await findExpenseMatches(userId, criteria, env);
  if (results.length === 0) {
    return "找不到符合條件的記帳，請補充品項、日期或金額再試一次。";
  }
  if (results.length > 1) {
    return [
      "找到多筆符合的記帳，為避免修改錯誤，請補充日期、品項或金額：",
      ...results.slice(0, 5).map(formatExpenseMatch),
    ].join("\n");
  }

  const expense = results[0];
  if (!changes) return beginExpenseEdit(userId, expense, env);
  return stageExpenseEdit(userId, expense, changes, env);
}

async function beginExpenseEdit(
  userId: string,
  expense: ExpenseMatch,
  env: Env,
): Promise<LineReply> {
  await env.DB.prepare(
    `INSERT INTO pending_expense_edit_targets (user_id, expense_id, created_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       expense_id = excluded.expense_id,
       created_at = excluded.created_at`,
  )
    .bind(userId, expense.id)
    .run();
  return quickReplyMessage(
    `已找到要編輯的紀錄：\n${formatExpenseMatch(expense)}\n請直接回覆新金額，例如「改成 150 元」。`,
    [{ label: "取消修改", text: "取消修改" }],
  );
}

async function stageExpenseEdit(
  userId: string,
  expense: ExpenseMatch,
  changes: ExpenseEditChanges,
  env: Env,
): Promise<LineReply> {
  const next = {
    amount: changes.amount ?? expense.amount,
    category: changes.category ?? expense.category,
    description: changes.description ?? expense.description,
    occurredAt: changes.date
      ? new Date(`${changes.date}T12:00:00+08:00`).toISOString()
      : expense.occurred_at,
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO pending_expense_edits
        (user_id, expense_id, amount, category, description, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         expense_id = excluded.expense_id,
         amount = excluded.amount,
         category = excluded.category,
         description = excluded.description,
         occurred_at = excluded.occurred_at`,
    ).bind(userId, expense.id, next.amount, next.category, next.description, next.occurredAt),
    env.DB.prepare("DELETE FROM pending_expense_edit_targets WHERE user_id = ?").bind(userId),
  ]);
  return quickReplyMessage(
    `請確認修改：\n原紀錄：${formatExpenseMatch(expense)}\n修改為：${next.occurredAt.slice(0, 10)}｜${next.category}｜${next.description}｜NT$${next.amount}`,
    [
      { label: "確認修改", text: "確認修改" },
      { label: "取消", text: "取消修改" },
    ],
  );
}

async function applyPendingEditAmountFollowUp(
  text: string,
  userId: string,
  env: Env,
): Promise<LineReply | null> {
  const amount = parseEditAmountFollowUp(text);
  if (amount === null) return null;
  const target = await env.DB.prepare(
    `SELECT expenses.id, expenses.amount, expenses.category, expenses.description,
            expenses.occurred_at, pending_expense_edit_targets.created_at
     FROM pending_expense_edit_targets
     JOIN expenses
       ON expenses.id = pending_expense_edit_targets.expense_id
      AND expenses.user_id = pending_expense_edit_targets.user_id
     WHERE pending_expense_edit_targets.user_id = ?`,
  )
    .bind(userId)
    .first<ExpenseMatch & { created_at: string }>();
  if (!target) return null;
  const createdAt = Date.parse(`${target.created_at.replace(" ", "T")}Z`);
  if (
    !Number.isFinite(createdAt) ||
    Date.now() - createdAt > PENDING_EDIT_TARGET_MINUTES * 60 * 1000
  ) {
    await env.DB.prepare("DELETE FROM pending_expense_edit_targets WHERE user_id = ?")
      .bind(userId)
      .run();
    return "這次修改已逾時，請重新說明要編輯哪筆記帳。";
  }
  if (amount < 1 || amount > MAX_AMOUNT) {
    return `金額需介於 NT$1 至 NT$${MAX_AMOUNT}，請再輸入一次。`;
  }
  return stageExpenseEdit(userId, target, { amount }, env);
}

function parseEditAmountFollowUp(text: string): number | null {
  let value = text.trim();
  if (!value || value.length > 100) return null;

  const prefixes = [
    "金額改成", "金額改為", "金額是", "金額為", "金額應該是", "金額應為", "金額",
    "改成", "改為", "改到", "更正為", "更正成", "調整為", "設為",
    "應該是", "應為", "其實是", "是",
  ];
  for (const prefix of prefixes) {
    if (value.startsWith(prefix)) {
      value = value.slice(prefix.length).trim();
      break;
    }
  }

  for (const prefix of ["NT$", "NTD", "新台幣"]) {
    if (value.startsWith(prefix)) {
      value = value.slice(prefix.length).trim();
      break;
    }
  }
  for (const suffix of ["元整", "元", "塊"]) {
    if (value.endsWith(suffix)) {
      value = value.slice(0, -suffix.length).trim();
      break;
    }
  }
  if (!value) return null;

  let digits = value;
  if (value.includes(",")) {
    const groups = value.split(",");
    if (
      groups.length < 2 ||
      groups[0].length < 1 ||
      groups[0].length > 3 ||
      groups.slice(1).some((group) => group.length !== 3)
    ) {
      return null;
    }
    digits = value.replace(/,/g, "");
  }
  if (!digits || digits.length > 16 || [...digits].some((character) => character < "0" || character > "9")) {
    return null;
  }
  const amount = Number(digits);
  return Number.isSafeInteger(amount) ? amount : null;
}

function containsAmountMention(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] < "0" || text[index] > "9") continue;
    let cursor = index;
    while (cursor < text.length && text[cursor] >= "0" && text[cursor] <= "9") {
      cursor += 1;
    }
    while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1;
    if (text[cursor] === "元" || text[cursor] === "塊") return true;
    index = cursor - 1;
  }
  return false;
}

function parseEditTargetRequest(
  text: string,
): { criteria: ExpenseDeletionCriteria | null } | null {
  let value = text.trim();
  if (!value || value.length > 200) return null;
  for (const prefix of ["請", "幫我", "可以"]) {
    if (value.startsWith(prefix)) {
      value = value.slice(prefix.length).trimStart();
      break;
    }
  }
  let commandLength = 0;
  for (const command of ["編輯", "修改", "更正", "修正"]) {
    if (value.startsWith(command)) {
      commandLength = command.length;
      break;
    }
  }
  if (!commandLength) return null;
  const target = value.slice(commandLength).trim();
  if (
    containsAmountMention(target) ||
    target.includes("改成") ||
    target.includes("改為") ||
    target.includes("改到") ||
    target.includes("更正為") ||
    target.includes("調整為") ||
    !target
  ) {
    return target ? null : { criteria: null };
  }

  const latest = /(?:上一筆|最後一筆|最近一筆)/u.test(target);
  const datePattern = /(?:(\d{4})[/-])?(\d{1,2})[/-](\d{1,2})/u;
  const dateMatch = datePattern.exec(target);
  let date: string | undefined;
  if (dateMatch) {
    const year = dateMatch[1] ?? taipeiDate().slice(0, 4);
    date = `${year}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`;
    if (!isDate(date)) return { criteria: null };
  }

  let description = target.replace(datePattern, " ");
  description = description
    .replace(/(?:上一筆|最後一筆|最近一筆|記帳|紀錄|記錄|帳目|支出|消費|的|那筆|這筆)/gu, " ")
    .trim();
  const category = CATEGORIES.find((candidate) => description.includes(candidate));
  if (category) description = description.replace(category, " ").trim();
  description = description.replace(/^[，,、：:\s]+|[，,、：:\s]+$/gu, "").trim();

  const criteria: ExpenseDeletionCriteria = {
    ...(description ? { description } : {}),
    ...(category ? { category } : {}),
    ...(date ? { date } : {}),
    latest,
  };
  return {
    criteria:
      criteria.latest || criteria.description || criteria.category || criteria.date
        ? criteria
        : null,
  };
}

async function confirmPendingExpenseEdit(userId: string, env: Env): Promise<LineReply> {
  const pending = await env.DB.prepare(
    `SELECT expense_id, amount, category, description, occurred_at
     FROM pending_expense_edits WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{
      expense_id: number;
      amount: number;
      category: string;
      description: string;
      occurred_at: string;
    }>();
  if (!pending) return "目前沒有待確認的修改。";
  const [updated] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE expenses SET amount = ?, category = ?, description = ?, occurred_at = ?
       WHERE id = ? AND user_id = ?`,
    ).bind(
      pending.amount,
      pending.category,
      pending.description,
      pending.occurred_at,
      pending.expense_id,
      userId,
    ),
    env.DB.prepare("DELETE FROM pending_expense_edits WHERE user_id = ?").bind(userId),
  ]);
  if (updated.meta.changes === 0) return "原記帳已不存在，沒有修改任何資料。";
  const alerts = await getBudgetAlerts(userId, pending.occurred_at.slice(0, 7), env);
  return [`已修改：${pending.description} NT$${pending.amount}（${pending.category}）。`, ...alerts].join(
    "\n",
  );
}

async function cancelPendingExpenseEdit(userId: string, env: Env): Promise<string> {
  const [draft, target] = await env.DB.batch([
    env.DB.prepare("DELETE FROM pending_expense_edits WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM pending_expense_edit_targets WHERE user_id = ?").bind(userId),
  ]);
  return draft.meta.changes + target.meta.changes > 0
    ? "已取消修改，原記帳仍保留。"
    : "目前沒有待取消的修改項目。";
}

async function confirmPendingExpense(userId: string, env: Env): Promise<LineReply> {
  const pending = await env.DB.prepare(
    `SELECT amount, category, description, occurred_at
     FROM pending_expenses WHERE user_id = ?`,
  )
    .bind(userId)
    .first<Omit<Expense, "occurredAt"> & { occurred_at: string }>();

  if (!pending) {
    return "目前沒有待確認的記帳。";
  }

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO expenses (user_id, amount, category, description, occurred_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(userId, pending.amount, pending.category, pending.description, pending.occurred_at),
    env.DB.prepare("DELETE FROM pending_expenses WHERE user_id = ?").bind(userId),
  ]);
  const alerts = await getBudgetAlerts(userId, pending.occurred_at.slice(0, 7), env);
  return [
    `已記帳：${pending.description} NT$${pending.amount}（${pending.category}）。`,
    ...alerts,
  ].join("\n");
}

async function confirmPendingExpenseDeletion(userId: string, env: Env): Promise<LineReply> {
  const pending = await env.DB.prepare(
    `SELECT expenses.id, expenses.amount, expenses.category, expenses.description,
            expenses.occurred_at
     FROM pending_expense_deletions
     JOIN expenses
       ON expenses.id = pending_expense_deletions.expense_id
      AND expenses.user_id = pending_expense_deletions.user_id
     WHERE pending_expense_deletions.user_id = ?`,
  )
    .bind(userId)
    .first<ExpenseMatch>();

  if (!pending) {
    await env.DB.prepare("DELETE FROM pending_expense_deletions WHERE user_id = ?")
      .bind(userId)
      .run();
    return "目前沒有待確認的刪除項目。";
  }

  const [, deletion] = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR REPLACE INTO expense_undo
        (user_id, expense_id, amount, category, description, occurred_at, created_at)
       SELECT user_id, id, amount, category, description, occurred_at, datetime('now')
       FROM expenses WHERE id = ? AND user_id = ?`,
    ).bind(pending.id, userId),
    env.DB.prepare(
      `DELETE FROM expenses
       WHERE id = ? AND user_id = ?
         AND EXISTS (
           SELECT 1 FROM pending_expense_deletions
           WHERE user_id = ? AND expense_id = ?
         )`,
    ).bind(pending.id, userId, userId, pending.id),
    env.DB.prepare(
      "DELETE FROM pending_expense_deletions WHERE user_id = ? AND expense_id = ?",
    ).bind(userId, pending.id),
  ]);
  if (deletion.meta.changes === 0) {
    return "這筆記帳已不存在，沒有刪除任何資料。";
  }
  return quickReplyMessage(
    `已刪除：${pending.description} NT$${pending.amount}（${pending.category}）。可在 5 分鐘內復原。`,
    [{ label: "復原刪除", text: "復原刪除" }],
  );
}

async function cancelPendingExpenseDeletion(userId: string, env: Env): Promise<string> {
  const result = await env.DB.prepare("DELETE FROM pending_expense_deletions WHERE user_id = ?")
    .bind(userId)
    .run();
  return result.meta.changes > 0 ? "已取消刪除，記帳仍保留。" : "目前沒有待取消的刪除項目。";
}

async function listRecentExpenses(userId: string, env: Env): Promise<string> {
  const { results } = await env.DB.prepare(
    `SELECT amount, category, description, occurred_at
     FROM expenses WHERE user_id = ?
     ORDER BY occurred_at DESC, id DESC LIMIT 5`,
  )
    .bind(userId)
    .all<{ amount: number; category: string; description: string; occurred_at: string }>();

  if (results.length === 0) {
    return "還沒有記帳紀錄。";
  }

  return results
    .map(
      (row) =>
        `${row.occurred_at.slice(0, 10)}｜${row.category}｜${row.description}｜NT$${row.amount}`,
    )
    .join("\n");
}

async function getExpenseSearchPage(
  userId: string,
  from: string,
  to: string,
  category: string | null,
  requestedPage: number,
  env: Env,
): Promise<LineReply> {
  if (!isDate(from) || !isDate(to) || from > to) {
    return "日期區間無效，請使用 YYYY-MM-DD，例如「查詢 2026-10-01 至 2026-10-31」。";
  }
  const categoryFilter = category ? " AND category = ?" : "";
  const bindings: (string | number)[] = [userId, from, to];
  if (category) bindings.push(category);
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM expenses
     WHERE user_id = ? AND substr(occurred_at, 1, 10) BETWEEN ? AND ?${categoryFilter}`,
  )
    .bind(...bindings)
    .first<{ count: number }>();
  const totalCount = count?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / EXPENSES_PAGE_SIZE));
  const page = Math.max(0, Math.min(requestedPage, totalPages - 1));
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO expense_query_sessions (user_id, start_date, end_date, category, page)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         start_date = excluded.start_date,
         end_date = excluded.end_date,
         category = excluded.category,
         page = excluded.page`,
    ).bind(userId, from, to, category, page),
    env.DB.prepare("DELETE FROM monthly_expense_list_sessions WHERE user_id = ?").bind(userId),
  ]);

  if (totalCount === 0) return "這段日期區間沒有記帳紀錄。";
  const { results } = await env.DB.prepare(
    `SELECT id, amount, category, description, occurred_at
     FROM expenses
     WHERE user_id = ? AND substr(occurred_at, 1, 10) BETWEEN ? AND ?${categoryFilter}
     ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...bindings, EXPENSES_PAGE_SIZE, page * EXPENSES_PAGE_SIZE)
    .all<ExpenseMatch>();
  const lines = results.map((expense) => formatExpenseMatch(expense));
  const actions: { label: string; text: string }[] = [];
  if (page > 0) actions.push({ label: "上一頁", text: "上一頁" });
  if (page + 1 < totalPages) actions.push({ label: "下一頁", text: "下一頁" });
  return quickReplyMessage(
    `${from} 至 ${to}（${category ?? "全部類別"}）第 ${page + 1}/${totalPages} 頁，共 ${totalCount} 筆：\n${lines.join("\n")}`,
    actions,
  );
}

async function getMonthlyExpensesPage(
  userId: string,
  requestedPage: number,
  env: Env,
): Promise<LineReply> {
  const month = taipeiDate().slice(0, 7);
  const summary = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
     FROM expenses WHERE user_id = ? AND substr(occurred_at, 1, 7) = ?`,
  )
    .bind(userId, month)
    .first<{ total: number; count: number }>();
  const totalCount = summary?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / MONTHLY_LIST_PAGE_SIZE));
  const page = Math.max(0, Math.min(requestedPage, totalPages - 1));
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO monthly_expense_list_sessions (user_id, page)
       VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET page = excluded.page`,
    ).bind(userId, page),
    env.DB.prepare("DELETE FROM expense_query_sessions WHERE user_id = ?").bind(userId),
  ]);
  const { results } = await env.DB.prepare(
    `SELECT id, amount, category, description, occurred_at
     FROM expenses
     WHERE user_id = ? AND substr(occurred_at, 1, 7) = ?
     ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`,
  )
    .bind(userId, month, MONTHLY_LIST_PAGE_SIZE, page * MONTHLY_LIST_PAGE_SIZE)
    .all<ExpenseMatch>();
  const formatter = REPORT_NUMBER_FORMATTER;
  const actions: { label: string; text: string }[] = [];
  if (page > 0) actions.push({ label: "上一頁", text: "上一頁" });
  if (page + 1 < totalPages) actions.push({ label: "下一頁", text: "下一頁" });
  const contents: LineFlexComponent[] = [
    { type: "text", text: `${month} 本月記帳`, size: "lg", weight: "bold" },
    {
      type: "box",
      layout: "horizontal",
      spacing: "sm",
      backgroundColor: "#eaf4f0",
      cornerRadius: "md",
      paddingAll: "md",
      contents: [
        { type: "text", text: `共 ${totalCount} 筆`, size: "sm", color: "#176b58", flex: 2 },
        {
          type: "text",
          text: `合計 NT$${formatter.format(summary?.total ?? 0)}`,
          size: "md",
          weight: "bold",
          color: "#176b58",
          align: "end",
          flex: 3,
        },
      ],
    },
    {
      type: "text",
      text: totalCount > 0 ? `第 ${page + 1} / ${totalPages} 頁` : "本月還沒有記帳紀錄",
      size: "xs",
      color: "#64727d",
    },
  ];
  for (const [index, expense] of results.entries()) {
    contents.push(
      {
        type: "box",
        layout: "horizontal",
        spacing: "sm",
        contents: [
          {
            type: "box",
            layout: "vertical",
            flex: 3,
            spacing: "xs",
            contents: [
              {
                type: "text",
                text: expense.occurred_at.slice(0, 10),
                size: "xs",
                color: "#64727d",
              },
              {
                type: "text",
                text: expense.category,
                size: "sm",
                weight: "bold",
                color:
                  CATEGORY_CHART_COLORS[
                    Math.max(
                      0,
                      CATEGORIES.indexOf(expense.category as (typeof CATEGORIES)[number]),
                    )
                  ],
              },
            ],
          },
          {
            type: "text",
            text: expense.description,
            size: "sm",
            weight: "bold",
            flex: 5,
            wrap: true,
          },
          {
            type: "text",
            text: `NT$${formatter.format(expense.amount)}`,
            size: "sm",
            weight: "bold",
            align: "end",
            flex: 3,
            wrap: true,
          },
        ],
      },
      ...(index < results.length - 1
        ? [{ type: "separator" as const, margin: "sm", color: "#edf1f3" }]
        : []),
    );
  }
  const flexMessage: LineFlexMessage = {
    type: "flex",
    altText: `${month} 本月記帳 ${totalCount} 筆，合計 NT$${formatter.format(summary?.total ?? 0)}`,
    ...(actions.length > 0 ? { quickReply: { items: makeQuickReplyItems(actions) } } : {}),
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        paddingAll: "lg",
        contents,
      },
    },
  };
  return [flexMessage];
}

async function changeExpensePage(
  userId: string,
  direction: -1 | 1,
  env: Env,
): Promise<LineReply> {
  const monthlySession = await env.DB.prepare(
    "SELECT page FROM monthly_expense_list_sessions WHERE user_id = ?",
  )
    .bind(userId)
    .first<{ page: number }>();
  if (monthlySession) {
    return getMonthlyExpensesPage(userId, monthlySession.page + direction, env);
  }
  const session = await env.DB.prepare(
    `SELECT start_date, end_date, category, page
     FROM expense_query_sessions WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ start_date: string; end_date: string; category: string | null; page: number }>();
  if (!session) return "請先查詢日期區間，例如「查詢 2026-10-01 至 2026-10-31」。";
  return getExpenseSearchPage(
    userId,
    session.start_date,
    session.end_date,
    session.category,
    session.page + direction,
    env,
  );
}

async function getMonthlyBudget(userId: string, month: string, env: Env): Promise<number | null> {
  const result = await env.DB.prepare(
    "SELECT amount FROM monthly_budgets WHERE user_id = ? AND month = ?",
  )
    .bind(userId, month)
    .first<{ amount: number }>();
  return result?.amount ?? null;
}

async function getBudgetSummary(userId: string, env: Env): Promise<string> {
  const month = taipeiDate().slice(0, 7);
  const [budget, total] = await Promise.all([
    getMonthlyBudget(userId, month, env),
    env.DB.prepare(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE user_id = ? AND substr(occurred_at, 1, 7) = ?",
    )
      .bind(userId, month)
      .first<{ total: number }>(),
  ]);
  if (budget === null) return `${month} 尚未設定預算。可輸入「預算 15000」設定。`;
  const spent = total?.total ?? 0;
  const percent = Math.floor((spent / budget) * 100);
  return `${month} 預算 NT$${budget}，已支出 NT$${spent}（${percent}%）。`;
}

async function setMonthlyBudget(
  userId: string,
  amount: number,
  env: Env,
): Promise<string> {
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_MONTHLY_BUDGET) {
    return `預算需介於 NT$1 至 NT$${MAX_MONTHLY_BUDGET}。`;
  }
  const month = taipeiDate().slice(0, 7);
  await env.DB.prepare(
    `INSERT INTO monthly_budgets (user_id, month, amount)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id, month) DO UPDATE SET
       amount = excluded.amount,
       alert_80_sent = 0,
       alert_100_sent = 0`,
  )
    .bind(userId, month, amount)
    .run();
  const summary = await getBudgetSummary(userId, env);
  const alerts = await getBudgetAlerts(userId, month, env);
  return [summary, ...alerts].join("\n");
}

async function getBudgetAlerts(userId: string, month: string, env: Env): Promise<string[]> {
  const [budget, expenses] = await Promise.all([
    getMonthlyBudget(userId, month, env),
    env.DB.prepare(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE user_id = ? AND substr(occurred_at, 1, 7) = ?",
    )
      .bind(userId, month)
      .first<{ total: number }>(),
  ]);
  if (budget === null) return [];
  const total = expenses?.total ?? 0;
  const alerts: string[] = [];
  if (total * 100 >= budget * 80) {
    const result = await env.DB.prepare(
      `UPDATE monthly_budgets SET alert_80_sent = 1
       WHERE user_id = ? AND month = ? AND alert_80_sent = 0`,
    )
      .bind(userId, month)
      .run();
    if (result.meta.changes > 0) alerts.push(`提醒：本月支出已達預算 80%（NT$${total} / NT$${budget}）。`);
  }
  if (total >= budget) {
    const result = await env.DB.prepare(
      `UPDATE monthly_budgets SET alert_100_sent = 1
       WHERE user_id = ? AND month = ? AND alert_100_sent = 0`,
    )
      .bind(userId, month)
      .run();
    if (result.meta.changes > 0) alerts.push(`提醒：本月支出已達或超過預算（NT$${total} / NT$${budget}）。`);
  }
  return alerts;
}

async function getCategoryChartReply(userId: string, env: Env): Promise<LineReply> {
  const month = taipeiDate().slice(0, 7);
  const categories = await getMonthlyCategoryAmounts(userId, month, env);
  const total = categories.reduce((sum, item) => sum + item.amount, 0);
  const maximum = Math.max(...categories.map((item) => item.amount), 1);
  const amountFormatter = REPORT_NUMBER_FORMATTER;
  const rows: LineFlexComponent[] = categories.flatMap((item, index) => {
    const filled = item.amount === 0 ? 0 : Math.max(1, Math.round((item.amount / maximum) * 100));
    const remaining = Math.max(1, 100 - filled);
    return [
      {
        type: "box" as const,
        layout: "horizontal" as const,
        spacing: "sm",
        contents: [
          { type: "text" as const, text: item.category, size: "sm" as const, flex: 3 },
          {
            type: "text" as const,
            text: `NT$${amountFormatter.format(item.amount)}`,
            size: "sm" as const,
            align: "end" as const,
            flex: 4,
          },
        ],
      },
      {
        type: "box" as const,
        layout: "horizontal" as const,
        spacing: "none",
        contents: [
          {
            type: "box" as const,
            layout: "horizontal" as const,
            flex: filled,
            height: "8px",
            backgroundColor: CATEGORY_CHART_COLORS[index],
            cornerRadius: "4px",
            contents: [{ type: "text" as const, text: " ", size: "sm" as const }],
          },
          {
            type: "box" as const,
            layout: "horizontal" as const,
            flex: remaining,
            height: "8px",
            backgroundColor: "#edf1f3",
            cornerRadius: "4px",
            contents: [{ type: "text" as const, text: " ", size: "sm" as const }],
          },
        ],
      },
    ];
  });
  return [
    {
      type: "flex",
      altText: `${month} 類別支出長條圖，合計 NT$${amountFormatter.format(total)}`,
      contents: {
        type: "bubble",
        body: {
          type: "box",
          layout: "vertical",
          spacing: "md",
          paddingAll: "lg",
          contents: [
            { type: "text", text: `${month} 類別支出`, size: "lg", weight: "bold" },
            { type: "text", text: `合計 NT$${amountFormatter.format(total)}`, size: "md", weight: "bold" },
            ...rows,
          ],
        },
      },
    },
  ];
}

async function getMonthlyTotal(userId: string, env: Env): Promise<string> {
  const month = taipeiDate().slice(0, 7);
  const result = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
     FROM expenses WHERE user_id = ? AND substr(occurred_at, 1, 7) = ?`,
  )
    .bind(userId, month)
    .first<{ total: number; count: number }>();

  return `${month} 支出共 NT$${result?.total ?? 0}，共 ${result?.count ?? 0} 筆。`;
}

export async function getMonthlyCategoryAmounts(
  userId: string,
  month: string,
  env: Env,
): Promise<{ category: string; amount: number }[]> {
  const { results } = await env.DB.prepare(
    `SELECT category, SUM(amount) AS total
     FROM expenses WHERE user_id = ? AND substr(occurred_at, 1, 7) = ?
     GROUP BY category`,
  )
    .bind(userId, month)
    .all<{ category: string; total: number }>();
  const totals = new Map(results.map((expense) => [expense.category, expense.total]));
  return CATEGORIES.map((category) => ({ category, amount: totals.get(category) ?? 0 }));
}

export async function restoreExpense(userId: string, env: Env): Promise<boolean> {
  const pending = await env.DB.prepare(
    `SELECT expense_id, amount, category, description, occurred_at
     FROM expense_undo
     WHERE user_id = ? AND created_at >= datetime('now', '-5 minutes')`,
  )
    .bind(userId)
    .first<{
      expense_id: number;
      amount: number;
      category: string;
      description: string;
      occurred_at: string;
    }>();
  if (!pending) {
    await env.DB.prepare("DELETE FROM expense_undo WHERE user_id = ?").bind(userId).run();
    return false;
  }

  const [restored] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO expenses (id, user_id, amount, category, description, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      pending.expense_id,
      userId,
      pending.amount,
      pending.category,
      pending.description,
      pending.occurred_at,
    ),
    env.DB.prepare("DELETE FROM expense_undo WHERE user_id = ? AND expense_id = ?").bind(
      userId,
      pending.expense_id,
    ),
  ]);
  return restored.meta.changes === 1;
}

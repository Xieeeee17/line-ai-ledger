export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  DASHBOARD_PASSWORD: string;
  GEMINI_API_KEY: string;
  LINE_ALLOWED_USER_ID: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_CHANNEL_SECRET: string;
}

export interface LineWebhookEvent {
  type?: string;
  replyToken?: string;
  webhookEventId?: string;
  source?: { userId?: string };
  message?: { type?: string; text?: string };
  postback?: { data?: string; params?: { date?: string } };
}

export interface QuickExpenseSession {
  step: "amount" | "category" | "description" | "date";
  amount: number | null;
  category: string | null;
  description: string | null;
  updated_at: string;
}

export interface Expense {
  amount: number;
  category: string;
  description: string;
  occurredAt: string;
}

export interface ExpenseDeletionCriteria {
  description?: string;
  category?: string;
  amount?: number;
  date?: string;
  latest: boolean;
}

export interface GeminiUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface LineQuickReplyItem {
  type: "action";
  action:
    | { type: "message"; label: string; text: string }
    | {
        type: "datetimepicker";
        label: string;
        data: string;
        mode: "date";
        initial?: string;
      };
}

export interface LineTextMessage {
  type: "text";
  text: string;
  quickReply?: { items: LineQuickReplyItem[] };
}

export interface LineFlexTextComponent {
  type: "text";
  text: string;
  size?: "xs" | "sm" | "md" | "lg";
  weight?: "regular" | "bold";
  color?: string;
  align?: "start" | "center" | "end";
  flex?: number;
  wrap?: boolean;
}

export interface LineFlexBoxComponent {
  type: "box";
  layout: "vertical" | "horizontal";
  spacing?: string;
  paddingAll?: string;
  flex?: number;
  height?: string;
  backgroundColor?: string;
  cornerRadius?: string;
  contents: LineFlexComponent[];
}

export interface LineFlexSeparatorComponent {
  type: "separator";
  margin?: string;
  color?: string;
}

export type LineFlexComponent =
  | LineFlexTextComponent
  | LineFlexBoxComponent
  | LineFlexSeparatorComponent;

export interface LineFlexMessage {
  type: "flex";
  altText: string;
  quickReply?: { items: LineQuickReplyItem[] };
  contents: {
    type: "bubble";
    body: LineFlexBoxComponent;
  };
}

export type LineMessage = LineTextMessage | LineFlexMessage;
export type LineReply = string | LineMessage[];

export type ParsedMessage =
  | { intent: "recent_expenses" }
  | { intent: "monthly_total" }
  | { intent: "monthly_list" }
  | { intent: "category_summary" }
  | { intent: "expense_search"; startDate: string; endDate: string; category?: string }
  | { intent: "budget_query" }
  | { intent: "budget_set"; amount: number }
  | { intent: "delete_expense"; criteria: ExpenseDeletionCriteria }
  | { intent: "edit_expense"; criteria: ExpenseDeletionCriteria; changes?: ExpenseEditChanges }
  | { intent: "help" }
  | { intent: "expense"; expense: Expense }
  | { intent: "unknown" };

export interface ExpenseEditChanges {
  amount?: number;
  category?: string;
  description?: string;
  date?: string;
}

export const CATEGORIES = [
  "餐飲",
  "交通",
  "購物",
  "居家",
  "娛樂",
  "醫療",
  "教育",
  "其他",
] as const;

export const CATEGORY_CHART_COLORS = [
  "#176b58",
  "#3384a5",
  "#e29c3d",
  "#9a6ac1",
  "#d45d5d",
  "#70a64b",
  "#d17b45",
  "#7b8794",
];

export const MAX_AMOUNT = 1_000_000;
export const MAX_MONTHLY_BUDGET = 100_000_000;
export const GEMINI_MODEL = "gemini-3.1-flash-lite";
export const EXPENSES_PAGE_SIZE = 10;
export const MONTHLY_LIST_PAGE_SIZE = 5;
export const PENDING_EDIT_TARGET_MINUTES = 10;
export const QUICK_EXPENSE_SESSION_TTL_MS = 15 * 60 * 1000;
// 固定格式器與指令規則只建立一次，避免每則訊息重複配置。
export const TAIPEI_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export const REPORT_NUMBER_FORMATTER = new Intl.NumberFormat("zh-TW");
export const MANUAL_EXPENSE_PATTERN = new RegExp(
  `^指令記帳\\s+(\\d{1,9})\\s+(${CATEGORIES.join("|")})\\s+(.+?)(?:\\s+(\\d{4}-\\d{2}-\\d{2}))?$`,
  "u",
);
export const FUNCTION_MENU_ACTIONS = [
  { label: "快速記帳", text: "快速記帳" },
  { label: "修改記帳", text: "修改記帳" },
  { label: "本月支出明細", text: "本月支出明細" },
  { label: "本月支出長條圖", text: "本月支出長條圖" },
];

export function taipeiDate(): string {
  const parts = TAIPEI_DATE_FORMATTER.formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((value) => value.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

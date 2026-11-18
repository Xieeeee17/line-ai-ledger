import { restoreExpense, getMonthlyCategoryAmounts } from "./expenses.ts";
import { CATEGORIES, CATEGORY_CHART_COLORS, EXPENSES_PAGE_SIZE } from "./shared.ts";
import { isDate, taipeiDate } from "./shared.ts";
import type { Env } from "./shared.ts";

export function dashboardAuthError(request: Request, env: Env): Response | null {
  if (!env.DASHBOARD_PASSWORD) {
    return new Response("Dashboard password is not configured", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (isDashboardAuthorized(request, env.DASHBOARD_PASSWORD)) {
    return null;
  }
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "Cache-Control": "no-store",
      "WWW-Authenticate": 'Basic realm="LineBot dashboard", charset="UTF-8"',
    },
  });
}

export async function setupLineRichMenu(env: Env, requestUrl: string): Promise<Response> {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN || !env.LINE_ALLOWED_USER_ID) {
    return new Response("LINE rich menu configuration is incomplete", { status: 503 });
  }

  try {
    let config = await env.DB.prepare(
      "SELECT rich_menu_id, image_uploaded FROM line_rich_menu_config WHERE id = 1",
    ).first<{ rich_menu_id: string; image_uploaded: number }>();

    if (!config) {
      const createResponse = await fetch("https://api.line.me/v2/bot/richmenu", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          size: { width: 2500, height: 1686 },
          selected: true,
          name: "個人記帳功能選單",
          chatBarText: "記帳功能",
          areas: [
            {
              bounds: { x: 0, y: 0, width: 1250, height: 843 },
              action: { type: "message", text: "快速記帳" },
            },
            {
              bounds: { x: 1250, y: 0, width: 1250, height: 843 },
              action: { type: "message", text: "修改記帳" },
            },
            {
              bounds: { x: 0, y: 843, width: 1250, height: 843 },
              action: { type: "message", text: "本月支出明細" },
            },
            {
              bounds: { x: 1250, y: 843, width: 1250, height: 843 },
              action: { type: "message", text: "本月支出長條圖" },
            },
          ],
        }),
      });
      if (!createResponse.ok) {
        return lineApiFailure(createResponse, "Creating LINE rich menu");
      }
      const created: unknown = await createResponse.json();
      if (
        typeof created !== "object" ||
        created === null ||
        !("richMenuId" in created) ||
        typeof created.richMenuId !== "string" ||
        !created.richMenuId
      ) {
        console.error("LINE rich menu creation returned no richMenuId");
        return new Response("LINE returned an invalid rich menu response", { status: 502 });
      }
      await env.DB.prepare(
        `INSERT INTO line_rich_menu_config (id, rich_menu_id, image_uploaded)
         VALUES (1, ?, 0)`,
      )
        .bind(created.richMenuId)
        .run();
      config = { rich_menu_id: created.richMenuId, image_uploaded: 0 };
    }

    if (config.image_uploaded === 0) {
      const imageResponse = await env.ASSETS.fetch(
        new Request(new URL("/rich-menu.png", requestUrl)),
      );
      if (!imageResponse.ok) {
        console.error("LINE rich menu image asset is unavailable", imageResponse.status);
        return new Response("Rich menu image asset is unavailable", { status: 500 });
      }
      const uploadResponse = await fetch(
        `https://api-data.line.me/v2/bot/richmenu/${encodeURIComponent(config.rich_menu_id)}/content`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
            "Content-Type": "image/png",
          },
          body: await imageResponse.arrayBuffer(),
        },
      );
      if (!uploadResponse.ok) {
        return lineApiFailure(uploadResponse, "Uploading LINE rich menu image");
      }
      await env.DB.prepare(
        "UPDATE line_rich_menu_config SET image_uploaded = 1 WHERE id = 1",
      ).run();
    }

    const linkResponse = await fetch(
      `https://api.line.me/v2/bot/user/${encodeURIComponent(env.LINE_ALLOWED_USER_ID)}/richmenu/${encodeURIComponent(config.rich_menu_id)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
      },
    );
    if (!linkResponse.ok) {
      return lineApiFailure(linkResponse, "Linking LINE rich menu to the allowed user");
    }
    return Response.json(
      { configured: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("LINE rich menu setup failed", error);
    return new Response("Unable to configure LINE rich menu", {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

async function lineApiFailure(response: Response, operation: string): Promise<Response> {
  const details = (await response.text()).slice(0, 500);
  console.error(`${operation} failed`, response.status, details);
  return new Response("LINE rich menu setup failed", {
    status: 502,
    headers: { "Cache-Control": "no-store" },
  });
}

function isDashboardAuthorized(request: Request, password: string): boolean {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return false;
  }

  const [scheme, encoded, extra] = authorization.trim().split(/\s+/);
  if (scheme.toLowerCase() !== "basic" || !encoded || extra) {
    return false;
  }

  let credentials: string;
  try {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    credentials = new TextDecoder().decode(bytes);
  } catch {
    return false;
  }

  const separator = credentials.indexOf(":");
  return (
    separator > 0 &&
    credentials.slice(0, separator) === "admin" &&
    constantTimeEqual(credentials.slice(separator + 1), password)
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function getDashboardData(env: Env, searchParams: URLSearchParams): Promise<Response> {
  const userId = env.LINE_ALLOWED_USER_ID;
  const month = taipeiDate().slice(0, 7);
  const dateRange = parseDateRange(searchParams);
  const requestedPage = searchParams.get("page") ?? "1";
  if (
    !dateRange ||
    !/^[1-9]\d*$/.test(requestedPage) ||
    !Number.isSafeInteger(Number(requestedPage))
  ) {
    return new Response("Invalid date range or page", { status: 400 });
  }
  const page = Number(requestedPage);
  let dateFilter = "";
  const dateBindings: string[] = [];
  if (dateRange.from) {
    dateFilter += " AND substr(occurred_at, 1, 10) >= ?";
    dateBindings.push(dateRange.from);
  }
  if (dateRange.to) {
    dateFilter += " AND substr(occurred_at, 1, 10) <= ?";
    dateBindings.push(dateRange.to);
  }

  try {
    const [
      monthlyExpenses,
      categoryAmounts,
      expenseCount,
      monthlyUsage,
      budget,
      unansweredCount,
      unansweredQuestions,
      richMenu,
    ] = await Promise.all([
      env.DB.prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
         FROM expenses WHERE user_id = ? AND substr(occurred_at, 1, 7) = ?`,
      )
        .bind(userId, month)
        .first<{ total: number; count: number }>(),
      getMonthlyCategoryAmounts(userId, month, env),
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM expenses WHERE user_id = ?${dateFilter}`,
      )
        .bind(userId, ...dateBindings)
        .first<{ count: number }>(),
      env.DB.prepare(
        `SELECT COUNT(*) AS requests,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM gemini_usage
         WHERE user_id = ? AND strftime('%Y-%m', datetime(created_at, '+8 hours')) = ?`,
      )
        .bind(userId, month)
        .first<{
          requests: number;
          input_tokens: number;
          output_tokens: number;
          total_tokens: number;
        }>(),
      env.DB.prepare("SELECT amount FROM monthly_budgets WHERE user_id = ? AND month = ?")
        .bind(userId, month)
        .first<{ amount: number }>(),
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM unanswered_questions
         WHERE strftime('%Y-%m', datetime(created_at, '+8 hours')) = ?`,
      )
        .bind(month)
        .first<{ count: number }>(),
      env.DB.prepare(
        `SELECT id, question, created_at FROM unanswered_questions
         WHERE strftime('%Y-%m', datetime(created_at, '+8 hours')) = ?
         ORDER BY id DESC LIMIT 20`,
      )
        .bind(month)
        .all<{ id: number; question: string; created_at: string }>(),
      env.DB.prepare("SELECT rich_menu_id FROM line_rich_menu_config WHERE id = 1")
        .first<{ rich_menu_id: string }>(),
    ]);
    const totalPages = Math.max(1, Math.ceil((expenseCount?.count ?? 0) / EXPENSES_PAGE_SIZE));
    const currentPage = Math.min(page, totalPages);
    const recentExpenses = await env.DB.prepare(
      `SELECT id, amount, category, description, occurred_at
       FROM expenses WHERE user_id = ?${dateFilter}
       ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
      .bind(userId, ...dateBindings, EXPENSES_PAGE_SIZE, (currentPage - 1) * EXPENSES_PAGE_SIZE)
      .all<{
        id: number;
        amount: number;
        category: string;
        description: string;
        occurred_at: string;
      }>();

    return Response.json(
      {
        month,
        dateRange,
        expenses: {
          monthlyTotal: monthlyExpenses?.total ?? 0,
          monthlyCount: monthlyExpenses?.count ?? 0,
          byCategory: categoryAmounts,
          budget: budget?.amount ?? null,
          recent: recentExpenses.results.map((expense) => ({
            id: expense.id,
            amount: expense.amount,
            category: expense.category,
            description: expense.description,
            occurredAt: expense.occurred_at,
          })),
          page: currentPage,
          pageSize: EXPENSES_PAGE_SIZE,
          totalCount: expenseCount?.count ?? 0,
          totalPages,
        },
        gemini: {
          monthlyRequests: monthlyUsage?.requests ?? 0,
          monthlyInputTokens: monthlyUsage?.input_tokens ?? 0,
          monthlyOutputTokens: monthlyUsage?.output_tokens ?? 0,
          monthlyTotalTokens: monthlyUsage?.total_tokens ?? 0,
        },
        unanswered: {
          count: unansweredCount?.count ?? 0,
          recent: unansweredQuestions.results.map((item) => ({
            id: item.id,
            question: item.question,
            createdAt: item.created_at,
          })),
        },
        lineRichMenuConfigured: Boolean(richMenu?.rich_menu_id),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Dashboard data request failed", error);
    return new Response("Unable to load dashboard data", {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

function parseDateRange(
  searchParams: URLSearchParams,
): { from: string | null; to: string | null } | null {
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  if (
    (from !== null && !isDate(from)) ||
    (to !== null && !isDate(to)) ||
    (from !== null && to !== null && from > to)
  ) {
    return null;
  }
  return { from, to };
}

function csvCell(value: string): string {
  const safeValue = /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safeValue.replace(/"/g, '""')}"`;
}

export async function exportExpensesCsv(env: Env, searchParams: URLSearchParams): Promise<Response> {
  const dateRange = parseDateRange(searchParams);
  if (!dateRange) {
    return new Response("Invalid date range", { status: 400 });
  }

  const conditions = ["user_id = ?"];
  const bindings: string[] = [env.LINE_ALLOWED_USER_ID];
  if (dateRange.from) {
    conditions.push("substr(occurred_at, 1, 10) >= ?");
    bindings.push(dateRange.from);
  }
  if (dateRange.to) {
    conditions.push("substr(occurred_at, 1, 10) <= ?");
    bindings.push(dateRange.to);
  }

  try {
    const { results } = await env.DB.prepare(
      `SELECT occurred_at, category, description, amount
       FROM expenses WHERE ${conditions.join(" AND ")}
       ORDER BY occurred_at DESC, id DESC`,
    )
      .bind(...bindings)
      .all<{ occurred_at: string; category: string; description: string; amount: number }>();
    const rows = [
      ["日期", "類型", "品項", "金額"].map(csvCell).join(","),
      ...results.map((expense) =>
        [
          expense.occurred_at.slice(0, 10),
          expense.category,
          expense.description,
          String(expense.amount),
        ]
          .map(csvCell)
          .join(","),
      ),
    ];
    return new Response(`\uFEFF${rows.join("\r\n")}`, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="linebot-expenses.csv"',
        "Content-Type": "text/csv; charset=utf-8",
      },
    });
  } catch (error) {
    console.error("Expense CSV export failed", error);
    return new Response("Unable to export expenses", {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

export async function exportUnansweredQuestions(
  env: Env,
  format: "csv" | "json",
): Promise<Response> {
  const month = taipeiDate().slice(0, 7);
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, question, created_at FROM unanswered_questions
       WHERE strftime('%Y-%m', datetime(created_at, '+8 hours')) = ?
       ORDER BY created_at ASC, id ASC`,
    )
      .bind(month)
      .all<{ id: number; question: string; created_at: string }>();
    const filename = `linebot-unanswered-questions-${month}.${format}`;
    if (format === "json") {
      return new Response(
        JSON.stringify({
          month,
          count: results.length,
          questions: results.map((item) => ({
            id: item.id,
            createdAt: item.created_at,
            question: item.question,
          })),
        }),
        {
          headers: {
            "Cache-Control": "no-store",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Content-Type": "application/json; charset=utf-8",
          },
        },
      );
    }

    const rows = [
      ["編號", "時間", "使用者問題"].map(csvCell).join(","),
      ...results.map((item) =>
        [String(item.id), item.created_at, item.question].map(csvCell).join(","),
      ),
    ];
    return new Response(`\uFEFF${rows.join("\r\n")}`, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Type": "text/csv; charset=utf-8",
      },
    });
  } catch (error) {
    console.error(`Unanswered question ${format.toUpperCase()} export failed`, error);
    return new Response("Unable to export unanswered questions", {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

async function getChatChartImage(token: string | null, env: Env): Promise<Response> {
  if (!token || token.length > 1024) {
    return new Response("Not found", { status: 404 });
  }

  let payload: unknown;
  try {
    const plaintext = await decryptChartToken(token, env.LINE_CHANNEL_SECRET);
    payload = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("expiresAt" in payload) ||
    typeof payload.expiresAt !== "number" ||
    payload.expiresAt < Math.floor(Date.now() / 1000) ||
    !("amounts" in payload) ||
    !Array.isArray(payload.amounts) ||
    payload.amounts.length !== CATEGORIES.length ||
    payload.amounts.some(
      (amount) => typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0,
    )
  ) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const image = await renderPieChartPng(payload.amounts);
    return new Response(copyArrayBuffer(image), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "image/png",
      },
    });
  } catch (error) {
    console.error("Chat chart image generation failed", error);
    return new Response("Unable to generate chart image", { status: 500 });
  }
}

async function createChartToken(amounts: number[], secret: string): Promise<string> {
  const key = await getChartEncryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = new TextEncoder().encode(
    JSON.stringify({ expiresAt: Math.floor(Date.now() / 1000) + 15 * 60, amounts }),
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: copyArrayBuffer(iv) },
      key,
      copyArrayBuffer(payload),
    ),
  );
  return `${encodeBase64Url(iv)}.${encodeBase64Url(ciphertext)}`;
}

async function decryptChartToken(token: string, secret: string): Promise<Uint8Array> {
  const [encodedIv, encodedCiphertext, extra] = token.split(".");
  if (!encodedIv || !encodedCiphertext || extra) {
    throw new Error("Invalid chart token");
  }
  const key = await getChartEncryptionKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: copyArrayBuffer(decodeBase64Url(encodedIv)) },
    key,
    copyArrayBuffer(decodeBase64Url(encodedCiphertext)),
  );
  return new Uint8Array(plaintext);
}

async function getChartEncryptionKey(secret: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", keyMaterial, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function copyArrayBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}

async function renderPieChartPng(amounts: number[]): Promise<Uint8Array> {
  const width = 640;
  const height = 640;
  const center = width / 2;
  const radius = 290;
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  const sectors: {
    endAngle: number;
    middleAngle: number;
    color: [number, number, number];
    label: number;
  }[] = [];
  let accumulated = 0;
  if (total > 0) {
    amounts.forEach((amount, index) => {
      if (amount === 0) {
        return;
      }
      const startAngle = accumulated;
      accumulated += (amount / total) * Math.PI * 2;
      const hex = CATEGORY_CHART_COLORS[index].slice(1);
      sectors.push({
        endAngle: accumulated,
        middleAngle: (startAngle + accumulated) / 2,
        color: [
          Number.parseInt(hex.slice(0, 2), 16),
          Number.parseInt(hex.slice(2, 4), 16),
          Number.parseInt(hex.slice(4, 6), 16),
        ],
        label: index + 1,
      });
    });
  }

  const rowLength = width * 3 + 1;
  const scanlines = new Uint8Array(rowLength * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * rowLength;
    for (let x = 0; x < width; x += 1) {
      const dx = x + 0.5 - center;
      const dy = y + 0.5 - center;
      const distanceSquared = dx * dx + dy * dy;
      let color: [number, number, number] = [255, 255, 255];
      if (distanceSquared <= radius * radius) {
        color = [232, 237, 240];
        if (sectors.length > 0) {
          const angle = (Math.atan2(dx, -dy) + Math.PI * 2) % (Math.PI * 2);
          const sector = sectors.find((candidate) => angle < candidate.endAngle) ?? sectors.at(-1);
          if (sector) {
            color = sector.color;
          }
        }
      }
      const pixelOffset = rowOffset + 1 + x * 3;
      scanlines[pixelOffset] = color[0];
      scanlines[pixelOffset + 1] = color[1];
      scanlines[pixelOffset + 2] = color[2];
    }
  }

  for (const sector of sectors) {
    const labelRadius = radius * 0.58;
    drawBitmapNumber(
      scanlines,
      width,
      height,
      center + Math.sin(sector.middleAngle) * labelRadius,
      center - Math.cos(sector.middleAngle) * labelRadius,
      String(sector.label),
      8,
    );
  }

  const compressed = new Uint8Array(
    await new Response(
      new Blob([scanlines]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8;
  header[9] = 2;
  return concatenateBytes([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    createPngChunk("IHDR", header),
    createPngChunk("IDAT", compressed),
    createPngChunk("IEND", new Uint8Array()),
  ]);
}

function drawBitmapNumber(
  scanlines: Uint8Array,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  value: string,
  scale: number,
): void {
  const glyphs: Record<string, string[]> = {
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
    "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  };
  const labelWidth = (value.length * 6 - 1) * scale;
  const startX = Math.round(centerX - labelWidth / 2);
  const startY = Math.round(centerY - (7 * scale) / 2);
  const rowLength = width * 3 + 1;

  for (let index = 0; index < value.length; index += 1) {
    const glyph = glyphs[value[index]];
    if (!glyph) {
      continue;
    }
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row].length; column += 1) {
        if (glyph[row][column] !== "1") {
          continue;
        }
        const x = startX + (index * 6 + column) * scale;
        const y = startY + row * scale;
        fillPixelBlock(scanlines, width, height, rowLength, x - 2, y - 2, scale + 4, scale + 4, [
          25, 33, 43,
        ]);
        fillPixelBlock(scanlines, width, height, rowLength, x, y, scale, scale, [255, 255, 255]);
      }
    }
  }
}

function fillPixelBlock(
  scanlines: Uint8Array,
  width: number,
  height: number,
  rowLength: number,
  x: number,
  y: number,
  blockWidth: number,
  blockHeight: number,
  color: [number, number, number],
): void {
  for (let row = Math.max(0, y); row < Math.min(height, y + blockHeight); row += 1) {
    for (let column = Math.max(0, x); column < Math.min(width, x + blockWidth); column += 1) {
      const offset = row * rowLength + 1 + column * 3;
      scanlines[offset] = color[0];
      scanlines[offset + 1] = color[1];
      scanlines[offset + 2] = color[2];
    }
  }
}

function createPngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const crcInput = concatenateBytes([typeBytes, data]);
  const chunk = new Uint8Array(data.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(crcInput));
  return chunk;
}

function concatenateBytes(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function deleteDashboardExpense(expenseId: string, env: Env): Promise<Response> {
  if (!/^[1-9]\d*$/.test(expenseId)) {
    return new Response("Invalid expense ID", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const id = Number(expenseId);
  if (!Number.isSafeInteger(id)) {
    return new Response("Invalid expense ID", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    const [, deletion] = await env.DB.batch([
      env.DB.prepare(
        `INSERT OR REPLACE INTO expense_undo
          (user_id, expense_id, amount, category, description, occurred_at, created_at)
         SELECT user_id, id, amount, category, description, occurred_at, datetime('now')
         FROM expenses WHERE id = ? AND user_id = ?`,
      ).bind(id, env.LINE_ALLOWED_USER_ID),
      env.DB.prepare("DELETE FROM expenses WHERE id = ? AND user_id = ?").bind(
        id,
        env.LINE_ALLOWED_USER_ID,
      ),
    ]);
    if (deletion.meta.changes === 0) {
      return new Response("Expense not found", {
        status: 404,
        headers: { "Cache-Control": "no-store" },
      });
    }
    return Response.json({ deleted: true, undoMinutes: 5 }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Dashboard expense deletion failed", error);
    return new Response("Unable to delete expense", {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

export async function restoreLatestExpense(userId: string, env: Env): Promise<Response> {
  try {
    const restored = await restoreExpense(userId, env);
    if (!restored) {
      return new Response("No restorable expense found", {
        status: 410,
        headers: { "Cache-Control": "no-store" },
      });
    }
    return Response.json({ restored: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Expense restoration failed", error);
    return new Response("Unable to restore expense", {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

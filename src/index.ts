import {
  dashboardAuthError,
  deleteDashboardExpense,
  exportExpensesCsv,
  exportUnansweredQuestions,
  getDashboardData,
  restoreLatestExpense,
  setupLineRichMenu,
} from "./dashboard.ts";
import { processEvents, verifySignature } from "./line.ts";
import type { Env, LineWebhookEvent } from "./shared.ts";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({ status: "ok", service: "line-ai-ledger" });
    }

    if (url.pathname === "/dashboard" || url.pathname === "/dashboard.html") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      const authError = dashboardAuthError(request, env);
      if (authError) {
        return authError;
      }
      return env.ASSETS.fetch(new Request(new URL("/dashboard", request.url), request));
    }

    if (url.pathname === "/api/dashboard") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      const authError = dashboardAuthError(request, env);
      if (authError) {
        return authError;
      }
      return getDashboardData(env, url.searchParams);
    }

    if (url.pathname === "/api/line-rich-menu/setup") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      const authError = dashboardAuthError(request, env);
      if (authError) {
        return authError;
      }
      return setupLineRichMenu(env, request.url);
    }

    if (url.pathname === "/api/expenses.csv") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      const authError = dashboardAuthError(request, env);
      if (authError) {
        return authError;
      }
      return exportExpensesCsv(env, url.searchParams);
    }

    if (
      url.pathname === "/api/unanswered-questions.csv" ||
      url.pathname === "/api/unanswered-questions.json"
    ) {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      const authError = dashboardAuthError(request, env);
      if (authError) {
        return authError;
      }
      return exportUnansweredQuestions(
        env,
        url.pathname.endsWith(".csv") ? "csv" : "json",
      );
    }

    if (url.pathname === "/api/expenses/undo") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      const authError = dashboardAuthError(request, env);
      if (authError) {
        return authError;
      }
      return restoreLatestExpense(env.LINE_ALLOWED_USER_ID, env);
    }

    const expenseIdMatch = /^\/api\/expenses\/([^/]+)$/.exec(url.pathname);
    if (expenseIdMatch) {
      if (request.method !== "DELETE") {
        return new Response("Method not allowed", { status: 405 });
      }
      const authError = dashboardAuthError(request, env);
      if (authError) {
        return authError;
      }
      return deleteDashboardExpense(expenseIdMatch[1], env);
    }

    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }

    const rawBody = await request.text();
    const signature = request.headers.get("x-line-signature");
    if (!signature || !(await verifySignature(rawBody, signature, env.LINE_CHANNEL_SECRET))) {
      return new Response("Unauthorized", { status: 401 });
    }

    let payload: { events?: LineWebhookEvent[] };
    try {
      payload = JSON.parse(rawBody) as { events?: LineWebhookEvent[] };
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const events = payload.events;
    if (!Array.isArray(events)) {
      return new Response("Invalid webhook payload", { status: 400 });
    }

    ctx.waitUntil(
      processEvents(events, env).catch((error: unknown) => {
        console.error("LINE webhook event processing failed", error);
      }),
    );
    return new Response("OK");
  },
};

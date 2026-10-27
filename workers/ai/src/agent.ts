// Tool-calling loop over Workers AI's OpenAI-compatible chat output.

import { calendarContext } from "./period.ts";
import { DOCS_TOOL_SPECS, runTool, TOOL_SPECS, type ToolContext, type Visual } from "./tools.ts";
import type { DataSource } from "./sources/types.ts";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "tool"; name: string; args: Record<string, unknown> }
  | { type: "visual"; visual: Visual }
  | { type: "answer"; text: string }
  | { type: "error"; text: string };

interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

const MAX_STEPS = 5;
const MAX_HISTORY = 12;
const MAX_TOOL_RESULT = 7000;

const TOOL_LABELS: Record<string, string> = {
  get_sales_summary: "Calculating sales summary",
  get_sales_trend: "Building sales trend",
  get_top_products: "Ranking products",
  get_category_breakdown: "Breaking down categories",
  get_busy_times: "Analysing busy hours",
  get_stock_status: "Checking stock levels",
  get_top_customers: "Ranking customers",
  find_orders: "Looking up orders",
  search_docs: "Searching the CloudPOS docs",
};

/** Normalises both the OpenAI-style and the legacy Workers AI output. */
export function readModelOutput(raw: unknown): { content: string; toolCalls: ToolCall[] } {
  const r = raw as Record<string, any>;
  const message = r?.choices?.[0]?.message;
  if (message) {
    return {
      content: typeof message.content === "string" ? message.content : "",
      toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    };
  }
  const legacy = Array.isArray(r?.tool_calls) ? r.tool_calls : [];
  return {
    content: typeof r?.response === "string" ? r.response : "",
    toolCalls: legacy.map((c: any, i: number) => ({
      id: c.id ?? `call_${i}`,
      type: "function",
      function: { name: c.name ?? c.function?.name, arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? c.function?.arguments ?? {}) },
    })),
  };
}

function parseArgs(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Removes leaked reasoning blocks some models emit inline. */
export function cleanAnswer(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^\s*<\|[^>]*\|>\s*/g, "").trim();
}

const SHARED_RULES = [
  `- For how-to, setup, feature or troubleshooting questions call search_docs and answer only from the results, linking pages as markdown links using the returned link. If the docs do not cover it, say so plainly and suggest contacting CloudPOS support; never guess steps or menu names.`,
  `- Answer in the user's language (Arabic, English, etc.). Be concise and practical.`,
  `- Stay on topic: CloudPOS and retail/restaurant operations.`,
];

/** Guests get a support assistant that only knows the documentation. */
function guestPrompt(): string {
  return [
    `You are CloudPOS AI, the help and support assistant for CloudPOS, a point-of-sale system (POS app, admin panel and online store) for retail shops, cafés and restaurants.`,
    `The user is not signed in, so you have no access to any store's data. Never state, estimate or make up sales, orders, stock, customer or any other business figures, not even as an example.`,
    `If the user asks about their own store's numbers, explain that they can sign in with their CloudPOS company key, email and password (the Sign in button at the top) to analyse their store.`,
    ``,
    `Rules:`,
    ...SHARED_RULES,
  ].join("\n");
}

async function storePrompt(source: DataSource): Promise<string> {
  const info = await source.info();
  const today = await source.today();
  return [
    `You are CloudPOS AI, a business analyst and product guide inside CloudPOS, a point-of-sale system for retail shops, cafés and restaurants.`,
    `Store: ${info.company} — ${info.store}. Currency: ${info.currency || "the store's currency"}. Time zone: ${info.timeZone}. ${info.user ? `User: ${info.user}${info.role ? ` (${info.role})` : ""}.` : ""}`,
    calendarContext(today),
    ``,
    `Rules:`,
    `- For any figure (sales, orders, products, stock, customers) call a data tool. Never invent, estimate or recalculate numbers the tools did not return. Quote them as returned, formatted with thousands separators and the currency.`,
    `- Prefer named periods (today, yesterday, this_week, last_week, this_month, last_month, last_7_days, last_30_days, last_90_days, this_year). Use custom only for explicit dates.`,
    `- Call several tools in one step when a question needs them (for example summary + top products).`,
    `- Every statement must be directly supported by tool results. Do not count, group or compare items (for example by category) unless the tool output shows it; when unsure, leave the claim out.`,
    `- Charts and tables from tools are shown to the user automatically above your answer; do not repeat full tables. Summarise what matters.`,
    `- For analysis answers: a one-line headline, 2–5 bullet insights, then one practical recommendation when useful.`,
    `- If a tool returns an error or unsupported, explain briefly what is unavailable. You only have read access; you cannot change data, create orders or issue refunds.`,
    ...SHARED_RULES,
  ].join("\n");
}

export interface AgentOptions {
  ai: Ai;
  model: string;
  /** Tried once for a step when [model] fails (capacity, outage, bad output). */
  fallbackModel?: string;
  gatewayId?: string;
  ctx: ToolContext;
  history: ChatTurn[];
  message: string;
  emit: (event: AgentEvent) => void | Promise<void>;
}

export async function runAgent(opts: AgentOptions): Promise<void> {
  const { ai, model, ctx, emit } = opts;
  const messages: ModelMessage[] = [
    { role: "system", content: ctx.source ? await storePrompt(ctx.source) : guestPrompt() },
    ...opts.history.slice(-MAX_HISTORY).map((t) => ({ role: t.role, content: t.content.slice(0, 4000) })),
    { role: "user", content: opts.message.slice(0, 4000) },
  ];
  const runOptions = opts.gatewayId ? { gateway: { id: opts.gatewayId } } : undefined;
  let activeModel = model;
  const callModel = (name: string, withTools: boolean) =>
    ai.run(
      name as keyof AiModels,
      { messages, ...(withTools ? { tools: ctx.source ? TOOL_SPECS : DOCS_TOOL_SPECS } : {}), max_tokens: 1500, temperature: 0.2 } as never,
      runOptions as never,
    );

  for (let step = 0; step < MAX_STEPS; step++) {
    const lastStep = step === MAX_STEPS - 1;
    await emit({ type: "status", text: step === 0 ? "Thinking" : "Analysing results" });
    let raw: unknown;
    try {
      raw = await callModel(activeModel, !lastStep);
    } catch (error) {
      if (!opts.fallbackModel || activeModel === opts.fallbackModel) throw error;
      console.warn(`model ${activeModel} failed, falling back to ${opts.fallbackModel}`, error);
      activeModel = opts.fallbackModel;
      raw = await callModel(activeModel, !lastStep);
    }
    const { content, toolCalls } = readModelOutput(raw);

    if (!toolCalls.length || lastStep) {
      const answer = cleanAnswer(content);
      await emit({ type: "answer", text: answer || "I couldn't produce an answer for that. Please try rephrasing." });
      return;
    }

    // Echo calls back with re-serialised arguments: models sometimes emit ""
    // and the chat API then rejects the whole conversation as invalid JSON.
    toolCalls.forEach((call, i) => {
      call.id ||= `call_${step}_${i}`;
      call.type = "function";
      call.function = { name: call.function?.name ?? "", arguments: JSON.stringify(parseArgs(call.function?.arguments)) };
    });
    // Some models reject `content: null` on tool-call turns; "" is accepted by all.
    messages.push({ role: "assistant", content: content || "", tool_calls: toolCalls });
    const results = await Promise.all(
      toolCalls.map(async (call) => {
        const name = call.function?.name ?? "";
        const args = parseArgs(call.function?.arguments);
        await emit({ type: "tool", name, args });
        await emit({ type: "status", text: TOOL_LABELS[name] ?? "Working" });
        try {
          const out = await runTool(name, args, ctx);
          for (const visual of out.visuals ?? []) await emit({ type: "visual", visual });
          return { call, content: JSON.stringify(out.result) };
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          return { call, content: JSON.stringify({ error: text }) };
        }
      }),
    );
    for (const r of results) {
      messages.push({ role: "tool", tool_call_id: r.call.id, content: r.content.slice(0, MAX_TOOL_RESULT) });
    }
  }
}

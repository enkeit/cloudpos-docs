// Runs a fixed question set through /api/chat with each candidate model and
// prints latency, tools called and the answer, for picking CHAT_MODEL.
//
//   AI_URL=http://localhost:8787 ADMIN_TOKEN=... node scripts/eval-models.mjs [model ...]

const base = (process.env.AI_URL ?? "http://localhost:8787").replace(/\/$/, "");
const token = process.env.ADMIN_TOKEN;
const models = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["@cf/google/gemma-4-26b-a4b-it", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/zai-org/glm-4.7-flash", "@cf/openai/gpt-oss-120b"];
const questions = [
  "What are my top 5 products this month?",
  "How did sales go last week compared to the week before?",
  "Which items are out of stock, and what were my busiest hours over the last 7 days?",
  "How do I connect a network receipt printer?",
];

async function ask(model, message) {
  const started = Date.now();
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Token": token ?? "" },
    body: JSON.stringify({ message, model }),
  });
  const text = await res.text();
  const events = text.split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
  return {
    ms: Date.now() - started,
    tools: events.filter((e) => e.type === "tool").map((e) => `${e.name}(${JSON.stringify(e.args)})`),
    answer: events.find((e) => e.type === "answer")?.text ?? events.find((e) => e.type === "error")?.text ?? `HTTP ${res.status}`,
  };
}

for (const model of models) {
  console.log(`\n######## ${model}`);
  const results = await Promise.all(questions.map((q) => ask(model, q)));
  results.forEach((r, i) => {
    console.log(`\n--- Q${i + 1} ${questions[i]}  [${(r.ms / 1000).toFixed(1)}s]`);
    console.log(`tools: ${r.tools.join(", ") || "none"}`);
    console.log(r.answer);
  });
}

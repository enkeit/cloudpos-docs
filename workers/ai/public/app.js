// CloudPOS AI web chat. Demo store by default; signing in swaps the data
// source to the user's own CloudPOS tenant via a sealed session token.

const $ = (id) => document.getElementById(id);
const els = {
  scroller: $("scroller"), welcome: $("welcome"), thread: $("thread"), input: $("input"), send: $("sendBtn"),
  composer: $("composer"), storeLine: $("storeLine"), badge: $("modeBadge"), storeSelect: $("storeSelect"),
  authBtn: $("authBtn"), newChat: $("newChatBtn"), dialog: $("loginDialog"), loginForm: $("loginForm"),
  loginError: $("loginError"), loginCancel: $("loginCancel"), loginSubmit: $("loginSubmit"),
  suggestAnalysis: $("suggestAnalysis"), suggestDocs: $("suggestDocs"), welcomeText: $("welcomeText"),
};

const TOKEN_KEY = "cloudpos-ai-session";
const store = {
  get() { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set(v) { try { v ? sessionStorage.setItem(TOKEN_KEY, v) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } },
};

let token = store.get();
let info = null;
let history = [];
let busy = false;

// ---------- formatting ----------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function money(n, currency) {
  const value = Number(n) || 0;
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: value >= 1000 ? 0 : 2 }).format(value);
    } catch { /* unknown code */ }
  }
  const s = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  return currency ? `${s} ${currency}` : s;
}

function compact(n, isMoney, currency) {
  const value = Number(n) || 0;
  const s = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  return isMoney && currency ? `${s}` : s;
}

function fmt(n, format, currency) {
  return format === "money" ? money(n, currency) : new Intl.NumberFormat().format(Number(n) || 0);
}

// Minimal, safe markdown: everything is escaped first, then a small subset is re-enabled.
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function markdown(src) {
  const lines = esc(src.replace(/\r/g, "")).split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${code.join("\n")}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) items.push(inline(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, "")));
      out.push(`<${ordered ? "ol" : "ul"}>${items.map((x) => `<li>${x}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*•]|\d+[.)])\s+|\s*\|)/.test(lines[i])) para.push(inline(lines[i++]));
    if (para.length) out.push(`<p>${para.join("<br>")}</p>`);
    else out.push(`<p>${inline(lines[i++])}</p>`);
  }
  return out.join("");
}

// ---------- charts ----------

const COLORS = ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6", "--c7", "--c8"].map((v) => `var(${v})`);

function isTimeLike(labels) {
  return labels.every((l) => /^(\d{4}-\d{2}(-\d{2})?|\d{2}:\d{2}|Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/.test(l));
}

function shortLabel(l) {
  const m = l.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(`${l}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const mm = l.match(/^(\d{4})-(\d{2})$/);
  if (mm) return new Date(`${l}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" });
  return l;
}

function svgColumns(v, line) {
  const data = v.series[0].data;
  const W = 640, H = 240, L = 48, R = 12, T = 12, B = 34;
  const peak = Math.max(...data, 0) || 1;
  // Counts get whole-number gridlines; money keeps the raw peak.
  const max = v.format === "number" ? Math.ceil(peak / 4) * 4 : peak;
  const step = (W - L - R) / data.length;
  const y = (val) => T + (H - T - B) * (1 - val / max);
  let grid = "";
  for (let g = 0; g <= 4; g++) {
    const val = (max * g) / 4;
    grid += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(val)}" y2="${y(val)}"/><text x="${L - 6}" y="${y(val) + 4}" text-anchor="end">${esc(compact(val))}</text>`;
  }
  const every = Math.ceil(data.length / 10);
  let labels = "";
  v.labels.forEach((l, i) => {
    if (i % every === 0) labels += `<text x="${L + step * i + step / 2}" y="${H - 12}" text-anchor="middle">${esc(shortLabel(l))}</text>`;
  });
  let marks = "";
  if (line) {
    const pts = data.map((d, i) => `${L + step * i + step / 2},${y(d)}`);
    marks = `<polygon points="${L + step / 2},${y(0)} ${pts.join(" ")} ${L + step * (data.length - 1) + step / 2},${y(0)}" fill="${COLORS[0]}" opacity="0.12"/>`
      + `<polyline points="${pts.join(" ")}" fill="none" stroke="${COLORS[0]}" stroke-width="2.2" stroke-linejoin="round"/>`
      + data.map((d, i) => `<circle cx="${L + step * i + step / 2}" cy="${y(d)}" r="${data.length > 40 ? 0 : 2.5}" fill="${COLORS[0]}"><title>${esc(shortLabel(v.labels[i]))}: ${esc(fmt(d, v.format, v.currency))}</title></circle>`).join("");
  } else {
    const bw = Math.max(2, Math.min(36, step * 0.7));
    marks = data.map((d, i) => `<rect class="bar" x="${L + step * i + (step - bw) / 2}" y="${y(d)}" width="${bw}" height="${Math.max(0, y(0) - y(d))}" rx="3" fill="${COLORS[0]}"><title>${esc(shortLabel(v.labels[i]))}: ${esc(fmt(d, v.format, v.currency))}</title></rect>`).join("");
  }
  return `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(v.title)}">${grid}${marks}${labels}</svg></div>`;
}

function hbars(v) {
  const data = v.series[0].data;
  const max = Math.max(...data, 0) || 1;
  return v.labels.map((l, i) => `<div class="hbar-row"><span class="label" title="${esc(l)}" dir="auto">${esc(l)}</span><div class="hbar-track"><div class="hbar-fill" style="width:${(data[i] / max) * 100}%;background:${COLORS[0]}"></div></div><span class="value">${esc(fmt(data[i], v.format, v.currency))}</span></div>`).join("");
}

function donut(v) {
  const data = v.series[0].data;
  const total = data.reduce((s, d) => s + d, 0) || 1;
  const r = 52, c = 2 * Math.PI * r;
  let offset = 0;
  const arcs = data.map((d, i) => {
    const len = (d / total) * c;
    const a = `<circle class="slice" r="${r}" cx="75" cy="75" fill="none" stroke="${COLORS[i % COLORS.length]}" stroke-width="22" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 75 75)"><title>${esc(v.labels[i])}: ${esc(fmt(d, v.format, v.currency))}</title></circle>`;
    offset += len;
    return a;
  }).join("");
  const legend = v.labels.map((l, i) => `<div><i style="background:${COLORS[i % COLORS.length]}"></i><span dir="auto">${esc(l)}</span><span class="value">${esc(fmt(data[i], v.format, v.currency))}</span><span class="pct">${Math.round((data[i] / total) * 100)}%</span></div>`).join("");
  return `<div class="donut"><svg viewBox="0 0 150 150" role="img" aria-label="${esc(v.title)}">${arcs}</svg><div class="legend">${legend}</div></div>`;
}

function table(v) {
  const moneyCols = new Set(v.money ?? []);
  const head = v.columns.map((c, i) => `<th class="${moneyCols.has(i) ? "num" : ""}">${esc(c)}</th>`).join("");
  const rows = v.rows.map((r) => `<tr>${r.map((cell, i) => {
    if (moneyCols.has(i)) return `<td class="num">${esc(money(cell, v.currency))}</td>`;
    if (v.columns[i] === "Status" && /^(Out|Low|OK)$/.test(cell)) return `<td><span class="pill ${String(cell).toLowerCase()}">${esc(cell)}</span></td>`;
    return `<td dir="auto" class="${typeof cell === "number" ? "num" : ""}">${esc(cell)}</td>`;
  }).join("")}</tr>`).join("");
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function visualCard(v) {
  const card = document.createElement("div");
  card.className = "card";
  let body;
  if (v.kind === "table") body = table(v);
  else if (v.type === "pie") body = donut(v);
  else if (v.type === "line") body = svgColumns(v, true);
  else body = isTimeLike(v.labels) ? svgColumns(v, false) : hbars(v);
  card.innerHTML = `<h3>${esc(v.title)}</h3>${body}`;
  return card;
}

// ---------- UI state ----------

function scrollToEnd() {
  els.scroller.scrollTop = els.scroller.scrollHeight;
}

function chip(text, target) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "chip";
  b.dir = "auto";
  b.textContent = text;
  b.addEventListener("click", () => ask(text));
  target.append(b);
}

function renderInfo(data) {
  info = data.info;
  const live = info.mode === "live";
  els.storeLine.textContent = `${info.company} · ${info.store}`;
  els.badge.hidden = false;
  els.badge.textContent = live ? "Live data" : "Demo store";
  els.badge.className = `badge${live ? "" : " demo"}`;
  els.authBtn.textContent = live ? "Sign out" : "Sign in";
  els.welcomeText.textContent = live
    ? `Connected to ${info.company}. Ask about sales, top products, stock, customers and busy hours — or how to do something in CloudPOS.`
    : "You're exploring a demo café & market with sample data. Ask about sales, products, stock, customers and busy hours — or how to do something in CloudPOS. Sign in to analyse your own store.";
  els.storeSelect.hidden = !(live && data.stores?.length > 1);
  if (!els.storeSelect.hidden) {
    els.storeSelect.innerHTML = data.stores.map((s) => `<option value="${s.id}">${esc(s.name || `Store ${s.id}`)}</option>`).join("");
    const current = data.stores.find((s) => s.name === info.store);
    if (current) els.storeSelect.value = String(current.id);
  }
  els.suggestAnalysis.replaceChildren();
  els.suggestDocs.replaceChildren();
  data.suggestions?.analysis?.forEach((s) => chip(s, els.suggestAnalysis));
  data.suggestions?.docs?.forEach((s) => chip(s, els.suggestDocs));
}

function authHeaders() {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function loadInfo() {
  const res = await fetch("/api/info", { headers: authHeaders() });
  if (res.status === 401 && token) {
    token = null;
    store.set(null);
    return loadInfo();
  }
  renderInfo(await res.json());
}

function resetChat() {
  history = [];
  els.thread.replaceChildren();
  els.welcome.hidden = false;
  els.input.focus();
}

function setBusy(v) {
  busy = v;
  els.send.disabled = v || !els.input.value.trim();
  els.input.placeholder = v ? "Working on it…" : "Ask anything about your store…";
}

// ---------- chat ----------

async function ask(text) {
  const message = text.trim();
  if (!message || busy) return;
  els.welcome.hidden = true;
  els.input.value = "";
  autosize();
  setBusy(true);

  const user = document.createElement("div");
  user.className = "msg-user";
  user.dir = "auto";
  user.textContent = message;
  const ai = document.createElement("div");
  ai.className = "msg-ai";
  const steps = document.createElement("div");
  steps.className = "steps";
  ai.append(steps);
  els.thread.append(user, ai);
  scrollToEnd();

  let activeStep = null;
  const setStep = (label) => {
    if (activeStep?.textContent === label) return;
    if (activeStep) activeStep.className = "step done";
    activeStep = document.createElement("span");
    activeStep.className = "step active";
    activeStep.textContent = label;
    steps.append(activeStep);
  };
  const showError = (msg) => {
    const e = document.createElement("div");
    e.className = "error-card";
    e.textContent = msg;
    ai.append(e);
  };

  let answer = "";
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ message, history }),
    });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}));
      if (body.code === "session_expired") { token = null; store.set(null); loadInfo(); }
      throw new Error(body.error || `Request failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === "status") setStep(ev.text);
        else if (ev.type === "visual") ai.insertBefore(visualCard(ev.visual), null);
        else if (ev.type === "answer") {
          answer = ev.text;
          const div = document.createElement("div");
          div.className = "answer";
          div.dir = "auto";
          div.innerHTML = markdown(answer);
          ai.append(div);
        } else if (ev.type === "error") showError(ev.text);
        scrollToEnd();
      }
    }
  } catch (err) {
    showError(err.message || "Something went wrong.");
  } finally {
    if (activeStep) activeStep.className = "step done";
    if (!steps.children.length) steps.remove();
    else steps.lastChild.textContent = "Done";
    if (answer) history.push({ role: "user", content: message }, { role: "assistant", content: answer }), (history = history.slice(-12));
    setBusy(false);
    scrollToEnd();
    els.input.focus();
  }
}

function autosize() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 180)}px`;
  els.send.disabled = busy || !els.input.value.trim();
}

els.input.addEventListener("input", autosize);
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    ask(els.input.value);
  }
});
els.composer.addEventListener("submit", (e) => { e.preventDefault(); ask(els.input.value); });
els.newChat.addEventListener("click", resetChat);

els.authBtn.addEventListener("click", () => {
  if (info?.mode === "live") {
    token = null;
    store.set(null);
    resetChat();
    loadInfo();
    return;
  }
  els.loginError.hidden = true;
  els.dialog.showModal();
});
els.loginCancel.addEventListener("click", () => els.dialog.close());
els.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(els.loginForm);
  els.loginSubmit.disabled = true;
  els.loginSubmit.textContent = "Signing in…";
  els.loginError.hidden = true;
  try {
    const res = await fetch("/api/session/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantKey: form.get("tenantKey"), email: form.get("email"), password: form.get("password") }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Sign-in failed.");
    token = body.token;
    store.set(token);
    els.loginForm.reset();
    els.dialog.close();
    resetChat();
    renderInfo({ info: body.info, stores: body.stores, suggestions: (await (await fetch("/api/info", { headers: authHeaders() })).json()).suggestions });
  } catch (err) {
    els.loginError.textContent = err.message;
    els.loginError.hidden = false;
  } finally {
    els.loginSubmit.disabled = false;
    els.loginSubmit.textContent = "Sign in";
  }
});
els.storeSelect.addEventListener("change", async () => {
  const res = await fetch("/api/session/store", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ storeId: Number(els.storeSelect.value) }),
  });
  const body = await res.json();
  if (!res.ok) return;
  token = body.token;
  store.set(token);
  resetChat();
  loadInfo();
});

loadInfo().catch(() => { els.storeLine.textContent = "Offline — check your connection"; });
const q = new URLSearchParams(location.search).get("q");
if (q) ask(q);

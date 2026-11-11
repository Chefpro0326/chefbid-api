import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { readFileSync } from "fs";

const AKEY = process.env.ANTHROPIC_API_KEY || "";
const SKEY = process.env.STRIPE_SECRET_KEY || "";
const SPRO = process.env.STRIPE_PRICE_ID   || "";
const SBAS = process.env.STRIPE_BASIC_PRICE_ID || "";
const PORT = process.env.PORT || "3000";

console.log("ChefBid API | Anthropic:", !!AKEY, "| Stripe:", !!SKEY);

const app = new Hono();
// ── Only chefbidpro.com (and our own hosts) may use the API from a browser ──
const ALLOWED_ORIGINS = [
  "https://chefbidpro.com",
  "https://www.chefbidpro.com",
  "https://chefbid-api.onrender.com",
  "https://chefbid-app-production.up.railway.app"
];
app.use("/*", cors({ origin: (o) => ALLOWED_ORIGINS.includes(o) ? o : null }));

// No-cache headers for HTML files
const noCache = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0'
};

app.get("/", (c) => {
  try {
    const html = readFileSync("./index.html", "utf8");
    return c.html(html, 200, noCache);
  } catch(e) { return c.text("index.html not found", 404); }
});

app.get("/app", (c) => {
  try {
    const html = readFileSync("./app.html", "utf8");
    return c.html(html, 200, noCache);
  } catch(e) { return c.text("app.html not found", 404); }
});

app.get("/app.html", (c) => {
  try {
    const html = readFileSync("./app.html", "utf8");
    return c.html(html, 200, noCache);
  } catch(e) { return c.text("Not found", 404); }
});

// Phase 2 test page (Supabase accounts). Remove once it replaces /app.
app.get("/app2", (c) => {
  try { return c.html(readFileSync("./app2.html", "utf8")); }
  catch(e) { return c.text("app2.html not found", 404); }
});

app.get("/privacy", (c) => {
  try { return c.html(readFileSync("./privacy.html", "utf8"), 200, noCache); }
  catch(e) { return c.text("Not found", 404); }
});

app.get("/terms", (c) => {
  try { return c.html(readFileSync("./terms.html", "utf8"), 200, noCache); }
  catch(e) { return c.text("Not found", 404); }
});

app.get("/contact", (c) => {
  try { return c.html(readFileSync("./contact.html", "utf8"), 200, noCache); }
  catch(e) { return c.text("Not found", 404); }
});

// ── AI endpoint guard ──
// The server, not the browser, decides which model runs and how big the
// answer can be, and refuses anyone who isn't the ChefBid app.
const AI_MODEL = (process.env.AI_MODEL || "claude-sonnet-4-6").trim();
const MAX_TOKENS_CAP = 4000;        // biggest request the app makes
const MAX_PROMPT_CHARS = 40000;     // far above any real menu
const RATE_LIMIT = 30;              // requests per IP...
const RATE_WINDOW_MS = 10 * 60 * 1000; // ...per 10 minutes
const hits = new Map();
function tooMany(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if(hits.size > 5000) hits.clear();
  return list.length > RATE_LIMIT;
}

app.post("/api/ai", async (c) => {
  if(!AKEY) return c.json({ error: { message: "API key not configured." } }, 500);
  const origin = c.req.header("origin") || "";
  if(!ALLOWED_ORIGINS.includes(origin)) {
    return c.json({ error: { message: "Not allowed." } }, 403);
  }
  const ip = (c.req.header("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  if(tooMany(ip)) {
    return c.json({ error: { message: "Too many requests. Please wait a few minutes and try again." } }, 429);
  }
  try {
    const body = await c.req.json();
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if(!messages.length || JSON.stringify(messages).length > MAX_PROMPT_CHARS) {
      return c.json({ error: { message: "Request too large or empty." } }, 400);
    }
    const safeBody = {
      model: AI_MODEL,
      max_tokens: Math.min(parseInt(body.max_tokens) || 1000, MAX_TOKENS_CAP),
      messages
    };
    if(typeof body.system === "string") safeBody.system = body.system.slice(0, 4000);
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": AKEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(safeBody)
    });
    const data = await response.json();
    return c.json(data, response.status);
  } catch(e) {
    return c.json({ error: { message: e.message } }, 500);
  }
});

app.post("/api/create-checkout", async (c) => {
  if(!SKEY || !SPRO) return c.json({ error: "Stripe not configured." }, 500);
  try {
    const { email, userId, plan } = await c.req.json();
    const selectedPrice = (plan === "basic" && SBAS) ? SBAS : SPRO;
    const params = new URLSearchParams({
      "mode": "subscription",
      "payment_method_types[0]": "card",
      "line_items[0][price]": selectedPrice,
      "line_items[0][quantity]": "1",
      "success_url": "https://chefbidpro.com/app?upgrade=success&plan=" + (plan || "pro"),
      "cancel_url": "https://chefbidpro.com/app?upgrade=cancelled",
      "customer_email": email,
      "client_reference_id": userId,
      "metadata[userId]": userId,
      "metadata[plan]": plan || "pro"
    });
    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${SKEY}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });
    const session = await response.json();
    if(session.error) return c.json({ error: session.error.message }, 400);
    return c.json({ url: session.url });
  } catch(e) {
    return c.json({ error: e.message }, 500);
  }
});

app.post("/api/verify-subscription", async (c) => {
  if(!SKEY) return c.json({ isPro: false, plan: "free" });
  try {
    const { email } = await c.req.json();
    const custRes = await fetch(`https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=1`, {
      headers: { "Authorization": `Bearer ${SKEY}` }
    });
    const custData = await custRes.json();
    if(!custData.data?.length) return c.json({ isPro: false, plan: "free" });
    const subRes = await fetch(`https://api.stripe.com/v1/subscriptions?customer=${custData.data[0].id}&status=active&limit=1`, {
      headers: { "Authorization": `Bearer ${SKEY}` }
    });
    const subData = await subRes.json();
    if(!subData.data?.length) return c.json({ isPro: false, plan: "free" });
    const priceUsed = subData.data[0].items?.data?.[0]?.price?.id;
    const plan = priceUsed === SBAS ? "basic" : "pro";
    return c.json({ isPro: plan === "pro", plan });
  } catch(e) {
    return c.json({ isPro: false, plan: "free" });
  }
});

app.post("/api/cancel-subscription", async (c) => {
  if(!SKEY) return c.json({ error: "Not configured" }, 500);
  try {
    const { email } = await c.req.json();
    const custRes = await fetch(`https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=1`, {
      headers: { "Authorization": `Bearer ${SKEY}` }
    });
    const custData = await custRes.json();
    if(!custData.data?.length) return c.json({ error: "Customer not found" }, 404);
    const subRes = await fetch(`https://api.stripe.com/v1/subscriptions?customer=${custData.data[0].id}&status=active&limit=1`, {
      headers: { "Authorization": `Bearer ${SKEY}` }
    });
    const subData = await subRes.json();
    if(!subData.data?.length) return c.json({ error: "No active subscription" }, 404);
    const cancelRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subData.data[0].id}`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${SKEY}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "cancel_at_period_end=true"
    });
    const cancelData = await cancelRes.json();
    return c.json({ success: true, endsAt: cancelData.current_period_end });
  } catch(e) {
    return c.json({ error: e.message }, 500);
  }
});

serve({ fetch: app.fetch, port: parseInt(PORT) });
console.log("ChefBid PRO v2 running on port", PORT);

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { readFileSync } from "fs";

const AKEY = (process.env.ANTHROPIC_API_KEY || "").trim();
const SKEY = (process.env.STRIPE_SECRET_KEY || "").trim();
const SPRO = (process.env.STRIPE_PRICE_ID || "").trim();
const SBAS = (process.env.STRIPE_BASIC_PRICE_ID || "").trim();
const SB_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SB_SECRET = (process.env.SUPABASE_SECRET_KEY || "").trim();
const PORT = process.env.PORT || "3000";

console.log("ChefBid API | Anthropic:", !!AKEY, "| Stripe:", !!SKEY, "| Supabase:", !!(SB_URL && SB_SECRET));

// ── Plans ──
const PLAN_EVENT_LIMITS = { free: 3, basic: 10, pro: null }; // null = unlimited
const TRIAL_DAYS = 14; // new accounts get full PRO for 14 days, no card needed
const PLAN_RECHECK_MS = 24 * 60 * 60 * 1000; // re-confirm paid plans with Stripe daily
const DAILY_AI_CAP = { free: 40, basic: 150, pro: 400 }; // advice/chat calls per user per day

// ── Supabase helpers (server uses the SECRET key; never sent to browsers) ──
async function sbRest(path, opts = {}) {
  const res = await fetch(SB_URL + "/rest/v1/" + path, {
    ...opts,
    headers: { apikey: SB_SECRET, "Content-Type": "application/json", Prefer: "return=representation", ...(opts.headers || {}) }
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if(!res.ok) throw new Error("Supabase " + res.status + ": " + (data?.message || text));
  return data;
}

// Who is calling? Checks the sign-in token the app sends with each request.
async function getUser(c) {
  if(!SB_URL || !SB_SECRET) return null;
  const auth = c.req.header("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if(!token) return null;
  try {
    const res = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_SECRET, Authorization: "Bearer " + token } });
    if(!res.ok) return null;
    const user = await res.json();
    return user && user.id ? user : null;
  } catch(e) { return null; }
}

async function getProfile(uid) {
  const rows = await sbRest("profiles?id=eq." + encodeURIComponent(uid) + "&select=*");
  return rows && rows[0] ? rows[0] : { id: uid, plan: "free" };
}

// Ask Stripe what this user actually pays for, and record it in Supabase.
async function stripePlanFor(email) {
  if(!email) return { plan: "free", customerId: null };
  const custRes = await fetch(`https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=10`, {
    headers: { Authorization: `Bearer ${SKEY}` }
  });
  const custData = await custRes.json();
  if(!custRes.ok) throw new Error("Stripe customers: " + (custData.error?.message || custRes.status));
  let best = { plan: "free", customerId: custData.data?.[0]?.id || null };
  for(const cust of (custData.data || [])) {
    const subRes = await fetch(`https://api.stripe.com/v1/subscriptions?customer=${cust.id}&status=active&limit=5`, {
      headers: { Authorization: `Bearer ${SKEY}` }
    });
    const subData = await subRes.json();
    if(!subRes.ok) throw new Error("Stripe subscriptions: " + (subData.error?.message || subRes.status));
    for(const sub of (subData.data || [])) {
      const priceUsed = sub.items?.data?.[0]?.price?.id;
      const plan = priceUsed === SBAS ? "basic" : (priceUsed === SPRO ? "pro" : null);
      if(plan === "pro") return { plan: "pro", customerId: cust.id };
      if(plan === "basic") best = { plan: "basic", customerId: cust.id };
    }
  }
  return best;
}

async function syncPlan(user) {
  // If Stripe isn't set up on this server, never change anyone's plan.
  if(!SKEY) return (await getProfile(user.id)).plan || "free";
  // Only trust a confirmed email address when matching Stripe customers.
  const email = user.email_confirmed_at ? user.email : null;
  const { plan, customerId } = await stripePlanFor(email);
  await sbRest("profiles?id=eq." + encodeURIComponent(user.id), {
    method: "PATCH",
    body: JSON.stringify({ plan, stripe_customer_id: customerId, plan_checked_at: new Date().toISOString() })
  });
  return plan;
}

function trialEndsAt(profile) {
  const created = Date.parse(profile.created_at || "");
  return isNaN(created) ? 0 : created + TRIAL_DAYS * 24 * 60 * 60 * 1000;
}
// What the user can actually use right now: paid plan, or PRO while in the trial.
function effectivePlan(paidPlan, profile) {
  if(paidPlan === "free" && Date.now() < trialEndsAt(profile)) return "pro";
  return paidPlan;
}

async function currentPlan(user) {
  const profile = await getProfile(user.id);
  return effectivePlan(await paidPlan(user, profile), profile);
}

async function paidPlan(user, profile) {
  let plan = profile.plan || "free";
  const checked = profile.plan_checked_at ? Date.parse(profile.plan_checked_at) : 0;
  if(plan !== "free" && Date.now() - checked > PLAN_RECHECK_MS) {
    try { plan = await syncPlan(user); } catch(e) { console.error("plan recheck failed", e.message); }
  }
  return plan;
}

function monthKey() {
  const d = new Date();
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}

const dailyCalls = new Map();
function overDailyCap(uid, plan) {
  const key = uid + ":" + new Date().toISOString().slice(0, 10);
  const n = (dailyCalls.get(key) || 0) + 1;
  dailyCalls.set(key, n);
  if(dailyCalls.size > 20000) dailyCalls.clear();
  return n > (DAILY_AI_CAP[plan] || DAILY_AI_CAP.free);
}

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

// /app2 was the Phase 2 test address; it now lives at /app.
app.get("/app2", (c) => c.redirect("/app", 301));

// Previous browser-only version, kept briefly as a fallback. Remove after Nov 17, 2026.
app.get("/app-old", (c) => {
  try { return c.html(readFileSync("./app-old.html", "utf8")); }
  catch(e) { return c.text("Not found", 404); }
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
  const user = await getUser(c);
  if(!user) return c.json({ error: { code: "signin_required", message: "Please sign in again." } }, 401);
  try {
    const body = await c.req.json();
    const plan = await currentPlan(user);

    // A NEW event uses one of this month's slots. Re-analyzing the same event
    // (same fingerprint) is free. Enforced here, so no browser trick gets around it.
    if(typeof body.eventFingerprint === "string" && body.eventFingerprint.trim()) {
      const slot = await sbRest("rpc/claim_event_slot", {
        method: "POST",
        body: JSON.stringify({
          p_user: user.id, p_month: monthKey(),
          p_fingerprint: body.eventFingerprint.trim().toLowerCase().slice(0, 300),
          p_limit: (plan in PLAN_EVENT_LIMITS) ? PLAN_EVENT_LIMITS[plan] : PLAN_EVENT_LIMITS.free
        })
      });
      if(!slot || !slot.allowed) {
        return c.json({ error: { code: "limit_reached", plan, used: slot?.used,
          message: "You've used all of this month's events on your plan. Upgrade to keep pricing events." } }, 402);
      }
    } else if(overDailyCap(user.id, plan)) {
      return c.json({ error: { message: "Daily AI limit reached. Please try again tomorrow." } }, 429);
    }

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
  const user = await getUser(c);
  if(!user) return c.json({ error: "Please sign in again." }, 401);
  try {
    const { plan } = await c.req.json();
    const email = user.email, userId = user.id;
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

// Signed-in user asks: "what plan am I on?" The server checks Stripe itself.
async function handlePlanSync(c) {
  const user = await getUser(c);
  if(!user) return c.json({ error: "Please sign in again." }, 401);
  let paid, stale = false;
  try { paid = await syncPlan(user); }
  catch(e) { console.error("sync-plan", e.message); stale = true; }   // Stripe unreachable: keep current plan
  try {
    const profile = await getProfile(user.id);
    if(paid === undefined) paid = profile.plan || "free";
    const plan = effectivePlan(paid, profile);
    const trialEnd = trialEndsAt(profile);
    const onTrial = paid === "free" && Date.now() < trialEnd;
    return c.json({ plan, paidPlan: paid, isPro: plan === "pro", onTrial,
      trialEndsAt: onTrial ? new Date(trialEnd).toISOString() : null, stale });
  } catch(e2) {
    return c.json({ error: "Could not check your plan right now." }, 500);
  }
}
app.post("/api/sync-plan", handlePlanSync);
app.post("/api/verify-subscription", handlePlanSync);

app.post("/api/cancel-subscription", async (c) => {
  if(!SKEY) return c.json({ error: "Not configured" }, 500);
  const user = await getUser(c);
  if(!user) return c.json({ error: "Please sign in again." }, 401);
  try {
    const email = user.email;
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

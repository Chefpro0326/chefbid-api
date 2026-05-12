import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";

const AKEY = process.env.ANTHROPIC_API_KEY || "";
const SKEY = process.env.STRIPE_SECRET_KEY || "";
const SPRO = process.env.STRIPE_PRICE_ID   || "";
const SBAS = process.env.STRIPE_BASIC_PRICE_ID || "";
const PORT = process.env.PORT || "3000";

console.log("ChefBid API | Anthropic:", !!AKEY, "| Stripe:", !!SKEY);

const app = new Hono();
app.use("/*", cors());

import { readFileSync } from "fs";

app.get("/", (c) => {
  try { return c.html(readFileSync("./index.html", "utf8")); }
  catch(e) { return c.text("ChefBid API Running - index.html not found", 404); }
});

app.get("/app", (c) => {
  try { return c.html(readFileSync("./app.html", "utf8")); }
  catch(e) { return c.text("app.html not found", 404); }
});

app.get("/app.html", (c) => {
  try { return c.html(readFileSync("./app.html", "utf8")); }
  catch(e) { return c.text("Not found", 404); }
});

app.get("/privacy", (c) => {
  try { return c.html(readFileSync("./privacy.html", "utf8")); }
  catch(e) { return c.text("Not found", 404); }
});

app.get("/terms", (c) => {
  try { return c.html(readFileSync("./terms.html", "utf8")); }
  catch(e) { return c.text("Not found", 404); }
});

app.get("/debug", (c) => c.json({
  version: "v1",
  hasAnthropicKey: !!AKEY,
  hasStripeSecret: !!SKEY,
  stripeStart: SKEY ? SKEY.slice(0,12) : "NOT FOUND",
  hasPriceId: !!SPRO,
  hasBasicPriceId: !!SBAS,
  envKeys: Object.keys(process.env).filter(k => k.includes("STRIPE") || k.includes("ANTHROPIC"))
}));

app.post("/api/ai", async (c) => {
  if(!AKEY) return c.json({ error: { message: "API key not configured." } }, 500);
  try {
    const body = await c.req.json();
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": AKEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    return c.json(data, response.status);
  } catch(e) {
    return c.json({ error: { message: e.message } }, 500);
  }
});

app.post("/api/create-checkout", async (c) => {
  if(!SKEY || !SPRO) return c.json({ error: "Stripe not configured.", debug: { hasSecret: !!SKEY, hasPriceId: !!SPRO } }, 500);
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
console.log("ChefBid API running on port", PORT);

/* Messages to Nick (owner): the daily sales report (report.js) and site monitoring (monitor.js).
   Same channels as the Salty Dog Tags site, all optional, all set as Cloudflare Worker
   secrets/variables (never in this repo):
     NTFY_TOPIC                                   -> push to the ntfy app (free; use a long random topic)
     PUSHOVER_TOKEN + PUSHOVER_USER               -> Pushover app push
     TWILIO_SID + TWILIO_TOKEN + TWILIO_FROM + NOTIFY_TO -> SMS via Twilio
   With none of them set, notifyConfigured() is false and the owner features do nothing at all.
   notify() never throws; it returns the list of channel errors (empty = all good). */

const has = (env, ...k) => k.every(n => env[n] && String(env[n]).trim());
const ntfyOn = env => has(env, "NTFY_TOPIC");
const pushoverOn = env => has(env, "PUSHOVER_TOKEN", "PUSHOVER_USER");
const twilioOn = env => has(env, "TWILIO_SID", "TWILIO_TOKEN", "TWILIO_FROM", "NOTIFY_TO");

export const notifyConfigured = env => ntfyOn(env) || pushoverOn(env) || twilioOn(env);
export const notifyChannels = env => [ntfyOn(env) && "ntfy", pushoverOn(env) && "pushover", twilioOn(env) && "sms"].filter(Boolean);

/* msg = { title, body, priority: "low"|"normal"|"high", tags: [ntfy emoji tags], click: url } */
async function ntfy(env, msg) {
  if (!ntfyOn(env)) return;
  // accept "topic", "ntfy.sh/topic" or "https://ntfy.sh/topic" as pasted from the app
  const topic = String(env.NTFY_TOPIC).trim().replace(/^https?:\/\//, "").replace(/^ntfy\.sh\//, "").replace(/^\/+/, "");
  const priority = msg.priority === "high" ? 4 : msg.priority === "low" ? 2 : 3;
  // JSON publish: header values can't carry UTF-8, the JSON body can.
  const r = await fetch("https://ntfy.sh/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topic, title: msg.title, message: msg.body, priority, tags: msg.tags || [], ...(msg.click ? { click: msg.click } : {}) }),
  });
  if (!r.ok) throw new Error("ntfy " + r.status + " " + (await r.text()).slice(0, 120));
}

async function pushover(env, msg) {
  if (!pushoverOn(env)) return;
  const form = new URLSearchParams({ token: env.PUSHOVER_TOKEN, user: env.PUSHOVER_USER, title: msg.title, message: msg.body,
    priority: msg.priority === "high" ? "1" : msg.priority === "low" ? "-1" : "0" });
  if (msg.click) { form.set("url", msg.click); form.set("url_title", "Open"); }
  const r = await fetch("https://api.pushover.net/1/messages.json", { method: "POST", body: form });
  if (!r.ok) throw new Error("pushover " + r.status + " " + (await r.text()).slice(0, 120));
}

async function twilio(env, msg) {
  if (!twilioOn(env)) return;
  const auth = btoa(env.TWILIO_SID + ":" + env.TWILIO_TOKEN);
  const form = new URLSearchParams({ To: env.NOTIFY_TO, From: env.TWILIO_FROM, Body: (msg.title + "\n" + msg.body).slice(0, 1500) });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
    method: "POST", headers: { Authorization: "Basic " + auth }, body: form,
  });
  if (!r.ok) throw new Error("twilio " + r.status + " " + (await r.text()).slice(0, 120));
}

export async function notify(env, msg) {
  if (!notifyConfigured(env)) return ["no channel configured"];
  const rs = await Promise.allSettled([ntfy(env, msg), pushover(env, msg), twilio(env, msg)]);
  const errs = rs.filter(r => r.status === "rejected").map(r => String(r.reason && r.reason.message || r.reason).slice(0, 200));
  if (errs.length) console.warn("notify failed", errs.join(" | "));
  return errs;
}

/* The Salty Dog Tags relay (saltydogtags.com/api/relay): lets this Worker use the Clover Hosted Checkout key
   and the phone alerts that the Salty Dog Tags site already has, instead of setting up its own.
     RELAY_KEY  secret, the shared key; set by the "Set up relay key" workflow (thirsty-beaches-website repo)
     RELAY_URL  optional, default https://saltydogtags.com/api/relay
   Our own settings always win: CLOVER_ECOMM_TOKEN means checkouts go straight to Clover, and any notify.js
   channel (NTFY_TOPIC, Pushover, Twilio) means alerts never go through the relay.
   Never logs or returns the key.                                                                              */

const DEFAULT_URL = "https://saltydogtags.com/api/relay";
export const RELAY_LIMITS = { items: 30, cents: 20000 };      // the relay's own hard limits (functions/api/relay.js)

const relayKey = env => (typeof env.RELAY_KEY === "string" ? env.RELAY_KEY.trim() : "");
export const relayOn = env => relayKey(env).length >= 32;
/* Checkouts: our own Hosted Checkout key, or the relay. */
export const checkoutConfigured = env => !!env.CLOVER_ECOMM_TOKEN || relayOn(env);
export const checkoutViaRelay = env => !env.CLOVER_ECOMM_TOKEN && relayOn(env);

/* POST one request to the relay. -> {status, data}; status 0 when it couldn't be reached. Never throws. */
export async function relayPost(env, payload, ms = 9000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(env.RELAY_URL || DEFAULT_URL, {
      method: "POST", signal: ctl.signal,
      headers: { "content-type": "application/json", accept: "application/json", authorization: "Bearer " + relayKey(env) },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { error: "not-json" }; }
    return { status: r.status, data };
  } catch (e) {
    return { status: 0, data: { error: e && e.name === "AbortError" ? "relay-timeout" : "relay-unreachable" } };
  } finally { clearTimeout(t); }
}

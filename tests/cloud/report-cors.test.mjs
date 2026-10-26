// node tests/cloud/report-cors.test.mjs — GET /api/report from the owner app (GitHub Pages): CORS for that origin only,
// key in the X-Key header (or ?k=) still required. No network: without CLOVER_API_TOKEN the report answers 503.
import assert from "node:assert/strict";
import worker from "../../cloud/src/index.js";

const OWNER = "https://nicholasroper-cloud.github.io";
const env = { STATION_KEY: "station-key-123", STATE: { async get() { return null; }, async put() {} } };
const call = (method, headers = {}, q = "") => worker.fetch(new Request("https://station.thirstybeaches.com/api/report" + q, { method, headers }), env);

let r = await call("OPTIONS", { origin: OWNER, "access-control-request-method": "GET", "access-control-request-headers": "x-key" });
assert.equal(r.status, 204);
assert.equal(r.headers.get("access-control-allow-origin"), OWNER);
assert.match(r.headers.get("access-control-allow-headers"), /X-Key/i);
assert.match(r.headers.get("access-control-allow-methods"), /GET/);

r = await call("GET", { origin: OWNER, "x-key": "station-key-123" });
assert.equal(r.status, 503);                                   // authorized; no Clover token in the test env
assert.equal(r.headers.get("access-control-allow-origin"), OWNER);
assert.equal((await r.json()).error, "CLOVER_API_TOKEN not set");

r = await call("GET", { origin: OWNER });                        // no key: 401, still readable by the app
assert.equal(r.status, 401);
assert.equal(r.headers.get("access-control-allow-origin"), OWNER);
r = await call("GET", { origin: OWNER, "x-key": "wrong" });
assert.equal(r.status, 401);

r = await call("GET", {}, "?k=station-key-123");                 // the old ?k= link keeps working
assert.equal(r.status, 503);
assert.equal(r.headers.get("access-control-allow-origin"), null);

r = await call("GET", { origin: "https://evil.example", "x-key": "station-key-123" });
assert.equal(r.headers.get("access-control-allow-origin"), null);
r = await call("OPTIONS", { origin: "https://evil.example" });
assert.equal(r.headers.get("access-control-allow-origin"), null);

console.log("report cors tests ok");

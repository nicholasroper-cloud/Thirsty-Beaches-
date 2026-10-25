/* Clover REST helpers shared by the station routes (index.js) and the daily report (report.js).
   Uses the CLOVER_API_TOKEN secret; never logs it. */

export async function cloverGet(env, p) {
  const r = await fetch(`${env.CLOVER_BASE_URL || "https://api.clover.com"}/v3/merchants/${env.CLOVER_MERCHANT_ID}${p}`,
    { headers: { Authorization: `Bearer ${env.CLOVER_API_TOKEN}` } });
  if (!r.ok) throw new Error(`Clover ${p.split("?")[0]} -> ${r.status}`);
  return r.json();
}

const catMemo = { catalog: null, at: 0 };   // per-isolate cache

/* Item id / name -> category names, cached 10 min in memory and in KV ("catalog"). */
export async function getCatalog(env) {
  if (catMemo.catalog && Date.now() - catMemo.at < 10 * 60000) return catMemo.catalog;
  const cached = await env.STATE.get("catalog", "json");
  if (cached && Date.now() - (cached.at || 0) < 10 * 60000) { catMemo.catalog = cached; catMemo.at = cached.at; return cached; }
  const byId = {}, byName = {};
  let offset = 0;
  while (offset < 2000) {
    const r = await cloverGet(env, `/items?expand=categories&limit=500&offset=${offset}`);
    const els = (r && r.elements) || [];
    for (const it of els) {
      const cat = (((it.categories || {}).elements) || []).map(c => c.name).join(" / ");
      byId[it.id] = { name: it.name, category: cat };
      byName[String(it.name || "").toLowerCase()] = { id: it.id, category: cat };
    }
    if (els.length < 500) break;
    offset += 500;
  }
  const cat = { byId, byName, at: Date.now() };
  catMemo.catalog = cat; catMemo.at = cat.at;
  await env.STATE.put("catalog", JSON.stringify(cat), { expirationTtl: 3600 });
  return cat;
}

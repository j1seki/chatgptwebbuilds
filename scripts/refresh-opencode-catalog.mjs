import { mkdir, readFile, writeFile } from "node:fs/promises";

const CATALOG_URL = "https://models.dev/api.json?type=all";
const LIVE_URL = "https://opencode.ai/inference/v1/models";
const OUT = "opencode-free/data.json";

async function getJson(url) {
  const response = await fetch(url, { headers: { "user-agent": "chatgptwebbuilds-opencode-tracker/1.0" } });
  if (!response.ok) throw new Error(`Request failed: ${url} (${response.status})`);
  return response.json();
}

const zero = value => value === 0 || value === "0" || value === null;
const asNumber = value => Number.isFinite(Number(value)) ? Number(value) : null;

function normalizeCatalog(raw) {
  const providers = Array.isArray(raw) ? raw : Object.values(raw || {});
  const found = [];
  for (const provider of providers) {
    if (!provider || !["opencode", "opencode-go"].includes(provider.id)) continue;
    const models = Array.isArray(provider.models) ? provider.models : Object.values(provider.models || {});
    for (const model of models) {
      const inputCost = model.cost?.input;
      if (!zero(inputCost)) continue;
      found.push({
        id: model.id,
        name: model.name || model.id,
        provider: provider.id,
        providerName: provider.name || provider.id,
        context: asNumber(model.limit?.context),
        output: asNumber(model.limit?.output),
        inputCost: asNumber(inputCost) ?? 0,
        outputCost: asNumber(model.cost?.output),
        reasoning: Boolean(model.reasoning),
        toolCall: Boolean(model.tool_call),
        vision: Boolean(model.modalities?.input?.includes?.("image") || model.attachment),
        inputModalities: model.modalities?.input || [],
        status: model.status || "active",
        tps: asNumber(model.speed?.output_tps ?? model.tps),
        source: "models.dev"
      });
    }
  }
  return found;
}

function liveIds(payload) {
  const rows = Array.isArray(payload) ? payload : (payload?.data || payload?.models || []);
  return new Set(rows.map(item => item.id || item.model).filter(Boolean));
}

const previous = await readFile(OUT, "utf8").then(JSON.parse).catch(() => null);
const catalog = await getJson(CATALOG_URL);
const models = normalizeCatalog(catalog);
if (!models.length) throw new Error("No free OpenCode models found; refusing to overwrite the last good snapshot.");

let live = null;
try { live = liveIds(await getJson(LIVE_URL)); } catch { /* endpoint may require authentication; keep catalog status */ }

const updatedAt = new Date().toISOString();
const priorById = new Map((previous?.models || []).map(model => [model.id, model]));
const enriched = models.map(model => {
  const old = priorById.get(model.id) || {};
  const listed = live ? live.has(model.id) : null;
  return {
    ...model,
    status: model.status === "deprecated" ? "deprecated" : listed === true ? "available" : listed === false ? "not-listed-on-live-endpoint" : "catalog-listed",
    statusVerified: listed !== null,
    // TPS is only carried forward when backed by an explicit measured value.
    tps: model.tps ?? old.tps ?? null,
    tpsSource: model.tps != null ? "catalog" : old.tpsSource || null,
    tpsMeasuredAt: old.tpsMeasuredAt || null
  };
}).sort((a, b) => (b.context || 0) - (a.context || 0));

await mkdir("opencode-free", { recursive: true });
await writeFile(OUT, JSON.stringify({
  schemaVersion: 1,
  updatedAt,
  refreshHours: 6,
  sources: {
    catalog: CATALOG_URL,
    live: LIVE_URL,
    docs: "https://opencode.ai/docs/models"
  },
  statusNote: live ? "Live model endpoint checked during refresh." : "Catalog presence only; live endpoint did not return a public model list.",
  leaderboardNote: "Metadata score only (context, output, reasoning, tool calling, and vision). It is not a quality or speed benchmark.",
  models: enriched
}, null, 2) + "\n");
console.log(`Updated ${enriched.length} free OpenCode models at ${updatedAt}`);

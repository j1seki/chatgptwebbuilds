import { mkdir, readFile, writeFile } from "node:fs/promises";

const CATALOG_URL = "https://models.dev/api.json?type=all";
const PROVIDER_ID = "opencode";
const USAGE_URL = "https://opencode.ai/data/index.json";
const OUT = "opencode-free/data.json";

async function getJson(url) {
  const response = await fetch(url, { headers: { "user-agent": "chatgptwebbuilds-opencode-free-tracker/1.0" } });
  if (!response.ok) throw new Error(`Request failed: ${url} (${response.status})`);
  return response.json();
}

const isZero = value => typeof value === "number" && Number.isFinite(value) && value === 0;
const numberOrNull = value => typeof value === "number" && Number.isFinite(value) ? value : null;

function normalizeCatalog(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Unexpected models.dev API response: expected provider object");
  const provider = raw[PROVIDER_ID];
  if (!provider || typeof provider !== "object") throw new Error(`Provider '${PROVIDER_ID}' missing from models.dev API response`);
  const modelsObject = provider.models;
  if (!modelsObject || typeof modelsObject !== "object") throw new Error("OpenCode provider response has no models object");

  const found = [];
  for (const [modelKey, model] of Object.entries(modelsObject)) {
    if (!model || typeof model !== "object") continue;
    // A model is free only when both published token prices are explicitly numeric zero.
    // Missing/null prices are unknown, not free.
    if (!isZero(model.cost?.input) || !isZero(model.cost?.output)) continue;
    const id = model.id || modelKey;
    found.push({
      id,
      name: model.name || id,
      provider: PROVIDER_ID,
      providerName: provider.name || "OpenCode",
      context: numberOrNull(model.limit?.context),
      inputLimit: numberOrNull(model.limit?.input),
      output: numberOrNull(model.limit?.output),
      inputCost: 0,
      outputCost: 0,
      reasoning: model.reasoning === true,
      toolCall: model.tool_call === true,
      vision: model.attachment === true || model.modalities?.input?.includes?.("image") === true,
      inputModalities: Array.isArray(model.modalities?.input) ? model.modalities.input : [],
      outputModalities: Array.isArray(model.modalities?.output) ? model.modalities.output : [],
      lifecycle: model.status || "listed",
      // Models.dev does not publish measured inference throughput. Never invent TPS.
      tps: null,
      tpsSource: null,
      source: "models.dev",
      sourceUrl: "https://models.dev/providers/opencode/"
    });
  }
  return found.sort((a,b) => (b.context || 0) - (a.context || 0));
}

const catalog = await getJson(CATALOG_URL);
const models = normalizeCatalog(catalog);
const usage = await getJson(USAGE_URL);
if (!Array.isArray(usage?.leaderboard?.pastWeek) || !Array.isArray(usage?.leaderboard?.pastDay)) throw new Error("OpenCode usage API response missing pastWeek/pastDay leaderboards.");
if (!models.length) throw new Error("OpenCode provider returned zero explicitly free models. Refusing to overwrite last good snapshot.");

const updatedAt = new Date().toISOString();
const aliases = id => {
  const values = new Set([id]);
  for (const suffix of ["-contributor-free", "-preview-free", "-free"]) {
    if (id.endsWith(suffix)) values.add(id.slice(0, -suffix.length));
  }
  return [...values];
};
const weekly = new Map(usage.leaderboard.pastWeek.map(row => [row.model, row]));
const daily = new Map(usage.leaderboard.pastDay.map(row => [row.model, row]));
const enriched = models.map(model => {
  const matchKey = aliases(model.id).find(id => weekly.has(id) || daily.has(id));
  const week = matchKey ? weekly.get(matchKey) : null;
  const day = matchKey ? daily.get(matchKey) : null;
  return {
    ...model,
    status: model.lifecycle === "deprecated" ? "deprecated" : "listed-by-models.dev",
    statusVerified: true,
    usageModelId: matchKey || null,
    usageRank7d: week?.rank ?? null,
    usage7dTokens: week?.tokens ?? null,
    usageChangePercent: week?.changePercent ?? null,
    usageRank24h: day?.rank ?? null,
    usage24hTokens: day?.tokens ?? null,
    usageSource: matchKey ? USAGE_URL : null
  };
});

await mkdir("opencode-free", { recursive: true });
await writeFile(OUT, JSON.stringify({
  schemaVersion: 2,
  updatedAt,
  refreshHours: 6,
  provider: "OpenCode",
  source: {
    name: "Models.dev provider catalog",
    url: CATALOG_URL,
    providerPage: "https://models.dev/providers/opencode/",
    methodology: "Only models with explicitly numeric $0.00 input AND $0.00 output prices are included."
  },
  statusNote: "Listed by the OpenCode provider catalog in Models.dev. This is catalog status, not a live inference/uptime check.",
  tpsNote: "No measured TPS is published by this source. TPS remains unavailable until a reproducible benchmark source is integrated.",
  leaderboardNote: "Official OpenCode past-week and past-day token usage leaderboard, joined to models with explicitly zero input and output prices. Usage is popularity, not coding quality.",
  models: enriched
}, null, 2) + "\n");
console.log(`Updated ${enriched.length} explicitly free OpenCode models and joined official OpenCode usage rankings`);

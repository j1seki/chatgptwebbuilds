import { mkdir, readFile, writeFile } from "node:fs/promises";

const CATALOG_URL = "https://models.dev/api.json?type=all";
const PROVIDER_ID = "opencode";
const OFFICIAL_MODELS_DOCS = "https://opencode.ai/docs/console/models.md";
const OFFICIAL_MODELS_API = "https://opencode.ai/inference/v1/models";
const OUT = "opencode-free/data.json";
const BENCHMARKS_FILE = "opencode-free/benchmarks.json";

async function getJson(url) {
  const response = await fetch(url, { headers: { "user-agent": "chatgptwebbuilds-opencode-free-tracker/2.0" } });
  if (!response.ok) throw new Error(`Request failed: ${url} (${response.status})`);
  return response.json();
}

async function getText(url) {
  const response = await fetch(url, { headers: { "user-agent": "chatgptwebbuilds-opencode-free-tracker/2.0" } });
  if (!response.ok) throw new Error(`Request failed: ${url} (${response.status})`);
  return response.text();
}

const numberOrNull = value => typeof value === "number" && Number.isFinite(value) ? value : null;
const normalizeName = value => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

function parseOfficialFreeModels(markdown) {
  const endpointSection = markdown.split("## Endpoints")[1]?.split("### Model list")[0];
  const pricingSection = markdown.split("## Pricing")[1]?.split("\n## ")[0];
  if (!endpointSection || !pricingSection) throw new Error("OpenCode official docs changed: endpoint/pricing sections were not found.");

  const endpointIds = new Map();
  for (const line of endpointSection.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map(cell => cell.trim());
    if (cells.length < 3 || cells[0] === "Model" || /^-+$/.test(cells[1])) continue;
    endpointIds.set(normalizeName(cells[0]), cells[1].replace(/`/g, ""));
  }

  const freeModels = [];
  for (const line of pricingSection.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map(cell => cell.trim().replace(/`/g, ""));
    if (cells.length < 3 || cells[0] === "Model" || /^-+$/.test(cells[1])) continue;
    // OpenCode's own current pricing table is the authority for free status.
    if (cells[1].toLowerCase() !== "free" || cells[2].toLowerCase() !== "free") continue;
    const id = endpointIds.get(normalizeName(cells[0]));
    if (!id) throw new Error(`OpenCode docs changed: could not map free model "${cells[0]}" to an official model ID.`);
    freeModels.push({ id, name: cells[0] });
  }

  if (!freeModels.length) throw new Error("OpenCode official pricing docs returned zero free models. Refusing to overwrite the last good snapshot.");
  return freeModels;
}

function normalizeCatalog(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Unexpected models.dev API response: expected provider object");
  const provider = raw[PROVIDER_ID];
  if (!provider || typeof provider !== "object") throw new Error(`Provider '${PROVIDER_ID}' missing from models.dev API response`);
  const modelsObject = provider.models;
  if (!modelsObject || typeof modelsObject !== "object") throw new Error("OpenCode provider response has no models object");

  const byId = new Map();
  for (const [modelKey, model] of Object.entries(modelsObject)) {
    if (!model || typeof model !== "object") continue;
    const id = model.id || modelKey;
    byId.set(id, { id, model });
  }
  return { provider, byId };
}

const [catalog, officialDocs, liveModelPayload, previousText, benchmarkText] = await Promise.all([
  getJson(CATALOG_URL),
  getText(OFFICIAL_MODELS_DOCS),
  getJson(OFFICIAL_MODELS_API),
  readFile(OUT, "utf8").catch(() => null),
  readFile(BENCHMARKS_FILE, "utf8")
]);
const benchmarkSnapshot = JSON.parse(benchmarkText);
if (!Array.isArray(benchmarkSnapshot.models)) throw new Error("Benchmark snapshot is invalid.");
const benchmarksById = new Map(benchmarkSnapshot.models.map(item => [item.id, item]));

const documentedFreeModels = parseOfficialFreeModels(officialDocs);
const liveRows = Array.isArray(liveModelPayload?.data) ? liveModelPayload.data
  : Array.isArray(liveModelPayload?.models) ? liveModelPayload.models
  : Array.isArray(liveModelPayload) ? liveModelPayload
  : liveModelPayload?.data && typeof liveModelPayload.data === "object" ? Object.values(liveModelPayload.data)
  : liveModelPayload?.models && typeof liveModelPayload.models === "object" ? Object.values(liveModelPayload.models)
  : [];
const liveIds = new Set(liveRows.map(row => {
  const id = typeof row === "string" ? row : row?.id;
  return typeof id === "string" ? id.replace(/^opencode\//, "") : null;
}).filter(Boolean));
if (!liveIds.size) throw new Error("OpenCode live models endpoint returned no model IDs. Refusing to overwrite the last good snapshot.");
const officialFreeModels = documentedFreeModels.filter(model => liveIds.has(model.id));
if (!officialFreeModels.length) throw new Error("No documented free models were confirmed by OpenCode's live models endpoint. Refusing to overwrite the last good snapshot.");
const { provider, byId } = normalizeCatalog(catalog);
const previous = previousText ? JSON.parse(previousText) : { models: [] };
const previousModels = Array.isArray(previous.models) ? previous.models : [];
const updatedAt = new Date().toISOString();
const currentIds = new Set(officialFreeModels.map(model => model.id));

const currentModels = officialFreeModels.map(official => {
  const catalogEntry = byId.get(official.id);
  const model = catalogEntry?.model || {};
  const benchmark = benchmarksById.get(official.id) || null;

  return {
    id: official.id,
    name: official.name,
    modelType: official.id.startsWith("jev-") ? "structured-decision" : "chat",
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
    tps: null,
    tpsSource: null,
    source: "models.dev",
    sourceUrl: "https://models.dev/providers/opencode/",
    status: "available",
    statusVerified: true,
    statusSource: OFFICIAL_MODELS_DOCS,
    availabilityCheckedAt: updatedAt,
    firstSeenAt: previousModels.find(item => item.id === official.id)?.firstSeenAt || updatedAt,
    intelligenceScore: benchmark?.score ?? null,
    intelligenceBenchmark: benchmark?.benchmark ?? null,
    intelligenceDate: benchmark?.date ?? null,
    intelligenceSourceUrl: benchmark?.sourceUrl ?? null,
    intelligenceSource: benchmark?.source ?? null
  };
});

// Preserve every model seen in earlier snapshots, but keep it out of the default list.
// A removal date is only recorded when a model was previously marked current by this tracker.
const historyById = new Map();
for (const old of previousModels) {
  if (!old?.id || currentIds.has(old.id)) continue;
  const { usageModelId, usageRank7d, usage7dTokens, usageChangePercent, usageRank24h, usage24hTokens, usageSource, ...cleanOld } = old;
  historyById.set(old.id, {
    ...cleanOld,
    status: "historical",
    statusVerified: true,
    removedAt: old.removedAt || (old.status === "available" ? updatedAt : null)
  });
}

const historicalModels = [...historyById.values()].sort((a, b) => a.name.localeCompare(b.name));
const models = [...currentModels, ...historicalModels];
if (!currentModels.length) throw new Error("No current free models were resolved. Refusing to overwrite the last good snapshot.");

await mkdir("opencode-free", { recursive: true });
await writeFile(OUT, JSON.stringify({
  schemaVersion: 3,
  updatedAt,
  refreshHours: 6,
  provider: "OpenCode",
  currentCount: currentModels.length,
  historicalCount: historicalModels.length,
  source: {
    name: "OpenCode official free-model pricing + endpoint docs, enriched with Models.dev metadata",
    officialDocsUrl: OFFICIAL_MODELS_DOCS,
    liveModelsApiUrl: OFFICIAL_MODELS_API,
    catalogUrl: CATALOG_URL,
    benchmarkFile: BENCHMARKS_FILE,
    benchmarkUpdatedAt: benchmarkSnapshot.updatedAt || null,
    providerPage: "https://models.dev/providers/opencode/",
    methodology: "Current models must appear in OpenCode's live /inference/v1/models response, appear in its official endpoint table, and have both input and output marked Free in its official pricing table. Models.dev is used only for context/capability metadata. Intelligence scores are joined by exact model ID from the separately maintained benchmark snapshot; missing scores remain null. Previous snapshots are retained as history."
  },
  statusNote: "CURRENTLY LISTED means the model appears in OpenCode's live models API and official docs mark both input and output free. This confirms catalog availability, not a successful inference request; account, project, region, and quota restrictions may still apply.",
  tpsNote: "No measured TPS is published by these sources. TPS remains unavailable until a reproducible benchmark source is integrated.",
  leaderboardNote: "Models are ranked by independently measured Artificial Analysis Intelligence Index scores where an exact model-ID match exists. Usage/popularity data is not used. Unbenchmarked models are not assigned scores.",
  models
}, null, 2) + "\n");

console.log(`Updated ${currentModels.length} currently listed free OpenCode models; retained ${historicalModels.length} historical entries; joined verified benchmark scores where available.`);

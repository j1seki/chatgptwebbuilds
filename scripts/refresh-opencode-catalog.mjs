import { mkdir, readFile, writeFile } from "node:fs/promises";

const CATALOG_URL = "https://models.dev/api.json?type=all";
const PROVIDER_ID = "opencode";
const USAGE_URL = "https://opencode.ai/data/index.json";
const OFFICIAL_MODELS_DOCS = "https://opencode.ai/docs/console/models.md";
const OUT = "opencode-free/data.json";

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

const [catalog, usage, officialDocs, previousText] = await Promise.all([
  getJson(CATALOG_URL),
  getJson(USAGE_URL),
  getText(OFFICIAL_MODELS_DOCS),
  readFile(OUT, "utf8").catch(() => null)
]);

if (!Array.isArray(usage?.leaderboard?.pastWeek) || !Array.isArray(usage?.leaderboard?.pastDay)) {
  throw new Error("OpenCode usage API response missing pastWeek/pastDay leaderboards.");
}

const officialFreeModels = parseOfficialFreeModels(officialDocs);
const { provider, byId } = normalizeCatalog(catalog);
const previous = previousText ? JSON.parse(previousText) : { models: [] };
const previousModels = Array.isArray(previous.models) ? previous.models : [];
const updatedAt = new Date().toISOString();
const currentIds = new Set(officialFreeModels.map(model => model.id));

const weekly = new Map(usage.leaderboard.pastWeek.map(row => [row.model, row]));
const daily = new Map(usage.leaderboard.pastDay.map(row => [row.model, row]));
const aliases = id => {
  const values = new Set([id]);
  for (const suffix of ["-contributor-free", "-preview-free", "-free"]) {
    if (id.endsWith(suffix)) values.add(id.slice(0, -suffix.length));
  }
  return [...values];
};

const currentModels = officialFreeModels.map(official => {
  const catalogEntry = byId.get(official.id);
  const model = catalogEntry?.model || {};
  const matchKey = aliases(official.id).find(id => weekly.has(id) || daily.has(id));
  const week = matchKey ? weekly.get(matchKey) : null;
  const day = matchKey ? daily.get(matchKey) : null;

  return {
    id: official.id,
    name: official.name,
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
    usageModelId: matchKey || null,
    usageRank7d: week?.rank ?? null,
    usage7dTokens: week?.tokens ?? null,
    usageChangePercent: week?.changePercent ?? null,
    usageRank24h: day?.rank ?? null,
    usage24hTokens: day?.tokens ?? null,
    usageSource: matchKey ? USAGE_URL : null
  };
});

// Preserve every model seen in earlier snapshots, but keep it out of the default list.
// A removal date is only recorded when a model was previously marked current by this tracker.
const historyById = new Map();
for (const old of previousModels) {
  if (!old?.id || currentIds.has(old.id)) continue;
  historyById.set(old.id, {
    ...old,
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
    catalogUrl: CATALOG_URL,
    usageUrl: USAGE_URL,
    usageUpdatedAt: usage.updatedAt || null,
    providerPage: "https://models.dev/providers/opencode/",
    methodology: "Current models must appear in OpenCode's official endpoint table and have both input and output marked Free in its official pricing table. Models.dev is used only for context/capability metadata. Previous snapshots are retained as history."
  },
  statusNote: "CURRENTLY LISTED means OpenCode's official docs currently list the model and mark both input and output free. It is not a live request/uptime test; account, project, region, and quota restrictions may still apply.",
  tpsNote: "No measured TPS is published by these sources. TPS remains unavailable until a reproducible benchmark source is integrated.",
  leaderboardNote: "Official OpenCode past-week and past-day token usage leaderboard, joined to currently free models. Usage is popularity, not coding quality.",
  models
}, null, 2) + "\n");

console.log(`Updated ${currentModels.length} currently listed free OpenCode models; retained ${historicalModels.length} historical entries; joined official usage rankings.`);

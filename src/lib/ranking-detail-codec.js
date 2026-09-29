// Storage encoding only; no rounding or change to study/model semantics.
const FIELDS = ["event", "timestamp", "cohort", "destinationClass", "candidateCount",
    "qualifiedDwellMs", "observationAgeMs", "predictionLatencyMs", "openTabBand",
    "sessionAgeBand", "censorReason", "modelVersion", "queryLength", "queryTokenCount",
    "selectedRank", "latencyMs"];
const MODEL_FIELDS = ["modelVersion", "identityResolution", "confidenceMethod",
    "predictedCount", "actualRank", "actualProbability", "top1Probability"];
const FORMAT = "ranking-details-v1";

export function encodeRankingDetails(records, { maxRecords = 5000, maxBytes = 2 * 1024 * 1024 } = {}) {
    const labels = [], indexes = new Map();
    const encode = value => {
        if (typeof value !== "string") return value ?? null;
        if (!indexes.has(value)) { indexes.set(value, labels.length); labels.push(value); }
        return [indexes.get(value)];
    };
    const rows = records.slice(-maxRecords).map(record => [
        ...FIELDS.map(key => encode(record[key])),
        ...(record.models ? [record.models.map(model => MODEL_FIELDS.map(key => encode(model[key])))] : [])
    ]);
    const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    // Count each row once, then discard oldest details without touching aggregates.
    let size = bytes({ format: FORMAT, labels, rows: [] });
    const sizes = rows.map(row => bytes(row) + 1);
    size += sizes.reduce((sum, value) => sum + value, 0);
    let start = 0;
    while (size > maxBytes && start < rows.length) size -= sizes[start++];
    return { format: FORMAT, labels, rows: rows.slice(start) };
}

export function decodeRankingDetails(value) {
    // The old raw array is migrated on the next successful flush.
    if (Array.isArray(value)) return value;
    if (value?.format !== FORMAT || !Array.isArray(value.labels) || !Array.isArray(value.rows)) return [];
    const decode = item => Array.isArray(item) ? value.labels[item[0]] : item;
    return value.rows.filter(row => Array.isArray(row) && row.length >= FIELDS.length).map(row => {
        const record = Object.fromEntries(FIELDS.flatMap((key, index) => row[index] === null
            ? [] : [[key, decode(row[index])]]));
        if (Array.isArray(row[FIELDS.length])) record.models = row[FIELDS.length].map(model =>
            Object.fromEntries(MODEL_FIELDS.map((key, index) => [key, decode(model[index]) ?? null])));
        return record;
    });
}

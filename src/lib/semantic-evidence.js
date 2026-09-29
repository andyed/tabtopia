export const EMBEDDING_RECIPE = "revisit-evidence-v1";
export const RETRIEVAL_PREFIX = "Represent this sentence for searching relevant passages: ";

const clean = (value, limit = 1600) => typeof value === "string" ? value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\b(password|access_token|authorization|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ").trim().slice(0, limit) : "";

/** Separate facets keep an explicit task from being diluted by a page centroid.
 * Use source-provided text only. An assistant suggestion is not a user intent.
 * Token limits are enforced by the local server's tokenizer before embedding.
 */
export function buildEmbeddingInputs(input = {}) {
    const facet = (name, fields) => ({ name, recipe: EMBEDDING_RECIPE,
        fields: fields.map(([role, value]) => ({ role, text: clean(value) })).filter(field => field.text) });
    return [
        facet("intent", [["User intent", input.userIntent], ["Constraints", input.constraints],
            ["Project", input.project], ["Entities", input.entities]]),
        facet("page", [["Title", input.title], ["Headings", input.headings],
            ["Selected passage", input.selectedExcerpt], ["Page excerpt", input.excerpt]]),
        facet("saved-intent", [["Saved page", input.bookmarkTitle], ["Bookmark folder", input.bookmarkFolder],
            ["User note", input.bookmarkNote]])
    ].filter(item => item.fields.length);
}

export async function fitEmbeddingInput(facet, tokenize, maxTokens = 480) {
    const fields = facet.fields.map(field => ({ ...field }));
    while (fields.some(field => field.text)) {
        const text = RETRIEVAL_PREFIX + fields.filter(field => field.text)
            .map(field => `${field.role}: ${field.text}`).join("\n");
        const tokens = await tokenize(text);
        if (!Number.isInteger(tokens) || tokens < 1) throw new Error("Invalid tokenizer response");
        if (tokens <= maxTokens) return { facet: facet.name, recipe: EMBEDDING_RECIPE, text, tokens,
            truncated: fields.some((field, i) => field.text !== facet.fields[i].text) };
        // Trim the longest field, keeping short constraints and titles intact.
        const longest = fields.reduce((best, field) => field.text.length > best.text.length ? field : best);
        longest.text = longest.text.slice(0, Math.max(0, Math.floor(longest.text.length * 0.75)));
    }
    throw new Error("Embedding input has no usable text within the token budget");
}

/** Reciprocal ranks fuse facets, not uncalibrated scores from different corpora.
 * Keep per-facet receipts and bound repeated events from the same session.
 */
export function fuseSemanticEvidence(batches, { asOf = Date.now(), limit = 8, perSession = 2 } = {}) {
    const byId = new Map();
    for (const batch of batches) {
        const facetSeen = new Set();
        for (const [rank, hit] of batch.hits.entries()) {
            const payload = hit.payload || {};
            const timestamp = Date.parse(payload.timestamp || payload.date_added || "");
            if (!Number.isFinite(timestamp) || timestamp > asOf) continue;
            const availableAt = Date.parse(payload.available_at || "");
            if (Number.isFinite(availableAt) && availableAt > asOf) continue;
            const key = `${batch.collection}:${String(payload.event_id || payload.url || hit.id)}`;
            // Repeated captures of one URL must not buy it several votes from
            // the same query facet. Its highest-ranked receipt is sufficient.
            if (facetSeen.has(key)) continue;
            facetSeen.add(key);
            if (!byId.has(key)) byId.set(key, {
                id: key, collection: batch.collection, eventId: payload.event_id || null,
                source: payload.source || "unknown", project: payload.project || null,
                session: payload.session || payload.session_id || null,
                timestamp: new Date(timestamp).toISOString(),
                availableAt: Number.isFinite(availableAt) ? new Date(availableAt).toISOString() : null,
                // Legacy turn timestamps can precede their assistant outcome.
                // These rows are discovery evidence, never retrospective features.
                temporalEvaluationEligible: Number.isFinite(availableAt) && availableAt <= asOf,
                title: clean(payload.title || payload.summary, 360),
                url: /^https?:\/\//.test(payload.url || "") ? payload.url : null,
                transcriptPath: payload.transcript_path || null,
                score: 0, matches: []
            });
            const entry = byId.get(key);
            entry.score += 1 / (60 + rank + 1);
            entry.matches.push({ facet: batch.facet, rank: rank + 1, cosine: hit.score });
        }
    }
    const sessions = new Map(), results = [];
    for (const item of [...byId.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))) {
        const key = item.session && `${item.collection}:${item.session}`;
        if (key && (sessions.get(key) || 0) >= perSession) continue;
        if (key) sessions.set(key, (sessions.get(key) || 0) + 1);
        results.push(item);
        if (results.length >= limit) break;
    }
    return results;
}

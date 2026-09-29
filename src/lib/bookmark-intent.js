import { normalizeIdentity } from "./revisit-model.js";

export const BOOKMARK_INTENT_KEY = "tabtopiaBookmarkIntentV1";
const DAY = 86400000;
const DEEP_VISIT_MS = 30000;

/** folderType is browser evidence; syncing and folder names are not device provenance. */
export function flattenBookmarkTree(tree) {
    const pages = [];
    const visit = (nodes, folderType = "unknown", folderPath = []) => {
        for (const node of nodes || []) {
            if (!node || typeof node !== "object") continue;
            const type = node.folderType || node.bookmarkFolderType || folderType;
            if (node.url) pages.push({ id: node.id, url: node.url, title: node.title,
                dateAdded: node.dateAdded, bookmarkFolderType: type,
                mobileFolder: type === "mobile", folderPath: node.folderPath || folderPath,
                syncing: typeof node.syncing === "boolean" ? node.syncing : null });
            else visit(node.children, type, node.title ? [...folderPath, node.title] : folderPath);
        }
    };
    visit(tree);
    return pages;
}

export class BookmarkIntentStudy {
    constructor(storage, { digest, isEnabled = () => false, now = Date.now } = {}) {
        this.storage = storage; this.digest = digest; this.isEnabled = isEnabled; this.now = now;
        this.chain = Promise.resolve(); this.generation = 0; this.focus = null;
    }
    serialize(operation) {
        const generation = this.generation;
        const run = this.chain.catch(() => {}).then(async () => {
            if (!this.isEnabled() || generation !== this.generation) return false;
            return operation(() => this.isEnabled() && generation === this.generation);
        });
        this.chain = run; return run;
    }
    async key(url) {
        const identity = normalizeIdentity(url);
        if (!identity || !/^https?:/.test(url)) return null;
        const key = await this.digest(`bookmark-intent-v1:${identity.page}`);
        return typeof key === "string" && /^[A-Za-z0-9_+/=-]{16,128}$/.test(key) ? key : null;
    }
    async load() {
        const state = (await this.storage.get([BOOKMARK_INTENT_KEY]))[BOOKMARK_INTENT_KEY];
        return state?.version === 1 ? structuredClone(state) : { version: 1, entries: {} };
    }
    syncBookmarks(tree) {
        return this.serialize(async valid => {
            const state = await this.load(), now = this.now();
            const pages = flattenBookmarkTree(tree).filter(page => normalizeIdentity(page.url))
                .sort((a, b) => Number(b.mobileFolder) - Number(a.mobileFolder) || (b.dateAdded || 0) - (a.dateAdded || 0));
            // One identity per page. Prefer the mobile-folder receipt, but a
            // newer save is a renewed intention even if another copy exists.
            const unique = new Map();
            for (const page of pages) {
                const identity = normalizeIdentity(page.url).page;
                const previous = unique.get(identity);
                if (!previous) unique.set(identity, { ...page });
                else previous.dateAdded = Math.max(previous.dateAdded || 0, page.dateAdded || 0);
            }
            const mobile = [...unique.values()].filter(page => page.mobileFolder).slice(0, 800);
            const other = [...unique.values()].filter(page => !page.mobileFolder).slice(0, 200);
            const next = {};
            for (const page of [...mobile, ...other]) {
                const key = await this.key(page.url);
                if (!key) continue;
                const savedAt = Number.isFinite(page.dateAdded) && page.dateAdded > 0 && page.dateAdded <= now ? page.dateAdded : 0;
                const old = state.entries[key];
                next[key] = old?.savedAt === savedAt ? { ...old, mobileFolder: page.mobileFolder }
                    : { savedAt, firstObservedAt: now, mobileFolder: page.mobileFolder, openedAt: 0, engagedAt: 0 };
            }
            if (!valid()) return false;
            await this.storage.set({ [BOOKMARK_INTENT_KEY]: { version: 1, entries: next } });
            return true;
        });
    }
    updateFocus(access) {
        return this.serialize(async valid => {
            const now = this.now();
            const key = access?.focused && !access.incognito ? await this.key(access.url) : null;
            if (!valid()) return null;
            if (!key) { this.focus = null; return null; }
            const state = await this.load(), entry = state.entries[key];
            if (!valid()) return null;
            if (!entry) { this.focus = null; return null; }
            if (this.focus?.key !== key || this.focus?.tabId !== access.tabId || now < this.focus.since
                || now - this.focus.checkedAt > DEEP_VISIT_MS + 5000) {
                this.focus = { key, tabId: access.tabId, since: now };
            }
            this.focus.checkedAt = now;
            const elapsed = now - this.focus.since;
            let changed = false;
            if (elapsed >= 2000 && !entry.openedAt) { entry.openedAt = now; changed = true; }
            if (elapsed >= DEEP_VISIT_MS && !entry.engagedAt) { entry.engagedAt = now; changed = true; }
            if (changed && valid()) await this.storage.set({ [BOOKMARK_INTENT_KEY]: state });
            const next = !entry.openedAt ? 2000 : !entry.engagedAt ? DEEP_VISIT_MS : 0;
            return next ? { remainingMs: Math.max(1, next - elapsed) } : null;
        });
    }
    evidence(pages) {
        return this.serialize(async () => {
            const state = await this.load(), result = {};
            for (const page of (Array.isArray(pages) ? pages : []).slice(0, 800)) {
                const entry = state.entries[await this.key(page.url)];
                if (entry) result[page.url] = { desktopOpenedAt: entry.openedAt, desktopEngagedAt: entry.engagedAt,
                    firstObservedAt: entry.firstObservedAt };
            }
            return result;
        });
    }
    summary() {
        return this.serialize(async () => {
            const state = await this.load();
            return { cohort: "bookmark-to-desktop-v1", deepVisitMs: DEEP_VISIT_MS,
                groups: [true, false].map(mobile => {
                    const entries = Object.values(state.entries).filter(entry => entry.mobileFolder === mobile);
                    return { source: mobile ? "mobile-folder" : "other-bookmarks", tracked: entries.length,
                        opened: entries.filter(entry => entry.openedAt).length,
                        engaged: entries.filter(entry => entry.engagedAt).length,
                        pending: entries.filter(entry => !entry.engagedAt).length,
                        overdue7d: entries.filter(entry => !entry.engagedAt && this.now() - (entry.savedAt || entry.firstObservedAt) > 7 * DAY).length };
                }) };
        });
    }
    async clear() {
        this.generation += 1; this.focus = null;
        await this.chain.catch(() => {});
        this.focus = null;
        await this.storage.remove(BOOKMARK_INTENT_KEY);
    }
}

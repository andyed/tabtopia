/**
 * Observations: claims an author, often an LLM, makes about a comparison,
 * each anchored to cells or items a person can open. The text is the
 * author's. Every number shown beside it is computed here, from the same
 * comparisonEvidence() rows the evidence export uses, so an observation can
 * point at evidence but cannot supply its own figures.
 *
 * Envelope, format "wunderkammer.observations", version 1:
 *   { format, version, comparison: <v1 comparison recipe>,
 *     observations: [{ id, text, evidence: { cells: [{ value, cohort? }], items: [key] } }] }
 * A cell without a cohort cites the value in every group.
 */
import { validateComparison, comparisonEvidence } from './comparison-model.mjs';

export const OBSERVATIONS_FORMAT = 'wunderkammer.observations';
export const OBSERVATION_LIMITS = Object.freeze({ observations: 12, text: 600, cells: 12, items: 200, problems: 25 });

const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));

export class ObservationError extends TypeError {
  constructor(problems, overflow = 0) {
    const total = problems.length + overflow;
    super(`Observations are not valid (${total} problem${total === 1 ? '' : 's'}):\n- ${problems.join('\n- ')}${overflow ? `\n- …and ${overflow} more` : ''}`);
    this.name = 'ObservationError';
    this.problems = problems;
  }
}

/**
 * Validate an envelope. Returns { comparison, observations }, with the
 * comparison validated by validateComparison(). Every problem is reported
 * with its path in one ObservationError.
 */
export function validateObservations(input) {
  const problems = [];
  let overflow = 0;
  const problem = (path, message) => { if (problems.length < OBSERVATION_LIMITS.problems) problems.push(`${path} ${message}`); else overflow++; };
  const text = (value, path, max) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max || CONTROL.test(value)) {
      problem(path, `must be a non-empty string of at most ${max} characters`); return null;
    }
    return value;
  };
  const keys = (value, path, allowed) => {
    if (!plain(value)) { problem(path, 'must be an object'); return false; }
    for (const key of Object.keys(value)) {
      if (FORBIDDEN.has(key) || !allowed.includes(key)) problem(`${path}.${key}`, `is not supported (supported: ${allowed.join(', ')})`);
    }
    return true;
  };

  if (!keys(input, 'envelope', ['format', 'version', 'comparison', 'observations'])) throw new ObservationError(problems);
  if (input.format !== OBSERVATIONS_FORMAT) problem('format', `must be "${OBSERVATIONS_FORMAT}"`);
  if (input.version !== 1) problem('version', 'must be 1');
  let comparison = null;
  try { comparison = validateComparison(input.comparison); } catch (error) { problem('comparison', `is not a valid recipe: ${error.message.replace(/^Comparison: /, '')}`); }

  const observations = [];
  const list = input.observations;
  if (!Array.isArray(list) || !list.length || list.length > OBSERVATION_LIMITS.observations) {
    problem('observations', `must be an array of 1 to ${OBSERVATION_LIMITS.observations} observations`);
  } else {
    const ids = new Map();
    list.forEach((o, i) => {
      const path = `observations[${i}]`;
      if (!keys(o, path, ['id', 'text', 'evidence'])) return;
      if (typeof o.id !== 'string' || !ID.test(o.id)) problem(`${path}.id`, 'must be 1–40 letters, digits, - or _, starting with a letter or digit');
      else if (ids.has(o.id)) problem(`${path}.id`, `repeats observations[${ids.get(o.id)}].id "${o.id}"`);
      else ids.set(o.id, i);
      const body = text(o.text, `${path}.text`, OBSERVATION_LIMITS.text);
      const out = { id: o.id, text: body, evidence: { cells: [], items: [] } };
      if (keys(o.evidence, `${path}.evidence`, ['cells', 'items'])) {
        const { cells = [], items = [] } = o.evidence;
        if (!Array.isArray(cells) || cells.length > OBSERVATION_LIMITS.cells) problem(`${path}.evidence.cells`, `must be an array of at most ${OBSERVATION_LIMITS.cells} cells`);
        else cells.forEach((cell, j) => {
          const p = `${path}.evidence.cells[${j}]`;
          if (!keys(cell, p, ['value', 'cohort'])) return;
          const value = text(cell.value, `${p}.value`, 2000);
          let cohort = null;
          if (cell.cohort !== undefined && cell.cohort !== null) {
            cohort = text(cell.cohort, `${p}.cohort`, 2000);
            if (cohort !== null && comparison && !comparison.groups.includes(cohort)) {
              problem(`${p}.cohort`, `"${cohort}" is not one of the comparison's groups (${comparison.groups.join(', ')})`);
            }
          }
          out.evidence.cells.push({ value, cohort });
        });
        if (!Array.isArray(items) || items.length > OBSERVATION_LIMITS.items) problem(`${path}.evidence.items`, `must be an array of at most ${OBSERVATION_LIMITS.items} item identities`);
        else items.forEach((key, j) => { if (text(key, `${path}.evidence.items[${j}]`, 4096) !== null) out.evidence.items.push(key); });
        if (Array.isArray(cells) && Array.isArray(items) && !cells.length && !items.length) problem(`${path}.evidence`, 'must cite at least one cell or item');
      }
      observations.push(out);
    });
  }
  if (problems.length || overflow) throw new ObservationError(problems, overflow);
  return { comparison, observations };
}

/**
 * Compute what an observation cites in the current comparison model. Figures
 * come from comparisonEvidence(); a value or group the model does not contain
 * is reported as unresolved, never dropped.
 */
export function resolveObservation(model, observation) {
  const figures = [], unresolved = [], keys = new Set(), places = new Set();
  const groups = new Set(model.cohorts.map(c => c.key));
  for (const cell of observation.evidence.cells) {
    if (cell.cohort !== null && !groups.has(cell.cohort)) { unresolved.push(`“${cell.cohort}” is not a group in this comparison`); continue; }
    const packet = comparisonEvidence(model, { value: cell.value });
    const row = packet.rows[0];
    if (!row) { unresolved.push(`“${cell.value}” is not among the measured values`); continue; }
    const denominators = new Map(packet.cohorts.map(c => [c.key, c.denominator]));
    for (const c of row.cells) {
      if (cell.cohort !== null && c.cohort !== cell.cohort) continue;
      figures.push({ value: row.value, cohort: c.cohort, count: c.count, denominator: denominators.get(c.cohort), share: c.share });
      for (const key of c.keys) { keys.add(key); places.add(`${c.cohort}\u0000${key}`); }
    }
  }
  const items = [];
  for (const key of observation.evidence.items) {
    if (model.clipsByKey.has(key)) { items.push(key); keys.add(key); } else unresolved.push(`item “${key.slice(0, 80)}” is not in this collection`);
  }
  // Corpus order, as selectEvidence() orders it.
  const ordered = [...model.clipsByKey.keys()].filter(key => keys.has(key));
  return { id: observation.id, text: observation.text, figures, items, unresolved, keys: ordered, places };
}

/** The clips an observation cites, in corpus order. */
export function observationEvidence(model, resolved) {
  return resolved.keys.map(key => model.clipsByKey.get(key));
}

/** The export packet for a selected observation: its text, computed figures and exact evidence. */
export function observationPacket(model, resolved) {
  const base = comparisonEvidence(model, {});
  const cited = [...new Set(resolved.figures.map(f => f.value))];
  return {
    ...base,
    selection: { observation: resolved.id },
    observation: { id: resolved.id, text: resolved.text, authored: true,
      figures: resolved.figures.map(({ value, cohort, count, denominator, share }) => ({ value, cohort, count, denominator, share })),
      items: [...resolved.items], unresolved: [...resolved.unresolved] },
    rows: cited.flatMap(value => comparisonEvidence(model, { value }).rows),
    evidenceCount: resolved.keys.length,
    evidence: resolved.keys.map(key => ({ key, title: String(model.clipsByKey.get(key)?.title || key) })),
  };
}

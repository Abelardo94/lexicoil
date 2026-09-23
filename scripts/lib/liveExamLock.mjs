/**
 * liveExamLock.mjs — what the assembler must not touch or reuse.
 *
 * The assembler used to rebuild every slot from scratch and only avoided
 * reusing a part *within one run*. A2 e2–e4 were assembled on 9 aug 2026 in a
 * run that did not know about the live e1, and each of them reused one of
 * e1's parts (lesen-t3-cur-health, horen-t4-cur-education, lesen-t2-cur-work):
 * the fidelity gate then failed on cross-exam passage duplicates.
 *
 * Live slots are read from the published catalog; their parts and passages
 * are reserved so new slots are built around them, and the live exams
 * themselves are never reassembled.
 */
import fs from 'node:fs';
import { localCatalogPath, localPublishedPath } from './publishedExamLib.mjs';

/**
 * Every passage id a part or record refers to: passage.id, passages[].id,
 * segments/questions passageId, ads passageId — wherever it sits.
 * @param {unknown} node
 * @param {Set<string>} [acc]
 * @returns {Set<string>}
 */
export function collectPassageIds(node, acc = new Set()) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const v of node) collectPassageIds(v, acc);
    return acc;
  }
  if (typeof node.passageId === 'string' && node.passageId) acc.add(node.passageId);
  if (node.passage && typeof node.passage.id === 'string' && node.passage.id) acc.add(node.passage.id);
  if (Array.isArray(node.passages)) {
    for (const p of node.passages) if (p && typeof p.id === 'string' && p.id) acc.add(p.id);
  }
  for (const v of Object.values(node)) if (v && typeof v === 'object') collectPassageIds(v, acc);
  return acc;
}

/**
 * Slots live in the published catalog, with the part ids and passage ids
 * their published manifests use.
 * @returns {{ slots: Set<number>, partIds: Set<string>, passageIds: Set<string>, missing: number[] }}
 */
export function loadLiveExamLocks(lang, level) {
  const out = { slots: new Set(), partIds: new Set(), passageIds: new Set(), missing: [] };
  const catalogPath = localCatalogPath(lang, level);
  if (!fs.existsSync(catalogPath)) return out;
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  for (const entry of catalog.exams || []) {
    if (entry.status !== 'live') continue;
    const slot = Number(entry.slot);
    if (!Number.isFinite(slot)) continue;
    out.slots.add(slot);
    const manifestPath = localPublishedPath(lang, level, entry.examId);
    if (!fs.existsSync(manifestPath)) {
      out.missing.push(slot);
      continue;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const part of manifest.parts || []) {
      if (part.partId) out.partIds.add(part.partId);
      collectPassageIds(part.snapshot, out.passageIds);
    }
  }
  return out;
}

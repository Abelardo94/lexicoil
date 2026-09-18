/**
 * Passages present in questions.json but not yet in passages.json / passageVocab.
 * Clear with enrich-bank-vocab-tags.mjs (content batch — post-gates plan).
 *
 * Vaciado el 18 sep 2026: el extractor cubre ya 428/428 pasajes de de/B1, que era
 * la condicion para vaciarlo. Los tres ids que habia aqui (`gen-l5-ca10ed0e`,
 * `gen-p-h2-6f343804`, `gen-l5-0bb98790`) no existian en el banco ni antes de la
 * pasada — eran pasajes retirados y la exclusion apuntaba a fantasmas. Se conserva
 * el mecanismo porque el siguiente lote de contenido volvera a necesitarlo.
 */
export const PASSAGE_VOCAB_ENRICH_BACKLOG = new Set([]);

/** @param {Array<{ id?: string }>} passages */
export function bankPassagesExcludingEnrichBacklog(passages) {
  return (passages || []).filter((p) => p?.id && !PASSAGE_VOCAB_ENRICH_BACKLOG.has(p.id));
}

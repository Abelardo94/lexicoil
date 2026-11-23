# C1 — bloqueantes Fase 3 (generación masiva)

**Estado:** no implementar hasta definir taxonomía.

## P2 — grammarTags C1

- No existe `C1_GRAMMAR_IDS` ni detectores en `enrichBatchMetadata.mjs`.
- `sanitizeGrammarTags` / inferencia no conocen prefijo `g-de-c1-*`.
- **Bloqueante:** definir taxonomía C1 (compact + seed) y cablear enrich por nivel **antes** de generación masiva C1 — mismo patrón que B2 y A2 (2026-07-27).

## Relacionado

- Anglicismos / blacklist: hoy B2+ comparte lógica de preguntas; C1 necesitará política propia.
- Ver `docs/B2-METADATA-TAXONOMY-AUDIT.md` sección P2 C1.

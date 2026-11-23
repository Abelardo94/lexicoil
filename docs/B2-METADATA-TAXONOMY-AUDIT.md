# Auditoría metadata / taxonomía — B2 (y riesgo C1)

**Fecha:** 2026-07-27 · **Alcance:** herencia silenciosa B1 en pipelines de enriquecimiento, no rutas de plantillas.

## P0 — Corregido en este ciclo

| Área | Síntoma | Causa | Fix |
|------|---------|-------|-----|
| `grammarTags` | Pilotos B2 con `g-de-b1-nebensatz`, etc. | `inferGrammarTagsFromText` solo iteraba `B1_GRAMMAR_IDS`; `sanitizeGrammarTags` solo aceptaba `g-de-b1-*` | Taxonomía B2 + `countGrammarSignalsB2` + inferencia por `level` |
| `fillGrammarDefaults` | Fallback Lesen T1 = nebensatz+perfekt B1 | `DEFAULT_GRAMMAR_BY_TEIL` sin rama B2 | `defaultGrammarTagsForTeil(teil, level)` |

## P1 — Conocido, no bloqueante Schreiben B2 inmediato

| Área | Síntoma | Notas |
|------|---------|-------|
| `_vocabTagsNormalizeVersion` | Sufijo `b1-validated` en batches A2/B2 | Normalizador de lemmas compartido; **no** fuerza banco B1 si `level` en pregunta es B2 |
| `topicsForLevel('B2')` | Mismos slugs B1 (`B1_TOPICS`) | Intencional hasta catálogo temático B2; no afecta grammarTags |
| `GrammarCategories.js` (eval Schreiben) | `categoryToGrammarTag(..., level)` genérico | Producción eval puede emitir `g-de-b2-*` si level=B2; alineado con taxonomía B2 |
| A2 `grammarTags` | Pool A2 aún etiqueta `g-de-b1-*` | Documentado en `A2-MISSING-GRAMMAR-TAGS-CLOSE.md`; taxonomía `g-de-a2-*` solo en reparaciones manuales |

## P2 — C1 / futuro

| Área | Riesgo |
|------|--------|
| Sin `C1_GRAMMAR_IDS` en enrich | Ítems C1 futuros → mismos tags B1 que B2 antes del fix |
| `GEMINI_API_COMPACT_de_C1.md` | Verificar si define prefijo `g-de-c1-*` antes de generación masiva |
| `questionBlacklistForLevel('C1')` | Usa `B2_QUESTION_BLACKLIST` (mismo que B2) — revisar si C1 necesita lista propia |
| `difficulty` Schreiben piloto | `4` coherente con compact B2 (4–7); B1 Schreiben usa 6 en normalize |

## Verificación recomendada antes de escalar B2

1. `npm run test:b2-grammar-tags` (inferencia B2 ≠ prefijo b1).
2. Pool B2: ningún `g-de-b1-*` en `batches/ready/pool-verified/B2/`.
3. Tras cada módulo nuevo: grep `level.*B2` + `_grammarTagsNormalizeVersion` ≥ v2.1.

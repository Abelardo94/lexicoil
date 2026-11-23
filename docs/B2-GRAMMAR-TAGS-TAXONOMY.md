# Taxonomía `grammarTags` — Goethe B2 (de)

**Fuente canónica IDs:** `batches/GEMINI_API_COMPACT_de_B2.md` · `library/de/B2/questions.json` (seed).

**Implementación:** `scripts/lib/enrichBatchMetadata.mjs` (`B2_GRAMMAR_IDS`, `countGrammarSignalsB2`, inferencia por `level: "B2"`).

| ID | Contenido B2 (Modellsatz / CEFR B2) | Señales heurísticas (consigna + explanation) |
|----|-------------------------------------|-----------------------------------------------|
| `g-de-b2-konj1` | Konjunktiv II presente / irreal presente | würde, könnte, sollte, müsste, dürfte… |
| `g-de-b2-konj2` | Konjunktiv II pasado / irreal pasado | hätte, wäre, ginge, käme, ließe, wüsste… |
| `g-de-b2-nominal` | Nominalisierung, sustantivos abstractos | -ung/-heit/-keit/-tion…; die …-ung |
| `g-de-b2-passiv` | Passiv (Vorgang/Zustand), incl. werden-Passiv | wurde/wird + Partizip II; Modal + werden |
| `g-de-b2-modus` | Modalverben en contexto complejo | Modal + Infinitiv (müssen … verreisen) |
| `g-de-b2-relativ` | Relativsätze (incl. Präposition) | worauf/womit; dessen/deren; Präp + Relativ |

**No reutilizar** prefijos `g-de-b1-*` en ítems con `level: "B2"`.

**A2 (estado 2026-07-27):** `A2_GRAMMAR_IDS` + `countGrammarSignalsA2` en enrich; pool re-etiquetado vía `re-enrich-a2-pool-grammar.mjs`. Ver `docs/A2-GRAMMAR-TAGS-TAXONOMY.md`.

**C1:** sin catálogo `g-de-c1-*` en enrich; cualquier ítem C1 heredaría B1 hasta definir taxonomía (ver auditoría metadata).

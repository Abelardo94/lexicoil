# A2 grammarTags taxonomy

**Contract:** `batches/GEMINI_API_COMPACT_de_A2.md`  
**Implementation:** `scripts/lib/enrichBatchMetadata.mjs` (`A2_GRAMMAR_IDS`, `countGrammarSignalsA2`, inference when `level: "A2"`).  
**Version stamp:** `v2.2-a2-b2-level-tags-2026-07-27`  
**Test:** `npm run test:a2-grammar-tags`

| ID | Focus |
|----|--------|
| `g-de-a2-praesens` | Präsens (Alltag) |
| `g-de-a2-perfekt` | Perfekt |
| `g-de-a2-modal` | Modalverben + Infinitiv |
| `g-de-a2-trennbar` | Trennbare Verben |
| `g-de-a2-dat-akk` | Dativ / Akkusativ |
| `g-de-a2-nebensatz` | Nebensätze (dass, weil, …) |
| `g-de-a2-komparativ` | Komparativ |

**Pool repair:** `node scripts/re-enrich-a2-pool-grammar.mjs --preview` then `--apply --confirm`.

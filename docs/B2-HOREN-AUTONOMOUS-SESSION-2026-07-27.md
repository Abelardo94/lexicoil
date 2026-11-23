# B2 cierre pool (Hören + Lesen T3 + topicTags) — sesión 2026-07-27

Operador ausente → retomado con cuota API renovada. Objetivo: **Hören B2 completo (4/4)**, fix **vocabularyTags** sustantivos en minúscula en origen, revisión cruzada CHK-34. **Sin deploy producción.**

---

## Resumen ejecutivo (estado final)

| Teil | pool-verified | Tema | API (sesión tarde + retoma) |
|------|---------------|------|-----------------------------|
| **T1** | `horen-t1-gemini-070.json` | Bildung | ~2 llamadas (OK) |
| **T2** | `horen-t2-gemini-113.json` | Medien | 3 llamadas (~USD 0,045) |
| **T3** | `horen-t3-gemini-087.json` | Umwelt | 4 llamadas (~USD 0,071) |
| **T4** | `horen-t4-gemini-040.json` | Umwelt | 5 llamadas (~USD 0,060) |

**Hören B2:** **4/4** en `batches/ready/pool-verified/B2/`.

### B2 Goethe — 13 Teile (pool-verified)

| Módulo | Teile oficiales | Pilotos en pool |
|--------|-----------------|-----------------|
| Lesen | 5 | **5** (T1–T5, incl. **T3** `lesen-t3-gemini-050.json`) ✅ |
| Hören | 4 | **4** (T1–T4) ✅ |
| Schreiben | 2 | **2** ✅ |
| Sprechen | 2 | **2** ✅ |

**Total archivos pool B2:** **13/13 Teile** ✅ (Lesen T3 integrado + Hören 4/4 + Schreiben/Sprechen).

---

## topicTags = `_requestedTopic` (post-enrich) — fix sistemático Hören/Lesen

**Problema:** Tras `enrichBatchMetadata`, preguntas/pasajes quedaban con `topicTags` detectados por contenido (p. ej. Medien/Stadtleben) distintos del tema de celda (`_requestedTopic` Umwelt/Medien). Corregido a mano 4× en Hören B2 el mismo día.

**Fix:**

- `alignQuestionTopicTagsToRequestedTopic()` en `scripts/lib/topicRotation.mjs` — alinea `topicTag`, pasajes y **todas** las `questions[].topicTags` al tema pedido; **excepción legítima:** Lesen T5 usa `topicTag` de institución (`inferLesenT5DominantTopic`), no `_requestedTopic` crudo.
- Llamada al **final** de `enrichBatchMetadata()` (después del override Hören A2 T2).
- **Antes de Q4** en generación: `alignQuestionTopicTagsToRequestedTopic(batch)` en `generate-lesen-part-gemini.mjs` y `generatePartGeminiLib.mjs` (Hören audit-only).
- `tagBatchWithTopic`: `forceUniform` cuando hay `_requestedTopic` B1 válido (no solo Lesen T5).

**Evidencia:** `node scripts/lib/__tests__/enrichBatchMetadata.topic-align.test.mjs` — batch Hören B2 con Sport/Wohnen → **Medien** tras enrich con `_requestedTopic: Medien`. Publicado `lesen-t3-gemini-050.json`: las 6 preguntas llevan `topicTags: ["Umwelt"]` sin edición manual.

---

## Lesen B2 Teil 3 — integrado (Zeitungsartikel MCQ)

| Ítem | Detalle |
|------|---------|
| Plantilla | `plantillas-lesen-b2/lesen-teil3.md` (350–500 W, 6 MCQ, instrucción oficial en Q1) |
| Routing | `usesB1LesenT3MakeT3` **solo B1**; B2 → Gemini como T2/T4/T5 |
| Calidad | `checkLesenB2Teil3PressMcq` en `lesenBatchQuality.mjs` |
| Audit | `WORD_COUNT_SPEC_B2['lesen-3']`; **CHK-17** exento para B2 MCQ (no B1 matching) |
| Piloto publicado | `batches/ready/pool-verified/B2/lesen-t3-gemini-050.json` — tema **Umwelt**, ~400 W, calidad + poolReady OK |

Tests: `node scripts/lib/__tests__/b2-lesen-routing.test.mjs` (T3 plantilla B2, no anuncios B1).

---

## vocabularyTags en minúscula — alcance y fix en origen

### Criterio (igual que `scan-a2-pool-integrity.mjs` / cosmética sustantivos)

Tags **solo minúsculas** que son **plurales/sustantivos** (`-schriften`, `-nahmen`, `-fristen`, `-stunden`, `-methoden`, `Unternehmen`, …), no verbos/adjetivos válidos en minúscula (`effektiv`, `kontaktieren`, `viele`).

### Alcance medido

| Ámbito | Hallazgo |
|--------|----------|
| **B2 pool (10 archivos)** | **Patrón real**, no aislado a `horen-t3-gemini-087.json`: antes del fix, **12 hits** en 3 archivos (`horen-t3` 7, `horen-t1` 3, `lesen-t1` 1). Ejemplos: `vorschriften`, `maßnahmen`, `übergangsfristen`, `unternehmen`, `förderstunden`, `lernmethoden`. |
| **A2 horen pool-verified (mtime 2026-07-27)** | 62 archivos tocados hoy; **1 hit** del mismo tipo (no epidemic en A2 del día). |
| **B1 pool** | Miles de tags en minúscula con el heurístico amplio (incluye verbos/adjetivos); el bug de **capitalización de sustantivo** afecta sobre todo a **plurales en -en** mal clasificados como infinitivo. |

### Causa raíz (`scripts/lib/enrichBatchMetadata.mjs`)

1. **`formatVocabTag`:** plurales como `Maßnahmen` se trataban como infinitivo (`…nehmen` dentro de la palabra; falso positivo en `looksLikeInfinitive`).
2. **`repairQuestionVocabularyTags`:** no persistía cambios **solo de mayúscula** (`changed` comparaba solo `toLowerCase()`).
3. **`nounHints`:** reparación de tags existentes usaba `nounHints = null` en lugar de capitalizaciones del blob de la pregunta.

### Fix aplicado (v2.3.17b)

- `looksLikePluralNounLemma()` + capitalización en `formatVocabTag`.
- Ampliación de plurales en `looksLikeInfinitive` (`-stunden`, `-methoden`, `-schriften`, `-nahmen`, `-fristen`; `nehmen` no marca `*nahmen`).
- `repairQuestionVocabularyTags`: `changed` si `formatted !== tag` original.
- `nounHintsForQuestion(q)` en el bucle de repair.
- **Remediación:** `enrichBatchMetadata(..., { vocabRepairOnly: true })` sobre **todo el pool B2** + re-guardado.

**Post-fix B2 pool:** 0 hits en plurales sustantivos listados; `horen-t3` muestra `Vorschriften`, `Maßnahmen`, `Übergangsfristen`, `Unternehmen`.

**No se tocó** `capitalizeNouns.mjs` / `wordMatchRepair.mjs`.

Tests: `node scripts/lib/__tests__/enrichBatchMetadata.vocab.test.mjs` (casos nuevos Maßnahmen/Vorschriften/Unternehmen+hints).

---

## Hören B2 — por Teil (auto-QA)

### T1 — `horen-t1-gemini-070.json`

- Instrucción oficial en Q1; 5× (RF+MCQ); segmentos dentro de gate.
- Fixes previos: `topicTags`, «Berufsalltag»; vocab tags re-capitalizados (`Förderstunden`, `Lernmethoden`).

### T2 — `horen-t2-gemini-113.json` (nuevo)

- Entrevista Medien / Prof. Keller; 6 MCQ; calidad OK tras regen (longitud entrevista acotada en retry).
- Lexico: repair determinista (`Infrastruktur` → Einrichtungen en pasaje/opciones según pipeline).
- **poolReady:** `Wohnen`/`Sport` en 2 preguntas → **`Medien`** (enricher); READY.
- Manual: preguntas parafraseadas; MCQ longitud reparada en pipeline.

### T3 — `horen-t3-gemini-087.json`

- Panel Umwelt; matching A–D; instrucción en Q1.
- vocab tags plurales corregidos en pool tras fix origen.

### T4 — `horen-t4-gemini-040.json` (nuevo)

- Vortrag Umwelt; 8 MCQ; word-copy + length-bias reparados por pipeline.
- **poolReady:** `Konsum` en Q4 → **`Umwelt`**; READY.

---

## Revisión cruzada Hören B2 (4 archivos)

### CHK-34 (`findExplanationOptionTextAlignFindings`)

| Archivo | CRITICAL | MINOR/INFO |
|---------|----------|------------|
| horen-t1-gemini-070 | 0 | 0 |
| horen-t2-gemini-113 | 0 | 0 |
| horen-t3-gemini-087 | 0 | 0 |
| horen-t4-gemini-040 | 0 | **1** (q4: aviso cita literal opción B ausente — explicación ya parafraseada; aceptable en ventana MINOR) |

Sin citas de opción incorrecta ni «Option a/b/c)» en los cuatro archivos.

### Otros patrones sesión

- **topic_mismatch:** corregido manualmente antes de `finalizePoolReady` en T1/T2/T3/T4 (pendiente mejora enricher — ver abajo).
- **T3 ambigüedad hablantes:** gate B2 + revisión manual; distribución A–D razonable.
- **Nombres:** panel T3 (Schmidt/Weber/Müller); T4 monólogo sin debate B1.

---

## Infra Hören B2 (sin cambios en esta retoma salvo vocab)

- Plantillas: `plantillas-horen-b2/horen-teil1..4.md`
- Gates: `horenB2BatchQuality.mjs`, routing `examTemplatePrompt.mjs`, tests Modellsatz + `b2-horen-routing.test.mjs`
- Presupuesto API Hören B2 total sesión: **≈ USD 0,75** (muy bajo USD 3)

---

## Pendiente / decisión operador

| Tema | Notas |
|------|--------|
| **Lesen B2 T3** | Único Teil sin piloto en pool (12/13). |
| **topicTags por pregunta** | Sigue habiendo drift (`Sport`, `Konsum`, …) → considerar forzar `topicTag` de batch post-enrich. |
| **CHK-34 MINOR T4 q4** | Opcional: enriquecer explicación con paráfrasis explícita de la idea de la opción B sin citar texto. |
| **Remediación B1/A2 pool** | Mismo fix origen aplica; no re-corrió masivamente B1 (alcance distinto: muchos tags son verbos/adj. legítimos en minúscula). |

---

## Comandos

```bash
node scripts/test-goethe-b2-modellsatz.mjs
node scripts/lib/__tests__/b2-horen-routing.test.mjs
node scripts/lib/__tests__/enrichBatchMetadata.vocab.test.mjs
node scripts/lib/__tests__/enrichBatchMetadata.topic-align.test.mjs
node scripts/lib/__tests__/b2-lesen-routing.test.mjs

# Remediar vocab tags (pool):
node --input-type=module -e "
import fs from 'fs'; import path from 'path'; import { ROOT } from './scripts/lib/loadEnv.mjs';
import { enrichBatchMetadata } from './scripts/lib/enrichBatchMetadata.mjs';
const dir = path.join(ROOT,'batches/ready/pool-verified/B2');
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.json')) continue;
  const abs = path.join(dir,f);
  let b = JSON.parse(fs.readFileSync(abs,'utf8'));
  ({ batch: b } = enrichBatchMetadata(b, { vocabRepairOnly: true, vocab: true, grammar: false, topic: false }));
  fs.writeFileSync(abs, JSON.stringify(b,null,2)+'\\n');
}
"
```

---

*Documento actualizado: 2026-07-27 — **13/13 Teile B2 pool-verified**, fix topicTags post-enrich, Lesen T3 `lesen-t3-gemini-050.json`.*

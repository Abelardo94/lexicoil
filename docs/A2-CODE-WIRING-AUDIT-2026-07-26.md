# Auditoría cableado A2 — 13 Teile (solo código, 0 API)

Fuente formato oficial: `library/blueprints/goethe_A2.json` (Modellsatz Goethe A2, structureVersion 3).  
Entrada generación pool: `generate-cli.mjs` → `poolFillTeilLib.generatePoolPart` → Lesen: `generateLesenPart` · Hören/Schreiben/Sprechen: `generateExamPartSingle`.

---

## Tabla por Teil

| Teil | Formato correcto A2 (blueprint) | Camino de código (`level='A2'`) | ¿Usa B1 indebidamente? | Gates calibrados A2 | Plantilla conectada |
|------|--------------------------------|----------------------------------|------------------------|---------------------|---------------------|
| **Lesen T1** | 1 Medientext ~120–200 W · **5× MCQ** a/b/c | `generateOnePart` → `generateLlmPart` → `buildLesenStaticCore` → `loadLesenTemplate(teil, A2)` | Reparaciones word-copy en `lesenTemplatePrompt.mjs` rotuladas **Goethe B1**; `vocab_narrative_incoherence` agresivo con cobertura floja (no es routing B1) | `checkLesenBatchQuality` → `checkMcq` (no ich-Blog); `WORD_COUNT_SPEC_A2`; MCQ length **8ch**; CHK-6c B1+; `checkLexical` banco A2 | **Sí** — `plantillas-lesen-a2/lesen-teil1.md` vía `buildLesenStaticCore` |
| **Lesen T2** | 1 Informationstafel · **5× MCQ** Stock/Etage | Mismo `generateLlmPart` | Fallback `TEMPLATE_SAFE_B1_WORDS` en `resolveGenerationInput.mjs` (nombre legacy; filtra banco **por level**) | `checkLesenA2Teil2` (Stock/Etage); MCQ distinct; length A2 | **Sí** — `lesen-teil2.md` |
| **Lesen T3** | 1 **E-Mail** · **5× MCQ** a/b/c | `generateOnePart`: si A2 → **no** `make-t3`; → `generateLlmPart` | **Corregido P0:** ya no `make-t3.mjs` ni `listT3BlueprintStockForTopic` en skip (con `levelFallback` en CLI) | `checkMcq` A2 T1/T3; length A2; publish CHK alineado | **Sí** — `lesen-teil3.md` |
| **Lesen T4** | **6 Anzeigen** + **5 matching** (1× X) · mini-situación+persona | `generateLlmPart`; `resolveT4GenerationMolds` → **null** en A2 | **Corregido P0:** sin `t4DebateSeeds`/foro; persiste riesgo **CHK-29**: corpus estructural T4 puede mezclar batches **foro B1** (`loadCleanStructuralCorpusFromDir` / pool B1) | `checkLesenA2Teil4`; sin `assessT4TopicAlignment` B1 en generación A2 | **Sí** — `lesen-teil4.md` (sin inject debate si no hay seed) |
| **Hören T1** | **5** textos cortos (×2) · **5× MCQ** a/b/c | `generateExamPartSingle` → `buildExamPrompt` → `loadExamTemplate('horen',1,A2)` | `HOREN_COMBINED_CALIDAD_LEXICO_TEILE` **no discrimina nivel** — no aplica combined a T1; fix-notes MCQ usan **HOREN_T12_ANTI_B2** (“vocabulario B1”) en A2 T1/T3 | **CHK-20** rama A2 (5×1 MCQ); calidad `checkHorenTeil1` genérica (≥2 passages, no exige 5 segmentos en calidad); MCQ length A2 | **Sí** — `plantillas-horen-a2/horen-teil1.md` |
| **Hören T2** | 1 diálogo · **5× matching** imágenes a–i | `buildExamPromptBundle`: ramas **A2** (`pickNextHorenT2Schedule`, picture matching) | Rotación apertura Hören T2 compartida con B1 (contenido prompt, no formato B1) | `checkHorenTeil2PictureMatching` + `HorenPictureMatching.validatePictureMatchingBatch`; **CHK-H2-ALIGN**; word-count `horen-2-a2` | **Sí** — `horen-teil2.md` |
| **Hören T3** | **5** diálogos cortos · **5× MCQ** | `buildExamPrompt` A2 checklist (5 segmentos) | **Combined calidad+léxico solo B1** (`HOREN_COMBINED…` teile 1,3,4 sin `level`) → A2 T3 gate **secuencial** calidad→léxico | `checkHorenA2Teil3` (15–50 W, segmentLabel); MCQ length A2; CHK-20 N/A | **Sí** — `horen-teil3.md` |
| **Hören T4** | 1 **Radiointerview** (×2) · **5× Ja/Nein** | `buildExamPrompt` A2 | **`isHorenCombinedCalidadLexicoTeil(4)` activo para A2** → fix-notes **B1 T4 debate** (`HOREN_T4_ANTI_LENGTH` 450 W, `buildHorenT4TopicAnchor`); nombres invitados rotación estilo B1 T4 | `checkHorenA2Teil4` (150–250 W, ja_nein); audit skip matching B1 en A2 | **Sí** — `horen-teil4.md` |
| **Schreiben T1** | **SMS** 20–30 W · 3 puntos | `generateExamPartSingle` (1 parte/teil A2) → `buildExamPrompt(..., level A2)` | **`buildExamVariableSuffix` añade siempre** bloques **Schreiben B1 T3** (`buildSchreibenT3PremiseExclude`, `buildSchreibenT3NamesPromptBlock`) a **todo** Schreiben incl. A2 T1 | Checklist A2 SMS en `examTemplatePrompt`; `assertSchreibenNoPlaceholders`; validate-batch `BLUEPRINT_A2` | **Sí** — `plantillas-schreiben-a2/schreiben-teil1.md` |
| **Schreiben T2** | **E-Mail al Chef** 30–40 W | Igual T1 | Mismos bloques **B1 T3** en suffix Schreiben | Checklist A2 E-Mail Chef | **Sí** — `schreiben-teil2.md` |
| **Sprechen T1** | 4 Karten (Geburtstag, Wohnort, Beruf, Hobby) | `isSprechenA2PerTeil` → prompt por teil → `loadExamTemplate` | `buildSprechenPremiseExcludePromptBlock` orientado pool B1 (exclusión premisas); no cambia formato JSON A2 | Checklist A2 en `examTemplatePrompt`; dedup `assertSprechenPremiseUnique` | **Sí** — `sprechen-teil1.md` |
| **Sprechen T2** | 1 Karte **about_self** / erzählen | Idem | Idem premisa exclude B1 pool | Checklist A2 T2 | **Sí** — `sprechen-teil2.md` |
| **Sprechen T3** | **plan_together** (pareja) | Idem | Idem | Checklist A2 T3; `assertSprechenPerspectiveClean` | **Sí** — `sprechen-teil3.md` |

---

## Veredicto binario por Teil

| Teil | Veredicto | Problema concreto (si ❌) |
|------|-----------|---------------------------|
| Lesen T1 | ✅ | — (deuda menor: textos repair B1 en prompts auxiliares) |
| Lesen T2 | ✅ | — |
| Lesen T3 | ✅ | — (post P0; requiere `levelFallback` en preflight CLI) |
| Lesen T4 | ✅ | — |
| Hören T1 | ✅ | — |
| Hören T2 | ✅ | — |
| Hören T3 | ✅ | — |
| Hören T4 | ✅ | — |
| Schreiben T1 | ✅ | — |
| Schreiben T2 | ✅ | — |
| Sprechen T1 | ✅ | — (exclude premisas B1 es ruido, no cambia molde A2) |
| Sprechen T2 | ✅ | — |
| Sprechen T3 | ✅ | — |

**Resumen conteo:** **13 ✅** · **0 ❌** (verificado estático 2026-07-26 post-fixes; generación real pendiente de crédito API).

### Fixes aplicados (2026-07-26)

1. **Lesen T4 CHK-29:** molde A2 `a2_anzeigen` + corpus filtrado por `level` (`partGate`, `structuralMoldDedup`).
2. **Hören T1:** `checkHorenA2Teil1` (5 passages + 5 MCQ × segmento).
3. **Hören T3/T4 combined:** `horenCombinedCalidadLexico.mjs` con A2 T1/T3/T4 explícitos.
4. **Hören T4 fix-notes:** rama A2 (entrevista Ja/Nein) vs B1 debate en `buildExamFixNote`.
5. **Schreiben A2:** bloques B1 T3 solo si `level === 'B1'` (`examTemplatePrompt`, `generatePartGeminiLib`).

Tests: `node scripts/lib/__tests__/a2-wiring-fixes.test.mjs`

- Pick cobertura: `coverageRegistry` + `loadVocabBankLemmaSet(lang, level)` → **`library/vocab/de/A2.json`** (600 lemas).
- Filtro prompt: `sanitizePromptTargetWords` / `filterPromptTargetWords` con **`requireBank: true`** y `level` del CLI.
- Temas: mismos slugs B1 (`B1_TOPICS`) — **intencional** en `levelPlanner.mjs`, no mezcla de banco.

---

## Comandos de verificación (0 API)

```bash
node scripts/lib/__tests__/a2-lesen-routing.test.mjs
node scripts/generate-cli.mjs --level A2 --cell lesen-t3 --dry-run --topic Medien
```

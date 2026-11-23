# Auditoría cableado B2 — 13 Teile (solo código, 0 API)

**Fecha:** 2026-07-26  
**Formato oficial:** `library/blueprints/goethe_B2.json` (Goethe-Zertifikat B2 Modellsatz Erwachsene, `structureVersion: 3`)  
**Entrada generación pool:** `generate-cli.mjs` → `poolFillTeilLib.generatePoolPart` → Lesen: `generateLesenPart` (`generate-lesen-part-gemini.mjs`) · Hören/Schreiben/Sprechen: `generateExamPartSingle` (`generatePartGeminiLib.mjs`)  
**Baseline activo:** [`B2-PLAN-BASELINE-F0-F1.md`](./B2-PLAN-BASELINE-F0-F1.md) (lecciones L1–L12, 14 dimensiones)

**Evidencia ejecutada (sin API):**

- `npm run test:goethe-b2-modellsatz` → PASS  
- `node scripts/lib/__tests__/b2-wiring-trace.mjs` → paths + flags (2026-07-26)  
- `node scripts/generate-cli.mjs --level B2 --cell lesen-t3 --dry-run --topic Umwelt` → planifica celda B2; cobertura 0 partes; **no** ejecuta Gemini  

---

## Tabla plan — 13 Teile × 4 columnas

| Teil | 1 · Formato B2 (blueprint) | 2 · Plantilla propia | 3 · Banco vocab B2 | 4 · Ruteo confirmado sin B1 |
|------|----------------------------|----------------------|--------------------|-----------------------------|
| **Lesen T1** | Foro: 4 personas, **9** matching, repetible | ❌ `plantillas-lesen-b1/lesen-teil1.md` (blog ich B1) | ✅ `library/vocab/de/B2.json` en CLI | ❌ `generateLlmPart` + reglas longitud B1 (`TEIL_LENGTH_RULES` T1 blog) |
| **Lesen T2** | Artículo: **6** inserciones, 8 frases, 2 sobran | ❌ `lesen-teil2.md` B1 (2 textos prensa) | ✅ banco B2 | ❌ mismo camino LLM B1 |
| **Lesen T3** | Artículo prensa **6× MCQ** | ❌ `lesen-teil3.md` B1 | ✅ banco B2 | ❌ **`usesB1LesenT3MakeT3('B2',3)===true`** → `make-t3.mjs` (Anzeigen B1), no MCQ B2 |
| **Lesen T4** | **6** opiniones ↔ **8** headlines | ❌ `lesen-teil4.md` B1 (foro ja/nein) | ✅ banco B2 | ❌ **`usesB1LesenT4DebateSeeds('B2',4)===true`** → seeds foro/debate B1 |
| **Lesen T5** | Reglamento: **3** párrafos ↔ 7 headings | ❌ `lesen-teil5.md` B1 (T5 distinto) | ✅ banco B2 | ❌ LLM B1 + rotación T5 B1 (`injectT5PromptVariants`) |
| **Hören T1** | **5** segmentos × (RF+MC) = **10**, 1 play | ❌ `plantillas-horen-b1/horen-teil1.md` | ✅ banco B2 | ❌ plantilla B1; calidad `checkHorenTeil1` rama **B1** (no A2; no B2); combined **set B1** |
| **Hören T2** | Entrevista **6× MCQ**, 2 plays | ❌ `horen-teil2.md` B1 (monólogo 5 MCQ, 1 play) | ✅ banco B2 | ❌ `checkHorenTeil2` B1 monólogo |
| **Hören T3** | Panel **6×** speaker matching, 1 play | ❌ `horen-teil3.md` B1 (diálogo 7 RF) | ✅ banco B2 | ❌ gates B1 T3; combined B1 |
| **Hören T4** | Vortrag **8× MCQ**, 2 plays | ❌ `horen-teil4.md` B1 (debate matching 8) | ✅ banco B2 | ❌ `checkHorenTeil4` B1; fix-notes estilo **B1 T4 debate** vía combined B1 |
| **Schreiben T1** | Foro ≥150 W | ❌ `schreiben-b1.md` (3 tareas B1) | ✅ banco B2 | ❌ `examTemplatePath` → monolito B1; suffix puede incluir bloques **Schreiben B1 T3** si `level!=='A2'` |
| **Schreiben T2** | Mensaje jefe ≥100 W | ❌ mismo `schreiben-b1.md` | ✅ banco B2 | ❌ idem |
| **Sprechen T1** | Vortrag (paired) | ❌ `sprechen-b1.md` (3 tareas B1) | ✅ banco B2 | ❌ monolito B1, no 2 Teile B2 |
| **Sprechen T2** | Diskussion | ❌ mismo `sprechen-b1.md` | ✅ banco B2 | ❌ idem |

**Resumen 4 columnas:** formato blueprint ✅ en las 13 filas · plantilla propia **0/13** · banco vocab **13/13** (archivo existe; cobertura pool 0) · ruteo sin B1 **0/13**.

---

## Tabla detallada (formato A2 — cableado y gates)

| Teil | Formato correcto B2 | Camino de código (`level='B2'`) | ¿Usa B1 indebidamente? | Gates calibrados B2 | Plantilla conectada |
|------|---------------------|----------------------------------|------------------------|---------------------|---------------------|
| **Lesen T1** | Foro 4 personas · **9** matching | `generateOnePart` → `generateLlmPart` → `buildLesenStaticCore` → `loadLesenTemplate(teil,'B2')` → dir **B1** | Longitud/consigna **ich-Blog B1** en `TEIL_LENGTH_RULES`; T4/T5 inject B1 | `checkLesenBatchQuality` sin rama B2; MCQ length **fallback B1**; narrative **B1-lesen-t1** | ❌ B1 `lesen-teil1.md` |
| **Lesen T2** | Inserción **6** gaps | `generateLlmPart` | Plantilla B1 T2 (2 textos MCQ) | Sin `checkLesenB2*`; word-count B1 | ❌ B1 `lesen-teil2.md` |
| **Lesen T3** | Prensa **6× MCQ** | `generateOnePart`: **`make-t3`** si B1 path | **P0:** `a2LesenGeneration` solo excluye **A2** → B2 entra en **make-t3** | Gates T3 B1 blueprint stock | ❌ B1 (o make-t3 sin plantilla B2) |
| **Lesen T4** | Opiniones ↔ headlines | `generateLlmPart` + debate seeds B1 | **P0:** `usesB1LesenT4DebateSeeds(B2)` true; CHK-29 foro B1 | `assessT4TopicAlignment` B1; sin `checkLesenB2Teil4` | ❌ B1 `lesen-teil4.md` |
| **Lesen T5** | Reglas ↔ headings | `generateLlmPart` | Moldes T5 B1 | CHK-29 T5 B1 | ❌ B1 `lesen-teil5.md` |
| **Hören T1** | 5× (RF+MC)=10 | `generateExamPartSingle` → `buildExamPrompt` → `loadExamTemplate('horen',1,'B2')` | Plantilla + `EXAM_LENGTH_RULES.horen[1]` **B1**; combined **B1** | CHK-20 / `checkHorenTeil1` **B1** (coincidencia parcial 10 ítems, formato distinto) | ❌ B1 `horen-teil1.md` |
| **Hören T2** | Interview 6 MCQ ×2 | `buildExamPromptBundle` | Aperturas T2 B1; reglas longitud B1 monólogo | `checkHorenTeil2` B1 (5 MCQ) | ❌ B1 `horen-teil2.md` |
| **Hören T3** | Panel 6 matching | `buildExamPrompt` | Combined B1; bloques openings B1 T3 | `checkHorenTeil3` B1 (7 RF) | ❌ B1 `horen-teil3.md` |
| **Hören T4** | Vortrag 8 MCQ ×2 | `buildExamPrompt` | Combined B1 → fix-notes **debate B1** | `checkHorenTeil4` B1 (8 matching speakers) | ❌ B1 `horen-teil4.md` |
| **Schreiben T1** | Foro 150+ W | `generateExamPartSingle` → `buildExamPrompt(..., B2)` | **`schreiben-b1.md`**; suffix Schreiben T3 B1 si no A2 | Checklist / word targets **B1** (`EXAM_LENGTH_RULES.schreiben.all`) | ❌ B1 monolito |
| **Schreiben T2** | Chef 100+ W | Idem | Idem | Idem | ❌ B1 monolito |
| **Sprechen T1** | Vortrag | `buildExamPrompt` | `sprechen-b1.md`; premisa exclude pool B1 | Checklist **B1** 3 Teile | ❌ B1 monolito |
| **Sprechen T2** | Diskussion | Idem | Idem | Idem | ❌ B1 monolito |

---

## Veredicto binario por Teil

| Teil | Veredicto | Problema concreto |
|------|-----------|-------------------|
| Lesen T1 | ❌ | Plantilla + reglas B1 blog; no foro 9 ítems |
| Lesen T2 | ❌ | Plantilla B1; no sentence insertion B2 |
| Lesen T3 | ❌ | **Ruteo make-t3 B1** (`usesB1LesenT3MakeT3`) |
| Lesen T4 | ❌ | **Debate seeds B1** + plantilla foro B1 |
| Lesen T5 | ❌ | Plantilla T5 B1 |
| Hören T1 | ❌ | Plantilla B1; gates B1 |
| Hören T2 | ❌ | Plantilla/gate monólogo B1 vs entrevista B2 |
| Hören T3 | ❌ | Plantilla/gate B1 RF vs panel matching B2 |
| Hören T4 | ❌ | Plantilla/gate debate B1 vs Vortrag MCQ B2 |
| Schreiben T1 | ❌ | `schreiben-b1.md` + reglas 3 Teile B1 |
| Schreiben T2 | ❌ | Idem |
| Sprechen T1 | ❌ | `sprechen-b1.md` |
| Sprechen T2 | ❌ | Idem |

**Conteo:** **0 ✅ · 13 ❌** (auditoría estática 2026-07-26; coherente con INFRA-PARITY dry-run Hören B2 → plantilla B1).

---

## ❌ P0 — bloqueantes antes de plantillas / API (prioridad)

Generar con `--level B2` **hoy** produciría contenido con forma B1 o pipelines B1-only. Resolver en **F2** en este orden:

| P0 | Ámbito | Evidencia | Acción requerida (F2+, no hecho aquí) |
|----|--------|-----------|----------------------------------------|
| **P0-1** | Lesen T3 | `usesB1LesenT3MakeT3('B2',3)===true` (`a2LesenGeneration.mjs`) | Tratar B2 como A2: Gemini + plantilla B2; **nunca** `make-t3` |
| **P0-2** | Lesen T4 | `usesB1LesenT4DebateSeeds('B2',4)===true` | Excluir B2 de debate seeds; molde `b2_opinion_headline` |
| **P0-3** | Plantillas 13 celdas | `b2-wiring-trace.mjs`: todas `plantillas-*-b1` | Crear `plantillas-{lesen,horen,schreiben,sprechen}-b2` + dirs en `lesenTemplatePrompt` / `examTemplatePrompt` |
| **P0-4** | Hören calidad + combined | `checkHorenBatchQuality`: solo A2/B1; `isHorenCombinedCalidadLexicoTeil` → set B1 para B2 | Ramas B2 por Teil + set combined B2 + fix-notes B2 |
| **P0-5** | Lesen calidad + longitud | `TEIL_LENGTH_RULES` B1; `LENGTH_BIAS_BY_LEVEL` sin B2 | Reglas B2 por Teil + calibración MCQ B2 |
| **P0-6** | Schreiben/Sprechen path | `examTemplatePath`: B2 → `*-b1.md` | Per-teil B2 (2+2) como A2 |
| **P0-7** | Infra volumen | `pool-verified/B2/` vacío; sin `data/coverage/weak-de_B2.json` | Weak file + seed smoke (F5); **no** bloquea escribir plantillas, sí bloquea `--from-coverage` masivo |

**No P0 (F2/F3 deuda, no generar aún):** topics solo `B1_TOPICS` (`levelPlanner.mjs`); `isAutoPublishLevelSupported` sin B2; render UI no validado con batches B2; vocab narrative perfil B1 default.

---

## Matriz 14 dimensiones — resumen por Teil

Todas las celdas comparten: **(10)** banco archivo OK · **(14)** pool weak/publish ❌. Resto ❌ o ⚠ salvo **(1)** formato blueprint ✅.

---

## Comandos de verificación (0 API)

```bash
npm run test:goethe-b2-modellsatz
node scripts/lib/__tests__/b2-wiring-trace.mjs
node scripts/generate-cli.mjs --level B2 --cell lesen-t3 --dry-run --topic Umwelt
node scripts/assemble-from-pool-verified.mjs --level B2 --dry-run   # FATAL: sin pool-verified/B2
node -e "import { usesB1LesenT3MakeT3, usesB1LesenT4DebateSeeds } from './scripts/lib/a2LesenGeneration.mjs'; console.log({t3:usesB1LesenT3MakeT3('B2',3), t4:usesB1LesenT4DebateSeeds('B2',4)});"
```

---

## Referencias código

| Tema | Archivo |
|------|---------|
| Layout 13 celdas | `scripts/lib/examLevelCells.mjs` (`B2`) |
| Fallback plantillas Lesen | `scripts/lib/lesenTemplatePrompt.mjs` → `LESEN_TEMPLATE_DIRS` sin B2 |
| Fallback Hören/Schreiben/Sprechen | `scripts/lib/examTemplatePrompt.mjs` → `resolveModuleDir` / `examTemplatePath` |
| make-t3 / T4 debate | `scripts/lib/a2LesenGeneration.mjs` (solo excluye A2) |
| Combined Hören | `scripts/lib/horenCombinedCalidadLexico.mjs` |
| Modellsatz test | `scripts/test-goethe-b2-modellsatz.mjs` |

*Documento Fase 1 — sin plantillas, sin gates nuevos, sin generación API.*

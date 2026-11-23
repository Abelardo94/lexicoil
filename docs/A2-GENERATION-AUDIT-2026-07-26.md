# Auditoría A2 — production-readiness + generación (26 jul 2026)

Comparación directa con [`docs/B1-GENERATION-AUDIT-2026-07-25.md`](B1-GENERATION-AUDIT-2026-07-25.md) y estado previo [`docs/A2-STATE-AUDIT-2026-07-22.md`](A2-STATE-AUDIT-2026-07-22.md).

**Generación real (13 celdas A2):**

| Fase | Comando | Log |
|------|---------|-----|
| Smoke Lesen (parcial) | `generate-cli.mjs --level A2 --smoke --publish --reset --max-attempts 12 --max-api-calls 250` | `batches/logs/audit-a2-exhaustive-2026-07-26.log` (UTF-16, Tee-Object) |
| Continuación 10 celdas | Mismo binario, `--cell …` **sin `--reset`** (no toca checkpoint B1 del operador) | `batches/logs/audit-a2-exhaustive-2026-07-26-continuation.log` (UTF-8) |

Parser: `node scripts/parse-a2-audit-log.mjs [logPath]` (UTF-16/UTF-8).

**Estado al redactar:** Lesen T1–T3 agotaron cupo en fase 1; Lesen T4 + Hören/Schreiben/Sprechen en fase 2 (en curso). **0/13 publicadas en Lesen hasta intento 12 (T1–T2) o agotamiento de catálogo (T3).**

---

## 1 — Re-auditoría de los 7 sistemas (A2, 26 jul)

### 1.1 Pipeline de generación

| Aspecto | 22 jul | 26 jul |
|---------|--------|--------|
| Entrada volumen B1 | `generar-hasta-50.ps1` → B1 hardcoded | **Sin cambio** — A2 no entra en ese loop |
| Entrada A2 operativa | Seed curado / `_generar.cmd` Claude | **`generate-cli.mjs --level A2`** + `generate-lesen-part-gemini.mjs` / `generatePartGeminiLib.mjs` — **smoke ejecutado OK** |
| Plantillas Lesen/Hören A2 | INFRA: faltaban T1/T3 Lesen | **Completas** — `plantillas-lesen-a2/` T1–4, `plantillas-horen-a2/` T1–4 |
| Routing Lesen T3 | — | **Bug estructural:** `generateOnePart` → `generateT3Part` → **`make-t3.mjs` (B1 anuncios A–J)** para **todos** los niveles; A2 T3 = email MCQ vía Gemini (`plantillas-lesen-a2/lesen-teil3.md`) |
| Routing Lesen T4 | — | **Bug estructural:** semillas **`t4DebateSeeds` / foro B1** (`lesenT4SeedStock.mjs`, default `level: 'B1'`) mientras calidad exige **matching Anzeigen A2** (`mini-situación y persona`) |
| Fixes B1 recientes | No en path A2 (22 jul) | **Parcial:** CHK-33 `gate: true` global en `audit-pass-2.mjs` → **beneficia publish A2**; word-copy Hören repair → código level-agnostic pero **`HOREN_COMBINED_CALIDAD_LEXICO_TEILE = {1,3,4}` solo aplica gate combinado en B1** (`generatePartGeminiLib.mjs`) — **A2 Hören T1/T3 siguen secuencial calidad→léxico** |
| `--from-coverage` | No wired A2 | **Activo** en smoke A2 (registro 115 partes, 6 palabras/celda) |

### 1.2 Pool (`pool-verified` A2)

| Métrica | 22 jul | 26 jul |
|---------|--------|--------|
| Archivos totales | 41 (97,5% `-cur-`) | **68** (más gemini Hören/Lesen; horen_2=17, horen_3=14) |
| Stock bruto por celda | ≥4 casi todas | `audit-a2-pool-stock.mjs`: lesen_1=6, lesen_2=4, … sprechen_3=7 |
| Ensamblado dry-run | **0 exámenes** (horen_2=0 post-gates) | **1 examen posible** — cuello **lesen_2=1** post-gates (`assemble-from-pool-verified.mjs --level A2 --dry-run`) |
| audit-pass-2 pool | — | **0 CRITICAL**, 13 IMPORTANT, 34 MINOR cosmético, 21 limpios / 68 |

**Mejora agnóstica de nivel:** gates publish MCQ length alineados (CHK-33). **Persisten** skips curados: CHK-14/14b, topic T4 foro vs tema, MCQ length en horen-t1-cur, «billiger» en horen T4.

### 1.3 Traducciones

Sin regresión detectada en esta sesión: motor de examen comparte capa i18n con B1; **no hay pipeline de generación A2 que escriba traducciones nuevas en volumen**. Riesgo igual que B1: calidad de `explanation` Hören curado (skip «no está en alemán» en horen-t2 cur).

### 1.4 Vocabulario (banco + cobertura)

| Check | 22 jul | 26 jul |
|-------|--------|--------|
| Banco A2 | 600 lemas | **600** (`library/vocab/de/A2.json`) |
| Cobertura blobs | 0 partes medibles | **`vocab-coverage-report --level A2 --source seed`:** 115 partes indexadas por seed/pool; métrica global sigue **600/600 «sin cubrir»** en agregado (weak-de_A2.json regenerado) |
| Typos heredados (patrón B1 `arbeitsnehmer`) | No auditado | **No** aparece en A2.json; **no** escaneo exhaustivo de pares duplicados A2 en esta sesión |
| Gate generación | — | **`vocab_narrative_incoherence`** domina Lesen T1 smoke (tema Reisen + palabras forzadas desde cobertura) |

### 1.5 Separables

Motor **`js/engine/separableResolve.js`**: allowlist **sin discriminar CEFR** — aplica igual en exámenes A2 publicados. Sin cambios ni gaps A2-specific vs 22 jul.

### 1.6 vocab-bg (personalización)

| Aspecto | 22 jul | 26 jul |
|---------|--------|--------|
| Trigger prod | Hardcode B1, sin `level` en payload | **`vocab-bg-generate-background.js`:** `level = body.level \|\| resolveBgLevelFromPending(..., 'B1')` — **mejor que doc 22 jul** si pending trae A2 |
| Evidencia en pool A2 | 0× `bgGenerated` | **Sin cambio** en grep pool/seed A2 |
| Runner | Paramétrico | **`planVocabBgGeneration.mjs`** sigue default `'B1'` si ctx sin level |

**Veredicto:** conectado de forma **paramétrica**, pero **A2 no es first-class en prod** hasta que el trigger pase `level: A2` y exista cola pending A2.

### 1.7 Pagos / catálogo comercial

No re-ejecutado en esta sesión; paridad de producto A2 vs B1 sigue la del repo (exámenes `official-de-A2-*` en published cuando existen). **No bloqueante** para generación pool; ensamblado **1 examen** local posible mejora oferta técnica vs 22 jul.

### 1.8 Gates live A2

`verify-a2-gates-live.mjs` (26 jul): umbrales MCQ **A2** `{ minPct: 20, minChars: 8, batchFailCount: 2 }`; fallos de ejemplo en slice real: **word-copy** + **MCQ length** + **B1+ inject** (`Herausforderung` en pregunta A2).

---

## 2 — Generación real: evidencia por Teil (13 celdas)

### 2.1 Lesen T1 · tema Reisen · **12/12 FAIL**

| Int | Motivo terminal (generate) |
|-----|----------------------------|
| 1–3, 5–12 | `vocab_narrative_incoherence` (koffer, tourist, bahnsteig, ausland, …) |
| 4 | Regla **B1** en calidad: «T1 debe ser relato **ich** (blog/diario)» — **conflicto con prompt A2 Medientext 3ª persona** |

### 2.2 Lesen T2 · tema Stadtleben · **12/12 FAIL**

| Patrón | Intentos (ej.) |
|--------|----------------|
| Contrato MCQ / JSON | `[balanceMcqGroup:contract:b] q[0] missing correct letter`; JSON raíz sin `questions` |
| Molde A2 T2 | Stock/Etage: «mínimo 4/5 preguntas con fórmula Stock/Etage»; «opción **anderer Stock**» |
| mcq_distinct | Opciones A/C jaccard 0,5–1,0; patches CUBO C rechazados |
| Sesgo respuesta | 100% correctas «a» |
| FRENO archivo | Intento 10: ≥10 llamadas en un mismo JSON |

### 2.3 Lesen T3 · rotación masiva · **6 intentos celda, 0 publicadas**

| Int | Motivo |
|-----|--------|
| 1 | Topic mismatch: contenido T3 situaciones «Bildung» ≠ «Verkehr» |
| 2–5 | Rotación: **⏭ sin stock blueprint** (16 temas saltados) — catálogo B1 agotado/dedup |
| 6 | Blueprint `bp-schuhe-mode` (Konsum) — calidad situación↔anuncio; **`T3 generator exhausted after 8 attempts`** |
| — | **`missing_grammarTags`** en intentos intermedios |

**Confirmación:** A2 usa **`make-t3` + blueprints B1** — no es bucle infinito por `--topic` solo, pero **mismo patrón de fondo que B1:** tema forzado + stock agotado + intentos quemados en rotación.

### 2.4 Lesen T4 · tema Verkehr · **≥4 intentos, 0 publicadas** (fase 1 + continuación)

| Motivo recurrente | Detalle |
|-------------------|---------|
| Pipeline incorrecto | Log: **T4 seed foro** «Bus und Bahn…», «Forum zur Frage», nombres AUD-5 — **formato debate B1** |
| Gate A2 | `Lesen A2 T4: mínimo 4/5 enunciados con mini-situación y persona (tiene 0)` — **100% de intentos con API** |
| Secundarios | JSON inválido; caps «Klasse», «online» |

### 2.5 Hören T1–T4, Schreiben T1–2, Sprechen T1–3

**En ejecución** en `audit-a2-exhaustive-2026-07-26-continuation.log` (desde ~19:04 UTC). Actualizar con:

```bash
node scripts/parse-a2-audit-log.mjs batches/logs/audit-a2-exhaustive-2026-07-26-continuation.log
```

**Expectativa vs B1 (código):**

- **MCQ length:** publish alineado (fix B1); generación A2 umbral 8ch — **no** doble config B1-style 12ch vs gate false.
- **Word-copy / RF Hören:** reparaciones P1 B1 aplican al código Hören genérico; **A2 T1 = 5×MCQ** (plantilla) — distinto mix que B1 T1.
- **Gate secuencial Hören:** **sí, mismo problema que B1 pre-combined** — A2 **no** está en `HOREN_COMBINED_CALIDAD_LEXICO_TEILE`.
- **date_weekday / topic_mismatch audit-only:** probable en Hören A2 igual que B1 (ver log continuación).

---

## 3 — Patrones de fallo agrupados (A2, evidencia log)

| Patrón | ¿Igual que B1 audit 25 jul? | Teile A2 afectados (evidencia) |
|--------|----------------------------|--------------------------------|
| **Routing nivel equivocado (B1 asset en A2)** | **Peor en A2** — B1 T3/T4 paths reutilizados sin guard | Lesen **T3** (make-t3), **T4** (debate seeds) |
| **Catálogo semillas/blueprints agotado** | Sí | Lesen **T3** (16 temas saltados, exhausted) |
| **Tema forzado + rotación quemando intentos** | Sí (exhaustedTopics) | Lesen T3; planificador `--from-coverage` en T1 Reisen |
| **Gates secuenciales calidad→léxico (Hören)** | Sí — **fix B1 no extendido a A2** | Hören T1/T3/T4 (código; ver log continuación) |
| **MCQ distinct / opciones no excluyentes** | Sí | Lesen **T2** |
| **MCQ length / word-copy** | Parcial — publish alineado; generación sigue fallando en slices curados + smoke | Pool curado horen-t1; verify-a2-gates-live |
| **Umbral MCQ doble config gen vs publish** | **Mitigado globalmente** (CHK-33) | Menos Lesen T2 «+6% pasa gen, falla publish» que B1 pre-fix |
| **vocab_narrative_incoherence** | **Más agudo A2** con cobertura floja | Lesen **T1** |
| **Reglas calidad B1 aplicadas a A2** | Específico A2 | Lesen T1 intento 4 (ich-Blog) |
| **Typos banco vocab** | Patrón B1 cerrado; **A2 no verificado exhaustivamente** | — |

---

## 4 — Propuestas priorizadas (sin implementar)

### P0 — Desbloqueo estructural (impacto máximo)

1. **Lesen T3 A2:** bifurcar `generateOnePart` — si `level === 'A2' && teil === 3` → Gemini + plantilla email MCQ; **no** `make-t3`. Stock/dedup propio o sin `listT3BlueprintStockForTopic` B1.
2. **Lesen T4 A2:** desacoplar `lesenT4SeedStock` / `t4DebateSeeds` para A2; generar **matching Anzeigen** (plantilla T4) sin prefill foro B1.
3. **Calidad T1 A2:** desactivar o acotar regla «ich/mir/mein» cuando `level === 'A2'` y type MCQ Medientext.

### P1 — Fiabilidad generación (mismo paquete que B1)

4. **Extender `isHorenCombinedCalidadLexicoTeil`** a A2 Hören T1/T3 (y T4 si aplica) — un solo gate RF+MCQ+léxico.
5. **`shouldSkipLesenT3Topic` / pool fill:** pasar `level` a stock T3; no marcar agotado A2 con inventario B1.
6. **Lesen T2 A2:** revisar repair mcq_distinct + contrato `balanceMcqGroup` en tablero Stock/Etage (alta tasa JSON roto).
7. **vocab_narrative_incoherence:** calibrar umbral A2 o relajar en smoke cuando anclas vienen de `--from-coverage` y tema estrecho.

### P2 — Production readiness

8. **vocab-bg:** trigger explícito `level: A2` + prueba end-to-end; métricas cobertura que no marquen 600/600 si hay 115 partes seed.
9. **Pool curado:** repasar horen_1 MCQ length, horen T4 «billiger», sprechen caps — subir **lesen_2** post-gate (cuello ensamblado).
10. **Auditoría typos A2.json** — mismo script de pares duplicados que B1 (`arbeits*`).

---

## 5 — Resumen comparativo (12 líneas) — A2 vs B1 (25 jul)

1. **Pipeline volumen:** B1 operativo vía `generate-cli` + fixes P1; A2 **mismo CLI** pero **Lesen T3/T4 enrutan a assets B1** → fallo sistémico, no solo prompts.
2. **Smoke publicación:** B1 **5/7** celdas auditadas publicadas; A2 **0/13** en Lesen (T1–T2 ×12, T3 catálogo, T4 formato).
3. **Coste/intentos Lesen:** B1 publicadas ~2 intentos/$0,09; A2 Lesen **≥34 intentos** solo T1–T3 sin una OK.
4. **Blueprints/seeds agotados:** B1 T3 make-t3 OK (Verkehr 1 intento); A2 T3 **0 blueprints utilizables** tras dedup B1.
5. **Hören combined gate:** fix B1 en T1/T3/T4; **A2 excluido** del Set — misma deuda en código.
6. **MCQ length publish:** fix CHK-33 **global** — A2 publish coherente; generación A2 usa **8ch** (correcto para nivel).
7. **Word-copy Hören:** fix B1 en código; **pendiente medir** en smoke A2 (continuación log).
8. **Pool ensamblable:** A2 pasó de **0→1** examen dry-run; B1 catálogo 16 exámenes — **A2 aún no volumen**.
9. **Plantillas:** A2 **completas** T1–4 Lesen/Hören (mejora vs INFRA 22 jul); **no** compensa routing erróneo.
10. **vocab-bg:** background **paramétrico**; **sin** evidencia `bgGenerated` A2 — igual que 22 jul en práctica.
11. **Cobertura vocab:** `--from-coverage` activo A2 pero **weak 600/600** → gates léxicos estrangulan T1.
12. **Prioridad:** A2 necesita **P0 routing T3/T4 + reglas T1** antes de repetir auditoría Hören estilo B1; B1 necesitaba **P1 anti-copia + MCQ** — **capas distintas del mismo deuda técnica (nivel no first-class en factory).**

---

## Anexo — comandos de verificación

```bash
node scripts/audit-a2-pool-stock.mjs
node scripts/assemble-from-pool-verified.mjs --level A2 --dry-run
node scripts/audit-pass-2.mjs batches/ready/pool-verified/A2
node scripts/vocab-coverage-report.mjs --level A2 --source seed
node scripts/verify-a2-gates-live.mjs
node scripts/parse-a2-audit-log.mjs batches/logs/audit-a2-exhaustive-2026-07-26.log
node scripts/parse-a2-audit-log.mjs batches/logs/audit-a2-exhaustive-2026-07-26-continuation.log
```

# Plan por etapas — Versión en inglés (Cambridge)

**Fecha:** 8 de julio de 2026 · **Responsable:** Danilo · **Alcance acordado:** empezar por **B1 Preliminary**, con hito de validación a **3 exámenes** antes de escalar a **12**.

**Reparto del equipo:** Marcos → validación de exámenes de alemán + plataforma. Danilo → contenido y publicación de la versión en inglés. Este plan solo toca rutas `en/*` y no modifica el motor compartido salvo lo indicado en la Etapa 1 (coordinar con Marcos cualquier cambio en `js/engine/` o `scripts/lib/`).

---

## Estado de partida (verificado en el repo el 2026-07-08)

| Recurso | Estado |
|---|---|
| Blueprint `library/blueprints/cambridge_B1.json` | ✅ v3, alineado al handbook oficial B1 Preliminary 2020 (Reading 32 ítems / Listening 25 / Writing 2 / Speaking 4). Usa ids internos `lesen/horen/schreiben/sprechen` (convención del motor, correcta) |
| Pipeline genérico (`build-level.mjs`, `fill:pool`, `gen:residual`, `validate:fidelity`) | ✅ Acepta `--lang en`; existen wrappers `.cmd` para en A1–C2 |
| Prompt de generación `batches/MASTER_PROMPT_en.md` | ✅ Existe, adapta el pipeline Goethe a Cambridge |
| Vocabulario CEFR `library/vocab/en/A1–C2.json` | ✅ Existe (B1: 16 KB) |
| Banco `library/en/B1/questions.json` | ⚠️ Stub (~4,6 KB, casi vacío) |
| `library/curated/en/` | ❌ No existe |
| `library/pool-seed/en_*.json` | ❌ Vacíos (4 bytes) |
| `data/exams/en_*.json` | ❌ No existen; `availability.json` tiene `en` en `hidden` |
| Gates CHK-1..25 | ⚠️ Calibrados para alemán (capitalización de sustantivos, decapitalizador, etc.) — sin auditar para inglés |
| Frecuencia léxica | ❌ Solo existe `de-frequency-tiers` / `data/freq/de.frequency.txt` |
| Plantillas curated (equivalente a `plantillas-lesen-b1/` etc.) | ❌ No existen para inglés |

Documentos guía del propio repo: `docs/PLAYBOOK_NUEVO_LEVEL.md` → `PLAYBOOK_NUEVO_NIVEL.md` y `docs/LEVEL_BUILD_FLOW.md`.

---

## Etapa 0 — Preparación y verificación de cimientos (1–2 días)

Objetivo: confirmar que el pipeline funciona de punta a punta con `--lang en` antes de generar contenido en volumen.

1. **Verificar blueprint B1 contra el handbook oficial** de B1 Preliminary (formato 2020): conteos por parte, tipos de pregunta, criterios de aprobado (`passPercentPerModule`). El blueprint ya cita la fuente; queda revisar parte a parte.
2. **Test tipo "Modellsatz" para Cambridge**: replicar `test:goethe-b1-modellsatz` como `test:cambridge-b1-sample` usando el sample test oficial gratuito de Cambridge. Es el mismo patrón de test que ya existe para alemán.
3. **Auditoría de gates CHK-1..25 para inglés**: recorrer `scripts/lib/` (p. ej. `capitalizeNouns.mjs`, `normalizeBatch.mjs`, `repairTriage.mjs`) y clasificar cada check en: aplica / no aplica / necesita variante en. Documentar el resultado en `docs/audit/gates-en-applicability.md`. ⚠️ Cualquier cambio de código en gates compartidos → coordinar con Marcos.
4. **Frecuencia léxica en inglés**: decidir fuente (p. ej. bandas COCA/SUBTLEX u Oxford 3000/5000, que además está etiquetado por CEFR) y crear el equivalente de `de-frequency-tiers` si el validador lo requiere; si `CefrGate` solo usa `library/vocab/en/*.json`, este punto se pospone.
5. **Dry-run del pipeline**: `node scripts/build-level.mjs --lang en --level B1 --target 1` (sin `--apply`) y anotar todo lo que falle o asuma alemán.

**Salida de la etapa:** checklist de incompatibilidades resuelto o documentado. No se genera contenido definitivo aún.

## Etapa 1 — Calibración con contenido piloto (3–5 días)

Objetivo: generar poco, revisar mucho. Afinar prompts y gates con material real.

1. Generar **1 lote pequeño por módulo** (Reading, Listening, Writing, Speaking) con `npm run random:batch -- --lang en --level B1` + Gemini, siguiendo `MASTER_PROMPT_en.md`.
2. Pasar cada lote por el gate (`normalize:bank`, auditoría) y registrar falsos positivos/negativos de los CHK en inglés.
3. **Revisión humana** de calidad Cambridge: registro (¿suena a PET real?), distractores plausibles, longitudes de texto según handbook, temática apropiada B1.
4. Ajustar `MASTER_PROMPT_en.md` y las variantes de gates con lo aprendido. Iterar hasta que un lote pase limpio.
5. Crear la estructura `library/curated/en/B1/` y las plantillas por módulo (equivalentes a `plantillas-*-b1` del alemán).

**Salida de la etapa:** pipeline en_B1 que produce lotes que pasan gates sin retoques manuales.

## Etapa 2 — Primeros 3 exámenes → beta (1–2 semanas)

Objetivo: hito de validación acordado. Publicar en_B1 como `beta`.

1. Campaña de generación hasta cubrir 3 exámenes completos: `node scripts/build-level.mjs --lang en --level B1 --target 3 --apply --yes` (Gemini bulk → pool fill → Claude residual → dedupe → fidelity).
2. **Priorizar Listening y Writing desde el inicio.** Lección del alemán (informe 2.3): Hören quedó en 17 archivos vs 185 de Lesen. No repetir el desequilibrio: fijar cuotas de generación por módulo, no por total.
3. Validar: `npm run validate:fidelity -- --lang en --level B1 --strict` → 3/3; `node scripts/audit-stored-exams.mjs --strict` → 0 bloqueantes; `npm run test:engine` verde.
4. **Prueba de UX completa**: hacer los 3 exámenes en la app como usuario (local con `netlify dev`). Verificar corrección, puntuación modular, TTS/audio de listening, PDF.
5. Cambiar `availability.json`: `en.B1` de `hidden` → `beta` (`npm run build:availability`) y desplegar.
6. **Checkpoint con Marcos**: revisar juntos hallazgos que afecten al motor compartido o a la validación antes de escalar.

**Salida de la etapa:** en_B1 visible en la web en beta con 3 exámenes. Decisión go/no-go para escalar.

## Etapa 3 — Escalado a 12 exámenes → live (2–4 semanas)

Objetivo: cumplir los criterios de `live` del playbook.

1. Escalar generación: `--target 12` con el pipeline ya afinado. Mantener cuotas por módulo.
2. Sembrar el pool reutilizable: `node scripts/seed-reusable-from-curated.mjs --lang en --level B1` → Netlify Blobs.
3. Criterios de promoción a `live` (checklist del playbook): blueprint v3 verificado + 12 exámenes servidos + fidelidad 12/12 strict + auditoría 0 bloqueantes + tests engine verdes + `build:availability` → `live`.
4. Habilitar progresivamente `personalized` / `aiFeatures` para en_B1 según lo que soporte el pool.

**Salida de la etapa:** en_B1 `live`, con pool sembrado.

## Etapa 4 — Siguiente nivel: B2 First (posterior)

1. Verificar `cambridge_B2.json` contra el handbook de B2 First (ojo: incluye **Use of English** dentro del paper de Reading — estructura distinta a B1).
2. Repetir Etapas 1–3 con el pipeline ya probado; el coste marginal por nivel debería bajar mucho.
3. Orden sugerido tras B2: C1 Advanced → A2 Key. (A1/C2 no existen como exámenes Cambridge estándar equivalentes — revisar si conviene ocultarlos o mapearlos a otra cosa; decisión de producto con Marcos.)

---

## Riesgos y dependencias

- **Audio de listening:** verificar coste y calidad del TTS en inglés (voces, acentos británicos) antes de la Etapa 2; el caché TTS (`library/tts-cache`) ya existe.
- **Gates compartidos:** todo cambio en `scripts/lib/` o `js/engine/` puede afectar al alemán → coordinar con Marcos y cubrir con tests de regresión (patrón ya usado: `scripts/lib/__tests__/`).
- **Cuotas de API:** la generación 12 exámenes × 4 módulos consume Gemini + Claude residual; usar `--dry-run` y los checkpoints de `batches/` para controlar coste.
- **A1/C2 Cambridge:** los blueprints existen pero Cambridge no ofrece exámenes generales en esos niveles con el mismo formato (A2 Key, B1 Preliminary, B2 First, C1 Advanced, C2 Proficiency sí existen; A1 no). Validar qué se promete en la landing.

## Seguimiento

Marcar cada etapa aquí al completarla:

- [x] Etapa 0 — Cimientos verificados (2026-07-08) + **blueprint B1 corregido** (2026-07-09; formatos oficiales B1 Preliminary en `blueprint-v3-builder.mjs`/`-specs.mjs`, `cambridge_B1.json` regenerado, test modellsatz OK, sin regresión en otros niveles). **Guards de idioma en `normalizeBatch.mjs` aplicados** (2026-07-09; capitalización alemana ya no corre en EN/ES, TEIL_QUESTION_TYPE solo para de; test de regresión + sin regresión en alemán). **Criterio de aprobado decidido e implementado** (2026-07-09): agregado Cambridge English Scale (scope `cambridge-scale`, aprobado desde 140, 25% por destreza, con compensación). Goethe/DELE sin cambios; tests en `test-module-grading.mjs`. **Etapa 0 cerrada** — sin bloqueantes para Etapa 1. Menores para Etapa 1: pasar `lang:'en'` a partGate al cablear generación EN, mapa Cambridge por Teil, y UX pass de resultados Cambridge (Etapa 2).
- [x] Etapa 1 — Pipeline calibrado (2026-07-12): 12/12 módulos generados y validados; calidad Cambridge auditada (ver `lexiloop/docs/audit/etapa1-cierre-en-b1.md`). Defectos corregidos: capitalización alemana en EN, sesgo de respuesta (prompt), taskTypes, modelo→gemini-2.5-flash-lite. Los batches piloto son pre-fix; Etapa 2 regenera limpio.
- [ ] Etapa 2 — 3 exámenes → beta publicada. **Progreso 2026-07-12:** 3/3 curated coherentes → `data/exams/en_B1.json` servido; fidelity 3/3 strict; auditoría en_B1 0 bloqueantes; `availability.json` en_B1=beta. Fixes en motor compartido (revisar con Marcos): audit-pass-2 lang-aware, publish blueprint/blacklist por idioma, picker set-coherente Cambridge en ExamBlueprint, candidateBuilder conserva textos distractores del matching, segmentsTotal en blueprint Cambridge horen, vocab en/B1 +1136 lemas.

  **Prueba UX cerrada (2026-07-25/26)** — hacer los exámenes en el navegador destapó cinco defectos que ninguna validación de ficheros veía, todos corregidos en `feat/en-b1` (hasta `1e8a50f`, pusheada a `mio`):
  1. `130c22a` — los módulos Quick renderizaban un examen **vacío en los dos idiomas**: `renderExam()` exigía `d.goetheFormat && !isQ`, y los exámenes armados desde la library traen `lesenParts`/`horenParts` en vez de `d.lesen`, así que caía en ramas que solo entienden las formas legacy y ni siquiera disparaba el guard de "sin contenido". Se quita el gate `!isQ`.
  2. `ffac769` + `a1ef9a0` — Reading Part 2 no mostraba los 8 textos A–H (motor + reparación de los 3 curated ya publicados con la forma rota). Republicado: fidelity 3/3 strict, audit 0, mojibake limpio sobre 484 ficheros.
  3. `29e4166` — en/B1 daba `servable:false` ("Content is being prepared for this level"): `ContentServable.assessLevel` cuenta los prompts de speaking **solo** desde `library/en/B1/writing-speaking.json`, que seguía siendo el stub vacío. `scripts/sync-speaking-prompts.mjs` los espeja desde el banco → speaking 12/4, servable:true.
  4. `84e57a5` — las partes de Reading de Cambridge salían rotuladas en alemán con la instrucción de anuncios de Goethe T3, que además promete un "escriba 0" que la interfaz de Cambridge no ofrece. Instrucción ahora lang-aware; alemán intacto (5 aserciones nuevas lo fijan).
  5. `1e8a50f` — segundo gate oculto: **solo `de/A2` está `live`**; todo lo demás es `beta`, y `showBetaLevels()` solo miraba `window.LEXICOIL_SHOW_BETA_LEVELS`, que nada define. Sin opt-in **ningún** examen B1 arranca, en ningún idioma. Añadido opt-in por navegador (`localStorage.lc_show_beta='1'`). Poner el nivel en `beta` en `availability.json` **no basta** para verlo en la app.

  **TTS listening EN: no era trabajo pendiente** (`cc79eaa`) — `--all-served` recorría una lista fija `[de/B1, de/A2]`. Añadido en/B1: los 70 clips de los 3 exámenes servidos ya estaban cacheados.

  **Falta:** deploy y **checkpoint con Marcos** (los 6 fixes de motor de arriba + los 5 de la prueba UX tocan código compartido), y decidir qué niveles pasan a `live` — hoy la beta no es visible para un visitante sin el opt-in.
- [ ] Etapa 3 — 12 exámenes → live
- [ ] Etapa 4 — B2 First iniciado

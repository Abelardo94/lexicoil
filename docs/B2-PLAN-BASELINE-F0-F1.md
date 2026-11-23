# B2 Goethe — Fases 0 y 1 (baseline + auditoría cableado)

**Alcance aprobado:** solo B2 · F0 + F1 · **0 API** · sin plantillas ni generación real.  
**Entregable principal:** [`B2-CODE-WIRING-AUDIT.md`](./B2-CODE-WIRING-AUDIT.md)  
**Fecha:** 2026-07-26

---

## Checklist activo — lecciones L1–L12 (proyecto B2)

Marcar en cada PR de infra B2 hasta cerrar el ítem.

| ID | Lección | Criterio de cierre B2 |
|----|---------|------------------------|
| **L1** | Ruteo silencioso a B1 | 13/13 Teile: plantilla `-b2` o rama explícita; **0** `make-t3`/debate T4 B1 en `--level B2` |
| **L2** | `examLevelCells` ↔ blueprint | `layoutForLevel('B2')` = 5+4+2+2; test Modellsatz verde |
| **L3** | Gates con invariantes B1 | CHK-* y calidad batch por **slotType** B2, no por número de Teil B1 |
| **L4** | MCQ length calibrado | `LENGTH_BIAS_BY_LEVEL.B2` documentado en gate-log (no heredar 20/12) |
| **L5** | Vocab narrative por formato | Perfiles B2 (foro L1, press L3, …) en `vocabNarrativeCoherence.mjs` |
| **L6** | Combined calidad+léxico Hören | Set B2 explícito en `horenCombinedCalidadLexico.mjs` + fix-notes B2 |
| **L7** | `vocabularyTags` limpios | Sanitize en ingest desde primer batch B2 |
| **L8** | Catálogos mínimos | No arrancar volumen con &lt; mínimos de semillas (plan F4) |
| **L9** | Rotación nombres con pool real | L1 foro / H3 panel: `pool-verified/B2` + tests |
| **L10** | Auditoría pre-API | Este doc en verde P0 antes de `--count` masivo |
| **L11** | Blacklist CHK-6 | Passages B2: sin rechazo C1/C2 indebido en texto nivel B2 |
| **L12** | Producto (pool personal, publish) | Fuera de F0–F1; flag explícito hasta F7 |

---

## F0.2 — CI Modellsatz B2

| Artefacto | Estado |
|-----------|--------|
| `scripts/test-goethe-b2-modellsatz.mjs` | Existe; valida counts 9/6/6/6/3 · 10/6/6/8 · modular 60% |
| `npm run test:goethe-b2-modellsatz` | **OK** (ejecutado 2026-07-26) |
| `npm run test:engine` | **Incluye** `test:goethe-b2-modellsatz` (cadena `goethe-b2`) |
| Agregador `test-blueprints-v3-all.mjs` | Cubre `goethe_B2` vía `run-blueprint-v3-test` (18 blueprints) |

**Acción F0:** ningún cambio de CI obligatorio; mantener `test:goethe-b2-modellsatz` en `test:engine` en cada PR que toque blueprints o `goethe-b2-modellsatz.mjs`.

**Herramienta repetible F1:** `node scripts/lib/__tests__/b2-wiring-trace.mjs` (paths + flags B1, 0 API).

---

## F0.3 — 14 dimensiones de auditoría (B2, estado global F1)

Leyenda: ✅ listo · ⚠ parcial / riesgo · ❌ bloqueante wiring actual · — N/A celda · 🔜 Fase posterior (F2+)

| # | Dimensión | Estado B2 (F1) |
|---|-----------|----------------|
| 1 | Formato Modellsatz | ✅ `goethe_B2.json` + test Modellsatz |
| 2 | Camino `generate-cli` → factory | ⚠ CLI acepta B2; celdas 13; sin pool-verified |
| 3 | Sin reutilización silenciosa B1 | ❌ **13/13** caen en plantillas/reglas B1 o ramas B1-only |
| 4 | Plantilla `.md` propia | ❌ No existe `plantillas-*-b2` |
| 5 | Gates estructura calibrados | ❌ Solo ramas A2/B1 en `*BatchQuality.mjs` |
| 6 | MCQ length por nivel | ❌ Sin entrada `B2` en `LENGTH_BIAS_BY_LEVEL` |
| 7 | Vocab narrative | ❌ Perfil default `B1-lesen-t1-narrative` para B2 |
| 8 | Q5 / CHK-6 / balanceMcq | ⚠ Genéricos; CHK-6 passages puede conflictuar léxico alto B2 |
| 9 | Combined calidad+léxico | ❌ B2 usa set **B1** en `isHorenCombinedCalidadLexicoTeil` |
| 10 | Banco vocab nivel | ✅ `library/vocab/de/B2.json` (1600 lemas) |
| 11 | Molde estructural / dedup | ❌ Sin kinds `b2_*`; CHK-29 orientado B1 foro/T5 |
| 12 | Catálogos rotación | ❌ Banks B1 (T4 nombres, Hören openings, …) |
| 13 | Render UI / slotType | ⚠ Blueprint define slots B2; pocos batches reales para probar |
| 14 | Pool / weak / publish | ❌ `pool-verified/B2` vacío; sin `weak-de_B2.json`; `isAutoPublishLevelSupported` sin B2 |

---

## F1 — Próximo paso (post-aprobación)

Resolver **P0** listados en `B2-CODE-WIRING-AUDIT.md` antes de F2 (plantillas).

---

## Decisión de arquitectura — banco de textos desacoplado (híbrido B2)

**Referencia:** `propuesta-arquitectura-banco-textos.md` (aprobada en principio para LexiCoil; **no implementada en B1**). El archivo fuente no está versionado en este repo; criterios de retoma en §7 abajo.

**Decisión (2026-07-26):** B2 arranca **0/13 Teile** → adoptar en diseño un enfoque **híbrido**:

- **Camino A — banco de textos desacoplado:** generar y versionar primero el **texto base** (pasaje / transcripción / foro), luego **2.ª pasada** de ítems (MCQ, RF, matching) anclados a ese texto, con gates de anclaje. Mismo espíritu que la propuesta (evitar regenerar texto+cuestiones cuando falla solo la pregunta).
- **Camino B — integrado tradicional:** un solo batch JSON (texto + ítems entrelazados), como B1/A2 hoy — obligatorio cuando el formato **no** admite reutilizar texto sin reescribir la tarea.

**No implementar aún** — solo diseño F2+; B1 sigue 100 % camino B salvo experimentos futuros puntuales.

---

### §7 propuesta — condiciones para retomar (confirmación 2026-07-26)

| Condición (§7) | Estado | Evidencia |
|----------------|--------|-----------|
| Déficit B1 Personalizado **casi cerrado** | **Cumple (~)** | `calc-personal-pool-realistic-deficit.mjs` (2026-07-26T21:19Z): **1 celda en 0** (Bildung Lesen T4), **52 partes** al mínimo realista (vs 126 el 2026-07-23); operador puede seguir fill en paralelo |
| **A2 estable** (pool + wiring) | **Cumple** | [`A2-CODE-WIRING-AUDIT-2026-07-26.md`](./A2-CODE-WIRING-AUDIT-2026-07-26.md) 13/13 ✅ wiring; [`A2-GENERATION-AUDIT-2026-07-26.md`](./A2-GENERATION-AUDIT-2026-07-26.md): audit-pass-2 pool **0 CRITICAL**; calibración D14 + vocab tags 0/285 post-backfill |
| **Sin investigación crítica abierta** | **Cumple** | P0 B2 documentados en F1 (wiring), no bloquean **decidir** arquitectura; A2 listo para gen con API tras crédito; no hay incidente prod sin mitigación documentada en esta ventana |

**Veredicto:** **Sí — se pueden retomar diseño e implementación del banco desacoplado en B2** (no migración B1 masiva). Implementación = fases posteriores a F2.

---

### Clasificación 13 Teile B2 — banco desacoplado vs integrado

Criterio (mismo que descartó Lesen B1 T3/T4 para banco único): si el **ítem de examen está definido por la forma del texto** (huecos, pares opinión↔titular, párrafo↔rúbrica, atribución speaker↔cita), **integrado**. Si existe un **pasaje estable** y las preguntas son **derivación verificable** en 2.ª pasada, **desacoplado**.

| Teil | Camino | Clasificación | Justificación |
|------|--------|---------------|---------------|
| **Lesen T1** | **A — desacoplado** | ✅ Candidato fuerte | Foro: **4 textos de persona** (80–180 W c/u) reutilizables; **9 enunciados** de matching se generan/validan contra esos posts (personas repetibles). |
| **Lesen T2** | **B — integrado** | ❌ No banco | Artículo con **6 huecos** + banco de **8 frases**; la numeración de gaps y la redacción del artículo son **una sola pieza** (inserción). |
| **Lesen T3** | **A — desacoplado** | ✅ Candidato fuerte | **1 artículo prensa** (350–500 W) + **6 MCQ** clásicos; mismo patrón que Lesen T1/T2 B1 donde el texto es estable. |
| **Lesen T4** | **B — integrado** | ❌ No banco | **6 opiniones** emparejadas a **8 titulares** (1 sobra); par opinión↔headline es **entrelazado** (como foro/títulos B1 T4). |
| **Lesen T5** | **B — integrado** | ❌ No banco | **3 párrafos** de reglamento ↔ **7 headings** (4 sobran); estructura legal + etiquetas van juntas. |
| **Hören T1** | **A — desacoplado** | ✅ Candidato fuerte | **5 transcripciones** cortas; **10 ítems** (RF+MC por segmento) = 2.ª pasada sobre audio/texto ya fijado. |
| **Hören T2** | **A — desacoplado** | ✅ Candidato fuerte | **1 entrevista** (280–400 W, ×2 escucha); **6 MCQ** derivables del monólogo/diálogo. |
| **Hören T3** | **B — integrado** | ❌ No banco (confirmado) | Panel: **6× «Wer sagt das?»** exigen alineación **cita ↔ hablante ↔ turno** en el mismo episodio; reutilizar transcripción con ítems nuevos rompe trazabilidad sin re-auditar todo el diálogo (análogo a Hören B1 T4 / Lesen B1 T3 blueprint). |
| **Hören T4** | **A — desacoplado** | ✅ Candidato fuerte | **1 Vortrag** (300–450 W, ×2); **8 MCQ** sobre contenido fijo del monólogo. |
| **Schreiben T1** | **B — integrado** | N/A pasaje | Consigna foro ≥150 W; no hay pasaje de lectura — generación **task-only** (pipeline tradicional). |
| **Schreiben T2** | **B — integrado** | N/A pasaje | Mensaje al jefe ≥100 W; idem. |
| **Sprechen T1** | **B — integrado** | N/A pasaje | Vortrag + interacción; tarjetas/consigna oral integradas. |
| **Sprechen T2** | **B — integrado** | N/A pasaje | Diskussion; idem. |

**Resumen:** **5× camino A** (Lesen T1,T3 · Hören T1,T2,T4) · **8× camino B** (Lesen T2,T4,T5 · Hören T3 · Schreiben×2 · Sprechen×2).

---

### Implicaciones para F2+ (solo diseño, sin código)

| Camino A (5 celdas) | Camino B (8 celdas) |
|---------------------|-------------------|
| Esquema `passageId` / `transcriptId` + metadatos tema/nivel | Plantilla + prompt **monolítico** B2 (como A2) |
| Gates: anclaje ítem→texto, no `vocab_narrative` sobre texto ya validado | Gates estructurales actuales (matching, gaps, speaker) |
| Catálogo: **mínimo N pasajes/transcripciones por tema** antes de 2.ª pasada | Catálogos/moldes **integrados** (headlines, headings, frases T2) |
| No usar `make-t3` ni debate seeds B1 | Hören T3: generación **single-pass** panel+ítems |

**Lecciones L1/L8:** el híbrido se define **antes** de escribir plantillas — evita parchear banco desacoplado sobre Teile integrados (error B1 T3/T4).

**Documentos relacionados:** [`B2-CODE-WIRING-AUDIT.md`](./B2-CODE-WIRING-AUDIT.md) · [`docs/B1-GENERATION-AUDIT-2026-07-25.md`](./B1-GENERATION-AUDIT-2026-07-25.md) (motivos banco vs catálogo en T3/T4/T5 Hören).


# Estado — Fase 1, sesión del 3 sep 2026

Rama: `feat/en-pool-first` (11 commits sobre `226ece3`). Nada mergeado, nada
subido a producción.

## Dónde retomar

**Danilo está a mitad de la muestra ciega.** Revisó ~6 de 36 preguntas.

https://claude.ai/code/artifact/92fff31f-9e21-404e-b12c-e1f9e911c0f1

Las marcas se guardan solas en el `db` del artifact; al reabrir salta a la
primera sin revisar. Cuando termine, cruzar sus marcas con
`docs/audit/blind-sample-en_B1.key.json` (leer el db con `read_db`,
colección `marks`) y sacar: aciertos, falsos negativos y falsos positivos
de SEM-1. **Ese cruce decide si SEM-1 sirve para las 427 partes de la Etapa 2
o hace falta una segunda pasada.**

## Etapa 0 — cerrada

El inglés ya tira de la piscina. Lo que estaba roto y ahora no:

| Qué | Dónde |
|---|---|
| Pool-first cortado a `lang==='de'` | `examGeneration.js` · ahora `POOL_FIRST_TEILS_BY_LANG` |
| Un fallo de piscina dejaba el Teil ausente | `filterPersonalAiChunks` · ahora cae a IA |
| No existía `library/reusable-seed/en_B1.json` | creado, 36 partes, 12 slots sirven |

**La facturación sigue en `{de}`** (`PERSONAL_POOL_FIRST_BILLING_LANGS`).
Cobrar 0 con 3 variantes por slot regalaría la generación que cubre el resto.
Añadir `'en'` cuando la piscina llegue a 30 por slot — es una línea.

## SEM-1: estaba inerte, ahora funciona

Cuatro fallos encajados, todos del mismo patrón: **algo pasaba en silencio y se
contaba como aprobado**.

1. **`maxTokens: 1024` no daba.** `gemini-2.5-flash` gasta ~982 tokens de
   razonamiento del mismo presupuesto; quedaban 28 para la respuesta y el JSON
   salía cortado antes de `issues`. Subido a 4096.
2. **`parseSemanticResponse` fallaba en abierto.** Una respuesta ilegible
   devolvía cero issues. Ahora es `llm_error` bloqueante.
3. **El prompt era Goethe puro.** Juzgaba Cambridge con convenciones alemanas.
   Ahora `EXAM_BOARDS` por idioma.
4. **Sellaba como verificadas partes que no miraba.** `gap_fill` no está en
   `MCQ_TYPES`, así que Listening P3 y Reading P6 pasaban sin una sola llamada.
   Ahora se registran como `sem1Skipped`.

Control negativo (cambiar la clave a una respuesta incorrecta): antes lo
aprobaba en los dos idiomas; ahora lo detecta en los dos.

**`template` y `distractor` desactivados para `en`** — 16 de 21 hallazgos eran
ruido de esos dos. Medición en `docs/audit/sem1-en_B1.json`.

## Coste, medido tres veces

```
~1.500 tokens/parte · $0,00057 → $0,40 las 708 partes de la Fase 1
```

Corrige a la baja los $27 del plan: SEM-1 corre sobre **Gemini**, no Claude.
En free tier, $0.

## Estado de la semilla en/B1

36 partes: **22 verificadas · 12 sin check** (6 Writing + 6 gap-fill) **· 2 en
cuarentena**.

Las 2 en cuarentena son Reading P5 y el defecto es real, verificado a mano:

- `"a wide (5) ___ of food"` — clave `range`, pero `variety` vale igual.
- `"a good idea to (4) ___ a waterproof jacket"` — clave `pack`, pero `carry`
  vale igual.

Están servidas en producción. Sin tocar.

## El alemán: no hay que hacer nada

Muestra de 30 registros **servibles** de `de/B1` con SEM-1 arreglado:
**0 hallazgos reales**. Los 8 fallos son `template`/`distractor`, el mismo ruido.
No hace falta revalidar los 625 sellados con el validador roto.

Decisión tomada: **inglés en solitario**. El alemán se mide, no se trabaja.

Dos cosas anotadas y sin tocar:
- `template` también es ruidoso en alemán: 8 de 30 servibles. Se dejó activo
  porque cambiar el comportamiento del alemán es decisión aparte.
- **43 de los 102 Lesen T4 de `de/B1` están rotos**: sin opiniones por persona
  (`passage.text` son las opciones, `segments` y `ads` a `null`, los 7
  `signText` idénticos). Ninguno es servible, así que ningún usuario los ve.
  Decidir si se reparan o se tiran.

## Ortografía: hallazgo de la revisión humana

Danilo sospechó de `café`, `centre` y `Organisers`. **Las tres son correctas**
— Cambridge es un examen británico. Pero al comprobarlo salió que la piscina
mezcla convenciones:

```
node scripts/audit-en-spelling-variant.mjs
→ 46 apariciones americanas en 10 de 36 partes
  center×20 · realize×8 · armor×6 · jewelry×6 · favorite×2 · color×1 …
```

Dos partes del mismo slot (Reading P2) usan convenciones opuestas: una
`centre×12`, otra `center×12`. Ni SEM-1 ni los gates estructurales lo miran.

Es determinista, así que va en un gate, no en el revisor LLM. El script separa
las formas dudosas (`learned`, `tire`, `program`), correctas en británico según
el sentido, que se reportan pero no bloquean.

## Cola de decisiones

1. **Arreglar las 2 ambigüedades de Reading P5** — están en producción.
2. **Arreglar las 46 formas americanas** — o al menos unificar por parte.
3. **Subir la piscina a Netlify Blobs.** En producción `useLocalSeedInRuntime()`
   devuelve `false`, así que la semilla commiteada NO llega sola: solo Blobs.
   `seed-reusable-from-curated.mjs --apply` se colgó en el bucle de subida (la
   conexión funciona; una sonda de solo lectura respondió). Mirar antes.
4. **Variantes Cambridge de `template` y `distractor`**, y volver a añadirlas a
   `ISSUE_KINDS_BY_LANG`.
5. **Check de gap-fill para SEM-1** — Listening P3 y Reading P6 siguen sin
   verificación posible.
6. **El CI sigue rojo** por los 210 errores estructurales del alemán live.
   Bloquea promocionar cualquier cosa a `live`.

## Comandos

```bash
node scripts/run-sem1-over-seed.mjs --lang en --level B1 --apply
node scripts/run-sem1-over-seed.mjs --lang de --level B1 --sample 30   # solo lectura
node scripts/build-blind-sample.mjs --lang en --level B1 --size 36
node scripts/audit-en-spelling-variant.mjs --strict
node scripts/lib/__tests__/sem1.lang-axis.test.mjs
node scripts/lib/__tests__/poolFirst.lang-axis.test.mjs
node scripts/audit-pass-2.mjs batches/generated   # regresión: 17 / 413 / 237 · 150 archivos
```

## Rojos preexistentes, sin relación

Verificado sobre árbol limpio con `git stash`: `test-personal-horen-runtime`,
`test-seed-reusable-curated`, `test-part-gate`, `verify-sem-l2-fix` (le falta
un fixture).

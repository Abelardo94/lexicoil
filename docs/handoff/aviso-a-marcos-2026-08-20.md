# Aviso a Marcos — 20 ago 2026

Marcos,

**`feat/en-b1` pusheada: `91718f6`.** Es el merge de `main` (`2fe1958`) sobre `234a4fa`.
`origin/main` queda como ancestro, así que el PR #1 ya no tiene conflictos. 38 commits por
delante, 270 ficheros / +73 356 −2 013.

## Cómo quedaron los conflictos

- **`index.html`**, el hunk que anunciaste: se quedan las dos líneas, `examRunner.js?v=28`
  (rama) + `textosReader.js?v=1` (main). El `listeningScript.js?v=2` entra solo desde main.
- **Uno que no estaba en tu lista**: `docs/audit/residual-gaps.en_B1.json` sale como
  rename/delete porque git empareja ese fichero de 4 bytes con
  `dist/library/pool-seed/en_A1.json`, que borraste en `a16d033`. Es un falso positivo de
  detección de renombrado — stage 1 y 2 idénticos, cero cambio real. Resuelto quedándonos el
  nuestro.
- **`dist/`**: cero conflictos. El `git rm -r --cached` cerró los 42 modify/delete de golpe, y
  tras el merge no queda nada trackeado bajo `dist/` ni `landing/out|.next`.
- **`availability.json` auto-mergeó** al catálogo (C) exacto: de/A2 live, de/B1 live 19,
  en/B1 beta 3. No hubo que elegir lado.
- El voice-id `en` de la rama (`Xb7h…`) sobrevive; no lo pisa el `GBv7…` que quedó en main por
  el cherry-pick del #2.

Verde tras el merge: los 5 tests de referencia de `CLAUDE.md`, `results.gap-fill-label`,
`cambridge-numbering`, `listeningScript.inline-speakers` (ahora viene de main) y
`validate-exam-fidelity --lang en --level B1 --strict` → 3/3, exit 0.

Cuando redespliegues el preview hago el QA de en/B1: los 3 exámenes enteros, Part 4 incluido,
con `lc_show_beta`.

## Antes de que gastes la key de prod: al TTS de de/B1 le faltan e17–e19

`scripts/pregenerate-tts.mjs` lee **solo** `data/exams/<lang>_<level>.json`. Ese fichero tiene
**16** exámenes de de/B1. Pero `index.html:622` pone `LEXICOIL_EXAM_SOURCE='published'`, así que
de/B1 y de/A2 se sirven por `PublishedExamAdapter` desde
`library/published-exams/de/B1/`, y ahí el catálogo tiene **19** — e17, e18 y e19, los que
sincronizaste en `4bb9d28`.

O sea: **los tres exámenes nuevos no entran en la pregeneración.** Su Hören son 24 transcripts,
que partidos en turnos con el parser nuevo son clips que nadie ha generado nunca — el coste
exacto está más abajo, ya medido.

El resto sí cuadra: para los 16 exámenes que están en las dos fuentes el texto del Hören es
idéntico carácter a carácter, así que no hay desfase de hashes en e1–e16. El agujero es solo
que e17–e19 no están en el fichero legacy.

### La (1) ya existe como script, solo que nadie la ha corrido

`scripts/sync-published-to-served.mjs` regenera el fichero legacy desde el catálogo publicado.
En seco dice exactamente lo que falta:

```
$ node scripts/sync-published-to-served.mjs --lang de --level B1
  + official-de-B1-e1 … official-de-B1-e19  (15 parts cada uno)
DRY-RUN data\exams\de_B1.json ← 19 exam(s)
```

O sea la (1) es `--apply` y ya está; el fichero simplemente lleva sin sincronizar desde que
publicaste e17–e19. Comprobé lo que me preocupaba de esa vía: ese script mapea los snapshots
con `partRecordToExamPart` de `audit-pass-2.mjs`, que es **otra** implementación distinta de la
del `publishedExamAdapter` que usa el navegador — pero el Hören que sacan las dos es idéntico
en los 19 exámenes, así que reescribir el fichero no mueve ningún hash ni invalida audio ya
cacheado. La (1) es segura.

Aun así te preparé la **(2)**, que es la que no vuelve a romperse sola: rama
**`fix/tts-published-source`**, un solo commit (`1b9ed4b`) partiendo de `main` (`2fe1958`),
5 ficheros, +284 −6. Ya está empujada al fork. No toca nada de inglés, así que va como PR
aparte igual que el #2; comprobado que mergea con `feat/en-b1` sin conflictos:

https://github.com/marcosdadone96/lexicoil/compare/main...Abelardo94:fix/tts-published-source?expand=1

### Qué hace

`scripts/lib/servedExams.mjs` (nuevo) resuelve la fuente **igual que el navegador**, no a ojo:
carga los propios `js/config/examSource.js`, `js/data/publishedExamAdapter.js` y
`js/data/examLibrary.js` en un `vm` con un `fetch` que lee de disco, lee el modo de
`index.html` y pregunta a `ExamLibrary.usesPublishedExams(lang, level)`. Los exámenes que
salen son los objetos que construye el runtime, no una reimplementación mía — el mismo truco
que ya usa `scripts/audit-b1-exam-count.mjs`.

`pregenerate-tts.mjs` pasa a usarlo. Ahora dice de dónde lee:

```
de/B1 [published: library/published-exams/de/B1]: 19 exam(s), 625 clip(s)
de/A2 [published: library/published-exams/de/A2]:  1 exam(s),  41 clip(s)
en/B1 [legacy: data/exams/en_B1.json]:             3 exam(s), 111 clip(s)
```

Hay `--source legacy|published` para forzar, y el manifest guarda `source` + `sourceKind` para
que se vea después con qué se generó. `loadServedExams()` de `ttsCache.mjs` se queda como está
(no lo usa nadie más) con un comentario avisando de que solo ve el fichero legacy.

### Lo que cuestan e17–e19

**83 clips nuevos / 20 859 caracteres.** Por examen salen 36 + 33 + 30 = 99, pero 16 de esos
turnos ya existen en e1–e16 y se cachean una sola vez, así que lo facturable son 83.

Con `flash_v2_5` son **~10 430 créditos extra**; con `multilingual_v2`, ~20 859.

Totales del nivel entero, por si la caché de prod arranca vacía:

| fuente | exámenes | clips únicos | caracteres |
|---|---|---|---|
| published (lo que se sirve) | 19 | 596 | 142 563 |
| legacy (lo que se pregeneraba) | 16 | 513 | 121 704 |

### Lo que no cambia

Comprobado que para los 16 exámenes que están en las dos fuentes el texto del Hören es
**idéntico**, transcript a transcript — o sea ni un solo hash de caché se mueve al cambiar de
fuente. Antes solo lo había verificado en e1; ahora está en el test. de/A2 tampoco se mueve
(1 examen live en las dos, 41 clips) y en/B1 sigue en legacy porque `PublishedExamAdapter`
no soporta inglés.

`scripts/lib/__tests__/servedExams.published-source.test.mjs`, 10 asserts, `npm run
test:served-exams`. Uno de ellos afirma que el fichero legacy **sigue** dejándose exámenes
vivos: si algún día cuadran los dos, el test avisa en vez de pasar en verde vacío. Verdes
también los 5 de referencia de `CLAUDE.md`, `test-tts` y `test-pregenerate-tts`.

### El desfase no solo le costaba al TTS

Miré quién más lee el fichero legacy:

- `build-availability.mjs` **ya lo esquiva**: `exams = Math.max(entries.length, publishedLive)`,
  por eso `availability.json` dice 19 y no 16. Alguien ya se topó con esto.
- `validate-exam-fidelity.mjs` tiene `--source data/exams` por defecto, así que
  **e17–e19 no han pasado nunca por la validación de fidelidad**. Hoy dice literalmente
  `Exams: 16`. (Dicho sea de paso, esos 16 salen en rojo — 373 errores. No he mirado por qué:
  es alemán y es tuyo, solo te lo apunto.)
- El resto de scripts que lo leen son los que lo *producen* (`curated-to-served`,
  `pre-build-guard`, `snapshot-served`) o auditorías.

O sea que la (1) no es solo cosa del TTS: sincronizar el fichero hace que el validador vea los
19. No son excluyentes y yo haría las dos — la (1) para que el fichero deje de mentir hoy, que
es un `--apply` y no rompe nada, y la (2) para no depender de que alguien se acuerde de
correrla cada vez que publiques un examen.

Por mi parte, en cuanto entre el #1 lanzo en/B1 + de/A2 + manifest.

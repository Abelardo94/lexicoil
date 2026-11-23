# Para Marcos — 22 ago 2026

Recibido el merge (`e3005e0`) y los dos commits de producción que vinieron detrás (`0e1d9c0`,
`033890c`). Tu rojo está arreglado y lo mío del TTS hecho. Salieron tres cosas por el camino, dos
de ellas tuyas.

**Todo está en el PR #6: https://github.com/marcosdadone96/lexicoil/pull/6**
(3 commits, 6 ficheros, +158 −21, *Able to merge*). Lleva un comentario con el detalle.

---

## Lo que necesito de ti, y por qué está parado

**1. Cómo llegan los mp3 a producción.** Es lo único que impide dar el TTS por cerrado.

`library/tts-cache/` está en `.gitignore:22` — **mp3 y manifests**. Pero a la vez:

```toml
[functions."tts"]
  included_files = ["library/tts-cache/**"]
```

Y `tts.js` resuelve: Blobs → fichero bundleado → sintetiza y guarda en Blobs. O sea que **manda
quien tenga los ficheros en su contexto de build**, y los 152 clips de en/B1 + de/A2 están en mi
disco, no en el tuyo ni en el repo. El PR solo lleva código.

No sé cómo publicas tú el contenido, así que no toco nada. Tres salidas:

1. **Los relanzas tú** en tu checkout antes de desplegar. Los hashes son deterministas sobre el
   texto: salen exactamente los mismos ficheros, solo cuesta los créditos otra vez (152 clips).
2. **Te paso el directorio** — 9,24 MB los de hoy, o los 33 MB de la caché entera.
3. **Lo dejamos caer en runtime**: el primero que abra el examen paga la síntesis y queda en
   Blobs. Funciona, pero el primer alumno se come la espera y no controlamos con qué modelo.

Yo iría a la **1** si ya despliegas desde tu máquina, y a la **2** si no.

**2. Si `en/B1` se queda `live` con 3 exámenes** (punto 5).

---

## 1. `test:served-exams` — arreglado

El assert decía literalmente *"el bug debe seguir visible o el test no mide nada"*, y afirmaba que
la legacy seguía perdiendo exámenes live. Tu `sync-published-to-served --apply de/B1` (`4b62864`)
cerró el desfase. **El assert fallaba por haberlo corregido.**

```
npm run test:served-exams   antes:  9 passed, 1 failed
npm run test:served-exams   ahora: 12 passed, 0 failed
```

Con las dos fuentes sincronizadas el conteo ya no prueba de dónde se leyó —si el resolver cayera a
legacy saldrían los mismos 19 y pasaría igual—, así que pasa a fijar el mecanismo: el `origin`
(`library/published-exams/de/B1` frente a `data/exams/de_B1.json`, eso sí discrimina), la legacy
obligada a listar los 19 live, y el `carry Hören` que pasaba `0/0` ahora exigido a los 19.

## 2. flash_v2_5: sí, y **antes** de tus 625 — no después

Me preguntabas si lo prefiero en Netlify antes de lanzar. Sí, y por una razón más fuerte de lo que
parecía: **la clave de caché no incluye el modelo.**

```js
// netlify/functions/lib/ttsCacheLib.js:25
function cacheKey(voice, text) { return `tts:${v}:${textHash(text)}`; }
```

`voice + sha256(texto)`. Consecuencias:

- Un MP3 **no dice con qué modelo se generó**. No hay forma de saberlo mirando el disco.
- **Cambiar de modelo no invalida nada.** Si generas los 625 con `multilingual_v2` y luego pasamos
  a flash, la caché vuelve a acertar y prod sigue sirviendo los de v2 para siempre.

O sea: **el modelo con el que lances tú de/B1 es el que se queda.** Y `ttsProvider.js` cae a
`eleven_multilingual_v2` si `ELEVENLABS_MODEL` no está puesta — con la key de prod y sin
exportarla, te salen los 625 en v2.

La caché ya estaba mezclada (mi `.env` pasó a flash el 13 jul a las 17:57; antes, el default):

```
en/B1   31 en caché ·  0 pre-flash
de/A2    7 en caché ·  7 pre-flash (5 jul 13:28)
de/B1    4 en caché ·  4 pre-flash (12 jul 19:27)
```

(Fechas de fichero en hora local, las mismas que da un `ls`.)

**Antes de lanzar:**

```bash
export ELEVENLABS_MODEL=eleven_flash_v2_5
# los 4 pre-flash de de/B1
rm library/tts-cache/pNInz6obpgDQGcFmaJgB_78295791f07aff1e.mp3
rm library/tts-cache/pNInz6obpgDQGcFmaJgB_1b98feab726cd7e2.mp3
rm library/tts-cache/pNInz6obpgDQGcFmaJgB_71510b10c7d758b6.mp3
rm library/tts-cache/pNInz6obpgDQGcFmaJgB_c9e18f3f4774a598.mp3
node scripts/pregenerate-tts.mjs --lang de --level B1
node scripts/pregenerate-tts.mjs --lang de --level B1 --verify
```

Si no los borras, se quedan en `multilingual_v2` dentro de un nivel por lo demás flash.

**Y tu cifra está vieja: son 625, no 596.**

```
node scripts/pregenerate-tts.mjs --lang de --level B1 --dry-run
de/B1 [published: library/published-exams/de/B1]: 19 exam(s), 625 clip(s) — 4 cached, 621 would generate
```

Mismo número desde las dos fuentes (`--source legacy` da 625 también), o sea que no es cosa del
sync: los 596 se quedaron atrás por algún retoque de transcripción posterior. Con los 4 purgados,
625 de golpe.

Para que esto no vuelva a pasar, el segundo commit del PR saca `resolveTtsModel()` de
`ttsProvider.js` (un solo sitio donde se decide el modelo) y lo graba en el manifest junto a
provider y source. **No toco la clave de caché**: meterle el modelo invalidaría los 1.210 MP3 de
golpe.

## 3. Lo mío: en/B1 y de/A2, hechos

```
de/A2   1 exam,  41 clip(s) — +41 new,  0 cached, 0 failed, 3863 KB
en/B1   3 exams, 111 clip(s) — +80 new, 31 cached, 0 failed, 5602 KB
de/A2 VERIFY OK: all 41 Hören clip(s) cached
en/B1 VERIFY OK: all 111 Hören clip(s) cached
```

Purgados antes los 7 pre-flash de de/A2 (los tengo guardados por si acaso). 121 MP3 nuevos,
9,24 MB. Caché total 1.210 MP3 / 33 MB. Los dos manifests llevan ya
`"model": "eleven_flash_v2_5"`.

## 4. QA de en/B1 en producción: los 14 cerrados, uno nuevo — y este es tuyo también

Pasé los 3 exámenes enteros en `www.lexicoil.com/app`, **como anónimo y sin `lc_show_beta`**,
rellenados desde su propia clave y **enviados**. Con `S.isDemo=true`: no se quemó nada ni entró en
analíticas.

```
16 secciones · 57 preguntas · 57 ✓ / 0 ✗ / 0 excluidos   (los tres exámenes)
"2/4 skills scored - 170/140 (Cambridge Scale) — B1"  + Pass
Reading    P1 1-5 · P2 6-10 · P3 11-15 · P4 16-20 · P5 21-26 · P6 27-32
Listening  P1 1-7 · P2 8-13 · P3 14-19 · P4 20-25
```

Los 14 bugs de las dos tandas anteriores, cerrados. Los dos gordos confirmados muertos: **0
excluidos** (eran 12 de 57 sin puntuar) y un examen perfecto ya no dice "Fail". Cero palabras
alemanas en la vista del examen.

**Lo nuevo (#15), en `js/ui/exam/results.js`:**

```
Speaking — Teil 1 · undefined%
```

Dos defectos en la misma línea:

**(a) `Teil` estaba a pelo.** El módulo sí conmutaba (`isDE ? 'Sprechen' : 'Speaking'`) pero la
palabra no, teniendo todos sus vecinos ya traducidos (Schreiben/Writing, Checkliste/Checklist,
Musterdialog/Model dialogue). Inglés y español veían una palabra alemana.

**(b) `sp.score` no existe nunca** en el path orientativo: `buildOrientativeSpeakingHint()`
devuelve `note/words/min/lengthOk`, sin `score`. Salía `undefined%`, y `passOk(undefined)` es
false, así que una parte **no evaluada** se pintaba en rojo, como si el alumno la hubiera
suspendido.

**(b) es agnóstico de idioma, o sea que esto estaba en tu alemán live.** Medido en producción
sobre `de/B1` Exam 1, en el mismo resultado:

```
Schreiben — Aufgabe 1..3          ->  .corr-row.mid   (neutra)
Sprechen — Teil 1..3 · undefined% ->  .corr-row.bad   (roja)
```

Misma situación —"no evaluado"— y dos tratamientos distintos en la misma pantalla. El arreglo ya
estaba escrito tres líneas más arriba, en el path de Writing, y es el que copié:

```js
wp.score != null && !wp.orientative ? (passOk(wp.score) ? 'ok' : 'bad') : 'mid'
```

Va en el PR con test, y comprobé que el test mide algo revirtiendo `results.js`:

```
node scripts/lib/__tests__/results.speaking-part-heading.test.mjs
  con results.js antiguo:  5 passed, 10 failed
  con el arreglo:         15 passed,  0 failed
```

Fija además que el path puntuado no se mueve: 75% sigue `ok`, 40% sigue `bad`, y 0% se imprime
como `0%` y se puntúa (un cero es un score real, no un score ausente).

## 5. `en/B1` está `live` en producción, y no lo decidió nadie

```js
// scripts/build-availability.mjs:120
const allPass = entries.every(({ exam }) => validateExamAgainstBlueprint(exam, blueprint).ok);
let status = allPass ? 'live' : 'beta';
```

No hay suelo de exámenes. En cuanto el PR #1 puso la fidelidad inglesa en verde (3/3, 0 errores),
`build:availability` lo promovió solo — y como `ci:content` lo corre de primero, lo va a volver a
hacer. El único freno es `--cap-status beta --cap-lang en --cap-level B1`, que el script de npm no
pasa. Verificado en prod: `"en": { "B1": { "status": "live", "exams": 3 } }`.

Contra `docs/CONTENT_LIVE_POLICY.md:70`: *"Nunca marcar `live` con menos de 12 exámenes"*.

**Ojo antes de "arreglarlo" metiendo el suelo de 12 en el código:** `de/A2` está `live` con **1**
examen y encima fallando fidelidad (24 errores), colándose por el override de `publishedLive` en
`build-availability.mjs:121`. Lo degradaría también. Por eso no lo he tocado.

Mi opinión: el contenido inglés aguanta el QA, así que `live` no me parece un desastre — es que
nadie lo decidió y la política dice otra cosa. Tú mandas.

---

## De paso, sobre el CI

Con el lockfile ya dentro, `ci:content` llega por fin a validar. El rojo que queda es el tuyo:

```
node scripts/validate-exam-fidelity.mjs --all --strict --live-only
35 exámenes · 3 pasan · 32 fallan · 903 errores
```

Los **3 que pasan son los ingleses**. El resto son de/A2 (24 errores) y de/B1. Lo dejo ahí, que
quedamos en que el fidelity live de `de/*` era tuyo post-merge. De `personalLesenPoolFallback` /
`Aufnahme` y la numeración de de/A2 tampoco toco nada.

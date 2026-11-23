Tres commits: el rojo que dejaste apuntado, y dos cosas que salieron al mirarlo.

## 1. `test:served-exams` — el guard medía el desfase, no el mecanismo

El assert `the legacy file still misses N live exam(s)` afirmaba que el bug seguía vivo, para que el test no midiera el vacío. `sync-published-to-served --apply de/B1` (4b62864) lo arregló: las dos fuentes listan ya los mismos 19 exámenes live, así que el assert fallaba **por haberlo corregido**.

```
npm run test:served-exams   antes: 9 passed, 1 failed
npm run test:served-exams   ahora: 12 passed, 0 failed
```

Con las dos fuentes sincronizadas el conteo ya no prueba de dónde se leyó — si el resolver cayera a legacy saldrían los mismos 19 y el test pasaría igual. Pasa a fijar el mecanismo:

- **`de/B1 reads library/published-exams/de/B1`** (nuevo). El `origin` sí discrimina:

  ```
  auto   -> published  library/published-exams/de/B1
  legacy -> legacy     data/exams/de_B1.json
  ```

- **La legacy debe listar los 19 live** (`missing 0`) — el mismo desfase, medido al derecho. Y si vuelve a desfasarse, lo que le falte tiene que seguir sirviéndose del catálogo publicado.
- **`published-only exams carry Hören`** pasaba `0/0` desde el sync, o sea nada. Ahora se exige a los 19 servidos: `19/19`.

## 2. El manifest de TTS no sabía con qué modelo se generó

La clave de caché es `voice + sha256(texto)` (`ttsCacheLib.cacheKey:25`): **el modelo no entra**. Un MP3 no dice con cuál se generó, la caché mezcla modelos en silencio, y cambiar de modelo no invalida nada — vuelve a acertar y prod sigue sirviendo lo viejo.

Ya estaba mezclada. Repartido por fecha de fichero contra el momento en que `.env` pasó a `eleven_flash_v2_5` (13 jul 17:57):

```
en/B1   31 en caché ·  0 pre-flash
de/A2    7 en caché ·  7 pre-flash (5 jul 13:28,  multilingual_v2)
de/B1    4 en caché ·  4 pre-flash (12 jul 19:27, multilingual_v2)
```

`resolveTtsModel()` sale de `ttsProvider.js` (un solo sitio donde se decide el modelo, lo usa `synthesizeElevenLabs`) y `pregenerate-tts.mjs` lo graba junto a provider/source:

```json
"provider": "elevenlabs",
"model": "eleven_flash_v2_5",
```

**No toco la clave de caché**: meterle el modelo invalidaría los 1.210 MP3 de golpe. Con el manifest basta para saber qué purgar.

## 3. `Speaking — Teil 1 · undefined%`, y pintado como suspenso

Encontrado haciendo QA en producción hoy. Dos defectos en la misma línea de `renderCorrectionHtml`:

**(a) `Teil` estaba a pelo.** El módulo sí conmutaba (`isDE ? 'Sprechen' : 'Speaking'`) pero la palabra no, teniendo todos sus vecinos ya traducidos (Schreiben/Writing, Checkliste/Checklist, Musterdialog/Model dialogue). Inglés y español veían una palabra alemana.

**(b) `sp.score` no existe nunca** en el path orientativo: `buildOrientativeSpeakingHint()` devuelve `note/words/min/lengthOk`, y `speakingParts` se construye solo desde ahí. Salía `undefined%`, y `passOk(undefined)` es false, así que una parte **no evaluada** se pintaba `bad`, en rojo, como si el alumno la hubiera suspendido.

El arreglo ya estaba escrito tres líneas más arriba, en el path de Writing, y es el que se copia:

```js
wp.score != null && !wp.orientative ? (passOk(wp.score) ? 'ok' : 'bad') : 'mid'
```

**Marcos: (b) es agnóstico de idioma, o sea que esto también estaba en tu alemán live.** Medido en producción sobre `de/B1` Exam 1, en el mismo resultado:

```
Schreiben — Aufgabe 1..3          -> .corr-row.mid   (neutra)
Sprechen — Teil 1..3 · undefined% -> .corr-row.bad   (roja)
```

Misma situación —"no evaluado"— y dos tratamientos distintos en la misma pantalla.

```
node scripts/lib/__tests__/results.speaking-part-heading.test.mjs
  con results.js antiguo:  5 passed, 10 failed
  con el arreglo:         15 passed,  0 failed
```

El test cubre las dos mitades y fija que el path puntuado no se mueve: 75% sigue `ok`, 40% sigue `bad`, y 0% se imprime como `0%` y se puntúa (no es un score ausente). `results.js?v=16` → `v=17`.

## Verde

`test:served-exams` 12/12 · `results.speaking-part-heading` 15/15 · `results.gap-fill-label` 10/10 · `test:tts` 2/2 · `test:sprechen-tag` 15/15 · `test:cambridge-scoring` 12/12 · `test:listening-gap-fill` 15/15

## Dos cosas para ti, fuera de este PR

1. **Antes de lanzar los de/B1**: exporta `ELEVENLABS_MODEL=eleven_flash_v2_5` y purga los 4 clips pre-flash, o se quedan en `multilingual_v2` dentro de un nivel por lo demás flash. Y son **625 clips, no 596** (`--dry-run`: 19 exams, 625 clips, 4 cached, 621 would generate).

2. **`en/B1` está `live` en producción, y no lo decidió nadie.** `build-availability.mjs:120` hace `status = allPass ? 'live' : 'beta'` sin suelo de exámenes, así que lo promovió solo en cuanto la fidelidad inglesa se puso en verde — y `ci:content` lo va a volver a hacer. Contra `docs/CONTENT_LIVE_POLICY.md:70` ("Nunca marcar `live` con menos de 12 exámenes"); tiene 3. Dime si lo dejamos o le pongo el cap.

QA completo de en/B1 en producción (los 14 bugs anteriores cerrados, 57 ✓ / 0 ✗ / 0 excluidos en los 3 exámenes) en `qa-en-b1-prod-2026-08-22.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

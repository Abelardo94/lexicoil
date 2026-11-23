Recibido. Ya esta todo pusheado y el PR del audio abierto. Te lo dejo por
puntos, y luego dos cosas nuevas: el 6 (que cambia de forma respecto a lo que te
conte) y que tu main se movio y ya no mergeamos limpio.

1) fix/en-b1-qa-preview pusheada.

2) PR del audio: **#2**, solo 92192e5.
   https://github.com/marcosdadone96/lexicoil/pull/2

   1 commit · 3 ficheros · 96/-7, sobre tu main actual. Able to merge.
   Autocontenido: lleva el bump a listeningScript.js?v=2 en index.html y el
   test nuevo, asi que al mergear los navegadores cogen el JS nuevo de verdad.
   Ojo: mantiene la voz `en` que tienes tu en main (GBv7…), no la del ingles.

   Antes de mergearlo lee el punto 6, porque ese commit por si solo tambien
   invalida el audio cacheado de tus 16 examenes de de/B1, no solo el de A2.
   Lo tienes tambien escrito en la descripcion del PR.

3) PR #1 actualizado: feat/en-b1 pasa de 1eef031 a 234a4fa con los otros 5
   commits (b86c37f … b0c2465 rebasados sin 92192e5). Fast-forward, no hubo
   force-push. Verificado ahi: los 5 tests de referencia de CLAUDE.md en verde
   mas results.gap-fill-label y cambridge-numbering, y validate:fidelity en/B1
   3/3 exit 0. El test del parser ya no esta en esa rama — viaja con el PR #2.

4) de/A2 numeracion: tuyo, no lo toco.

5) Baseline 17/371/237: OK, lo actualizas tu en REVISION-HANDOFF (main).

7) CHK-LEVEL / curated-to-served: deuda compartida post-merge, anotado.


═══ NUEVO: el PR #1 ya no mergea limpio ═══════════════════════════════

Cuando medimos el 0-conflictos tu main estaba en a0059ed. Ahora esta en
03c9549 (Textos v1, 6 commits, 90 ficheros, +24 497). Contra ese main:

    42 conflictos en dist/   modify/delete
     1 conflicto real        index.html
     0                       data/exams/availability.json automergea

Los 42 son porque volviste a commitear build output y mi rama lo lleva
destrackeado desde e270f94 (la decision (A) que cerramos el 26 de julio). Todos
se resuelven "stay deleted". Si quieres que dejen de aparecer, el git rm -r
--cached de dist/, landing/out y landing/.next en main lo cierra para siempre;
el .gitignore ya los cubre desde tu propio 65e3fcf.

El de verdad es un solo hunk de index.html:

    <<<<<<< main
    <script src="js/ui/exam/examRunner.js?v=27"></script>
    <script src="js/ui/workspace/textosReader.js?v=1"></script>
    =======
    <script src="js/ui/exam/examRunner.js?v=28"></script>
    >>>>>>> feat/en-b1

Se resuelve quedandose las dos lineas con el v alto. Si prefieres que lo deje
resuelto yo en la rama, dimelo y hago el merge de tu main en feat/en-b1 y
empujo; no lo he hecho porque cambia el diff que estas revisando.


═══ 6) TTS ════════════════════════════════════════════════════════════

Correccion de alcance: no son 4 tramos. Los 4 eran los que te enseñe porque
colapsaban a una sola voz de forma evidente, pero el fix cambia la segmentacion
—y por tanto el hash de cache— de 53 transcripts del catalogo servido.

Medido pasando data/exams/{de_B1,de_A2,en_B1} por el parser viejo (1eef031) y
por el nuevo y diffeando los jobs que genera pregenerate-tts.mjs:

    transcripts que cambian:  de/B1 33 · de/A2 6 · en/B1 14

    clips nuevos (hash nuevo => cache miss):

        de/B1   431 clips ·  64 995 chars   (T3 217, T4 212, T2 2) · 16 examenes
        de/A2    35 clips ·   2 427 chars   (T2 8, T3 18, T4 9)    ·  1 examen
        en/B1    80 clips ·   6 098 chars   (T1 23, T2 27, T4 30)  ·  2 examenes
        ─────────────────────────────────
        TOTAL   546 clips ·  73 520 chars

Casi todo de/B1 porque los Hoeren T3 y T4 son dialogos largos que el parser
viejo servia enteros como un solo clip: al partirlos en turnos, ninguno de los
hashes viejos sirve.

Creditos: ElevenLabs cobra 1 credito por caracter con eleven_multilingual_v2,
que es el default del codigo (ttsProvider.js:33). Mi .env local tiene
ELEVENLABS_MODEL=eleven_flash_v2_5, que va a 0,5. Segun cual tenga la key que
usemos:

                    v2 (1 cr/char)   flash_v2_5 (0,5)
        de/B1          65 000            32 500
        de/A2           2 430             1 215
        en/B1           6 100             3 050
        TOTAL          73 520            36 760

Confirmame con que modelo esta configurada la key de produccion, porque el
codigo por defecto cae en el caro.

Peso: 757 bytes/char medidos sobre los clips que ya tengo cacheados, o sea
~53 MB de mp3 (de/B1 ~47 MB · en/B1 ~4,4 MB · de/A2 ~1,8 MB). Tiempo: con el
rate-limit de 120 ms del script, 15-25 min.

Y --dry-run no gasta nada ni necesita key, asi es como lo he medido:

    npm run pregenerate:tts:served -- --dry-run


Antes de gastar nada, un problema de entrega que hay que resolver primero
─────────────────────────────────────────────────────────────────────────

Generar en local no llega a produccion. library/tts-cache/ esta en .gitignore
(linea 22) y solo hay 113 mp3 trackeados, casi todos es-ES y voice-ids de
pilotos: ninguno de los de/en servidos. Otra vez el patron del dist/.

Como se resuelve hoy un clip, de arriba a abajo:

    1. el navegador pide /library/tts-cache/<voz>_<hash>.mp3 estatico del
       deploy            (fetchStaticTtsUrl, claudeClient.js:1217)
    2. si no esta, va a la funcion tts.js -> store de Netlify Blobs
    3. si no, al bundle de library/tts-cache del deploy (que esta casi vacio)
    4. si no, speechSynthesis del navegador

O sea que lo que suena hoy en prod sale del paso 2, y el Blobs se calienta solo
cuando un usuario Pro genera (tts.js:142, store.setJSON) — y eso cuesta 1
credito IA por peticion. El Blobs de prod no lo puedo ver yo, solo tu.

Ahi esta el efecto secundario del fix que te decia en el punto 2: un dialogo que
antes era 1 clip ahora son N turnos = N peticiones. Un Hoeren T4 de de/B1 pasa
de 1 a ~13 peticiones para el primer Pro que lo abra despues del merge, y los no
Pro caen a speechSynthesis hasta que alguien lo caliente. Pre-generar y servirlo
estatico lo evita del todo, pero para eso hay que decidir el canal:

    a) destrackear el ignore y commitear los mp3 servidos (~53 MB, gratis para
       siempre y sin depender del Blobs)
    b) un script que siembre el Blobs store desde el cache local
    c) dejarlo perezoso y que lo paguen los creditos IA de los Pro

Yo tiraria por (a) para los 3 niveles, pero es tu repo y tu deploy.


Quien lo lanza
──────────────

Lanzo yo en/B1 + de/A2: 115 clips, 8 525 chars — 8,5k creditos con v2 o 4,3k
con flash, ~6 MB. Es barato, ya tengo la rama levantada y el A2 es el que te
arregla el T4 que vas a mergear en el #2 igualmente. Te paso el manifest.

de/B1 lo dejo para ti: son 431 clips y 65k chars, el 88% del gasto, es tu
contenido y ademas conviene generarlo con la key y el modelo de produccion para
que las voces y los hashes cuadren con lo que sirve el deploy.

Si prefieres lanzarlo todo tu, dimelo y no toco nada — el comando es el mismo:

    npm run pregenerate:tts:served          # los 3 niveles
    npm run verify:tts:served               # comprueba que no queda ninguno

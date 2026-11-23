Marcos, mientras hacías el QA audité el path inglés en local y además levanté la
app y pasé los exámenes por el motor de verdad. Salieron ocho cosas. Tres te
tocan a ti y no al inglés, así que van primero.

═══ LO QUE TE TOCA A TI ═══════════════════════════════════════════════

1) Bug de audio en el alemán de producción.

`parseSegmentsInline` (js/bootstrap/listeningScript.js) admitía "." y espacios
dentro del nombre del hablante, así que el match empezaba a mitad de la frase
anterior y se tragaba su cola. `segmentsLookBroken` veía un speaker de >30 chars
y colapsaba el diálogo entero a una sola voz de narrador.

En alemán le pasa a de/A2 Official Exam 1 Teil 4: la entrevista del Moderator
con Frau Dr. Müller, 9 turnos, suena con una sola voz. En inglés, a los 3
exámenes en el Listening Part 4.

Arreglado. Medido sobre 350 transcripts (data/exams/{en_B1,de_B1,de_A2} +
library/pool-seed/*):  70 mejoradas · 280 sin cambio · 0 regresiones

Ojo a dos formatos que casi rompo y que ahora están cubiertos con test: turnos
entre comillas angulares («Moderator: …») del pool de de/B1, y separados por
marcador (■ Tochter:) de de/A2. Los monólogos de de/B1 Hören T2 que solo llevan
un ":" a mitad de frase siguen sin partirse — antes se salvaban por casualidad.


2) La numeración de de/A2 está rota, y es preexistente. NO la he tocado.

Al verificar mi cambio de numeración pasé los tres catálogos por el motor:

    de/B1  16/16 exámenes limpios
    en/B1   3/3  limpios (tras mi arreglo)
    de/A2   1/1  ROTO — Hören: 3 números duplicados y 7 huecos
                       Lesen:  1 duplicado y 2 huecos

Comprobé que da exactamente las mismas cifras con el examRenumber.js de HEAD,
o sea no es mío. La causa es la misma familia que lo mío: DEFAULT_RANGES es la
tabla de Goethe B1 (Lesen 6/6/7/7/4, Hören 10/5/7/8) y A2 tiene otro reparto,
así que hereda arranques que no le corresponden. Lo dejo para ti porque los
rangos oficiales del A2 son decisión de formato Goethe.

Dato útil: el código ya lo estaba avisando por consola desde siempre.
assertUniqueModuleNumbers solo hace lcDebug.warn, nunca falla:
"[renumber] duplicate lesen numbers: Array(5)". Nadie mira esa consola.


3) El baseline de regresión que usamos los dos no reproduce.

CLAUDE.md dice 12 CRÍTICOS / 371 IMPORTANTES / 242 MENORES. Sobre el mismo
corpus que cita (batches/generated, sin tocar desde 307bf94):

    node scripts/audit-pass-2.mjs batches/generated
    real: 17 CRÍTICOS / 371 IMPORTANTES / 237 MENORES · 146 archivos · 820 preguntas

Los IMPORTANTES cuadran; críticos y menores no. Importa porque es el
procedimiento con el que validamos que un cambio de inglés no toca el alemán:
contra 12/242 salen cinco críticos fantasma que no ha metido nadie.

Corregido en CLAUDE.md. La cifra viaja también en
docs/REVISION-HANDOFF-EN-B1-2026-07-26.md, que está en tu main y no toco yo.


═══ LO DEL INGLÉS (arreglado) ═════════════════════════════════════════

4) El Listening Part 3 se renderizaba VACÍO. Este es el gordo.

horenQuestionHasSubstance valida por tipo: rf/yn piden `correct`, matching pide
enunciado y opciones, y todo lo demás cae al `substantial.length>=2` de MCQ. Los
items de Cambridge Listening Part 3 son sentence completion, o sea gap_fill con
options:[], así que devolvía false y se filtraban.

Medido antes del arreglo sobre el examen servido ya normalizado:

    T3  _itemCount 0 · segments[0].questions []   -> parte vacía
        _numberRange {start:16, end:15}           -> rango invertido

Son 6 de las 25 preguntas de listening, en los 3 exámenes. gap_fill no existe
en de/*, así que el alemán no se toca.


5) La numeración del examen inglés era la de Goethe.

ExamRenumber solo conocía DEFAULT_RANGES. Cambridge numera Reading 1-32 en seis
partes y Listening 1-25 en cuatro, así que el inglés heredaba los arranques de
Goethe (1/7/13/20/27 y 1/11/16/23). Lo que veía el alumno:

    Reading    1-5, 7-11, 13-17, 20-24, 27-32, y la Part 6 OTRA VEZ 1-6
    Listening  1-7, 11-16, 16-21, 23-28        (el 16 repetido)

La Part 6 colisionaba con la Part 1 porque Goethe no tiene Teil 6 y caía al
fallback {start:1,end:99}.

Añadí CAMBRIDGE_RANGES con los mismos números que buildModuleRanges() deriva de
library/blueprints/cambridge_B1.json —lo verifiqué en el navegador—, porque el
path de normalize renumera síncrono y no tiene el blueprint cargado.
rangeTableFor() solo desvía si blueprintId empieza por cambridge; el alemán
sigue en DEFAULT_RANGES exactamente igual que antes, y las heurísticas de
forum/ads quedan limitadas a la tabla Goethe.

Verificado en la app con los exámenes reales, sin huecos ni duplicados:

    en/B1   3/3   Reading 1-32 · Listening 1-25
    de/B1  16/16  Reading 1-30 · Listening 1-30   (idéntico a antes)


6) Los exámenes de en/B1 no tenían examId.

El alemán entra por PublishedExamAdapter (SUPPORTED = { de: {...} }), que asigna
id/examId. El inglés cae al path legacy de examLibrary.js, que hace res.json()
en crudo y no inyecta nada. getExamContentKey devolvía null en los 3, así que
cada intento del mismo examen se guardaba como entrada nueva del historial. Ni
la búsqueda de intento previo ni la pasada de dedup podían casar. Repetir
exámenes es lo que se hace en un QA, así que lo ibas a ver.

De paso, dos de los 3 comparten topic "travel" sin nada que los distinga: el
audit de fidelity los listaba "gym | travel | travel". El id sale del hash del
fichero curated, no de un eN posicional.


7) CHK-1 rechazaba gap_fill, que es tipo válido de Cambridge (Reading P5 y P6).

36 preguntas salían CRITICAL y el gate de curated-to-served.mjs bloqueaba los 3
exámenes ingleses. Metido por el eje lang, no ensanchando CANONICAL_TYPES — el
alemán debe seguir rechazándolo. Baseline alemán idéntico con y sin el cambio.


8) La pantalla de revisión gritaba las respuestas de hueco.

OPTION_LETTER_TYPES (js/ui/exam/results.js) incluía gap_fill, así que ansLabel
entraba por la rama de letra, no encontraba opción que etiquetar y caía a
String(val).toUpperCase():  "swimming pool" -> "SWIMMING POOL". Solo display, la
corrección va por normalizeGradingToken — pero sale en cada revisión.


═══ LO QUE NO TOQUÉ ═══════════════════════════════════════════════════

curated-to-served.mjs no puede regenerar ningún idioma. Detrás de CHK-1 aparece
CHK-LEVEL, y falta el campo `level` en 171/171 preguntas inglesas y en 180/180
alemanas. data/exams/*.json no es reproducible desde library/curated/ en ninguno
de los dos. Infraestructura compartida, lo dejo para que decidas.

La caché TTS de los 4 tramos afectados sigue con el audio de una voz. El arreglo
del parser no la invalida sola: ahora el navegador cae a speechSynthesis en 2
voces, mejor que una voz leyendo "Interviewer:" en alto, pero el audio bueno hay
que regenerarlo y gasta créditos de ElevenLabs. Dime si lo lanzo yo o lo haces tú.


═══ DÓNDE ESTÁ ════════════════════════════════════════════════════════

Rama fix/en-b1-qa-preview, 6 commits sobre 1eef031. No la he pusheado todavía y
no he tocado feat/en-b1: el PR #1 sigue en 1eef031 con 0 conflictos.

    92192e5  fix(listening): partir turnos inline sin tragarse la frase anterior
    b86c37f  fix(en-b1): dar examId estable a los examenes servidos
    be28ce7  fix(audit): gap_fill es canonico en ingles, no en aleman
    050dbcf  chore: rel POSIX en el audit de fidelity y baseline real en CLAUDE.md
    8576041  fix(results): gap_fill es texto libre, no una letra de opcion
    b0c2465  fix(en-b1): recuperar el Listening Part 3 y numerar como Cambridge

Verificado: los 5 tests de referencia de CLAUDE.md en verde más 3 nuevos,
validate:fidelity en/B1 3/3 exit 0, y merge-tree contra tu main (a0059ed) sin
conflictos. Los ficheros de js/ tocados llevan su ?v subido en index.html.

Nota de método: los puntos 4 y 5 NO salieron leyendo código, salieron de
levantar la app y normalizar los exámenes servidos. Los cinco anteriores eran
análisis estático. Si el QA del preview no incluye abrir un examen inglés
entero, merece la pena que lo hagas.

Lo que hay que decidir: si esto entra en el PR #1 o va en un PR aparte. Los
puntos 1, 3, 5, 7 y 8 tocan pipeline compartido, y el 1 arregla audio alemán que
está en producción ahora mismo, así que igual te interesa por separado y antes.
Dime y lo pusheo como quieras.

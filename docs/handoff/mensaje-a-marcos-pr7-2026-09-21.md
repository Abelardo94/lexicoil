# Mensaje para Marcos — PR #7 (21 sep 2026)

Marcos, te acabo de abrir el **PR #7** con todo el trabajo de septiembre:
https://github.com/marcosdadone96/lexicoil/pull/7

Lo urgente primero: hay un bug del validador que **está tirando exámenes enteros en
producción ahora mismo**. `passage_missing` se empuja a `errors` sin pasar por
`_pushIssue`, o sea que se salta el modo `strict`, y la ruta `question-library` acaba
en `throw`. El usuario ve un error en vez de un examen. Son 5 líneas en
`ExamValidator.js`.

Contexto por si no lo tenías presente: **el último deploy de producción es del 23 de
agosto**, así que nada de septiembre está vivo — ni ese arreglo, ni los 175 anuncios
del Teil 3, ni las correcciones del inglés.

Dos cosas que tocan tu territorio y quiero que sepas antes de revisar:

**1. Retiré `curatedOnly`.** No era un guardarraíl de contenido: era un "nivel
escaparate" (acceso libre, sin límite de cuota), o sea una decisión comercial. Nadie
lo escribía en `availability.json`, así que estaba inerte, pero tenía tres
consumidores vivos en producción. Y estaba a medio construir: tu
`test-a2-exam-access.mjs` asume un tope de 4 exámenes que saldría de `poolPreview`, y
de/A2 no lo tiene — no pasaba ni con el flag activado. **Si quieres el nivel
escaparate de verdad, dímelo y lo montamos bien, con la cuota pensada.**

**2. Se mueve contenido alemán**: los 1295 `vocabularyTags` que faltaban en de/B1 y
los 175 anuncios del Teil 3. Los tags **ya están en producción** desde el 18 de
septiembre — van por blobs, no por el deploy. 747 partes escritas, 0 errores,
5714/5714 preguntas con tags (antes 1736; Lesen estaba a 0 de 3269).

De paso, `test:engine` queda en **70/0** — primera vez que la suite del motor está
entera en verde. Venía de 63/7.

**Sobre el check en rojo:** es el `pre-build-guard` y **no viene de este PR**. Lo he
corrido sobre `8272af9` —tu `main` de ahora— y da exactamente el mismo fallo, mismos
ids incluidos. De hecho todos los push a `main` desde el 22 de agosto están en rojo
por lo mismo. El job que sí importa para este PR, `ci:content + test:engine`, **pasa
en 1m56s**.

Dicho eso, el fallo es real y merece arreglarse: en el dry-run de ensamblado curado
de de/B1, el Teil 3 de Lesen devuelve **0 anuncios donde se esperan 10**, y hay una
clave de respuesta duplicada (`key=C`). Fidelidad 0/3 en los tres exámenes curados.
Lo miro yo esta semana si te parece, pero es territorio tuyo y prefiero avisarte
antes de tocar.

Son 32 commits, pero 41.000 de las 47.000 líneas son cuatro ficheros de contenido
generado. Código real hay unas 6.200. La descripción del PR lo tiene desglosado por
bloques.

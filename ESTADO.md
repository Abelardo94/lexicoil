# Estado tras el traspaso — 2026-09-01

Marcos pasa el programa completo. Esta carpeta (`C:\Danilo\Programas\LEXICOIL\lexiloop`)
es la única copia de trabajo: parte de su entrega del 2026-09-01 y le hemos incorporado
lo que solo teníamos nosotros.

## De dónde sale

- **Base**: entrega de Marcos, `main` en `8272af9` (de/A2, de/B1 y en/B1 listos para
  usuarios de prueba) y `d5058bc` (cap de en/B1 a beta: mínimo 12 exámenes para live).
  Su `main` ya incluye nuestro PR #6 (`89afcd4`).
- **Copia anterior**: archivada en `..\lexiloop-pre-handover-2026-09-01`, intacta.

## Qué se incorporó de la copia anterior

- **28 ramas** accesibles como `pre-handover/*` (remote local a la carpeta archivada).
  Verificado con `git cherry`: los commits de nuestras ramas ya están en `main` por
  contenido — incluidos los 6 de `fix/en-b1-qa-preview`. No hay trabajo suelto.
- **Caché TTS**: 189 mp3 que la entrega no traía. Total ahora **1215** en
  `library/tts-cache/` (esta carpeta está gitignored pero se bundlea vía
  `netlify.toml -> included_files`).
- **`.env`**: 46 claves, todas con valor. Se recuperaron `ADMIN_SECRET`,
  `ELEVENLABS_MODEL` y `ELEVENLABS_VOICES_EN`, que la entrega no traía.
  Copia previa a la fusión en `.env.bak-pre-merge-2026-09-01`.
- **Notas de trabajo**: `docs/handoff/` (correspondencia con Marcos, QA del inglés,
  nota del PR #5) y `docs/guias/` (guías de generación y pruebas, plan del inglés,
  áreas de mejora).

## Qué queda pendiente de decidir

1. **WIP de Marcos sin commitear** en `js/data/savedVocabPhrases.js` y
   `savedVocabQuizzes.js`: al repetir una frase o un quiz guardado ya no se cambia el
   idioma global de la interfaz. Es un cambio deliberado y coherente, pero sin commit.
2. **~1500 ficheros sin trackear**: contenido de `batches/` (gate-logs, generados),
   `library/published-exams/de/B2`, `library/vocab/de/B2.pilot-72.json`,
   `data/coverage/*de_B2*`, y código real —
   `js/ui/admin/capitalizationProposalsPanel.js`, `correctionsApiBridge.js` y
   4 módulos en `netlify/functions/lib/`. Es el B2 alemán en curso: hay que decidir
   qué entra en git.
3. **Los `.md` de `docs/handoff/` y `docs/guias/` están sin trackear**: pendiente de
   commit.
4. **Workflows de CI**: la entrega venía con `content-validation.yml` y
   `smoke-b1-de.yml` borrados sin commitear. Restaurados.

## Acceso a GitHub

`origin` sigue siendo `marcosdadone96/lexicoil` y `danilo` es `Abelardo94/lexicoil`.
El traspaso del programa no cambia los permisos de GitHub: hasta que Marcos transfiera
el repositorio o añada a Danilo como colaborador, `push` a `origin` sigue dando 403 y
hay que seguir empujando a `danilo`.

## Verificación hecha

`node scripts/validate-exam-fidelity.mjs --all --strict --live-only` → 35 exámenes,
23 pasan, 12 fallan (todos en niveles beta, report-only), exit 0. Igual que en la entrega.

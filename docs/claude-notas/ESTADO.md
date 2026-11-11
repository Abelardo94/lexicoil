# Notas de trabajo para sesiones de Claude (nube)

Resumen de las notas que hasta ahora solo existían en el PC de Danilo. **Este repo es
público**: aquí no van claves, correos ni identificadores de cuentas. Lo que dependa de
eso se configura como variable de entorno del entorno en la nube.

Escrito el 11 nov 2026 sobre `main` = `0d887ca6`. Son observaciones de ese día: antes de
afirmar algo, compruébalo contra el código o contra producción.

---

## Cómo se trabaja

- El repo canónico es `marcosdadone96/lexicoil`. Danilo (`Abelardo94`) trabaja en su fork
  `Abelardo94/lexicoil`, en ramas que salen de `main`, y abre PRs cruzados. Mergear en el
  repo canónico despliega solo en Netlify; **comprobar siempre el deploy**, mergear no es
  desplegar.
- Danilo lleva los dos idiomas (alemán e inglés). El motor es común: un cambio "de inglés"
  puede romper el alemán. Regresión del alemán: `node scripts/audit-pass-2.mjs
  batches/generated` antes y después, mismas cifras.
- Commits y PRs en español, explicando el porqué y con la medición al lado. Comentarios de
  código en inglés.
- CI de un PR: `gh pr checks <n> --repo marcosdadone96/lexicoil`. No fiarse del exit code
  de `gh run watch` (devolvió 0 con un paso en rojo).
- `npm run test:engine` (92 scripts) y `npm run ci:content` están en verde en `main`.
  Correrlos ensucia `docs/audit/*.json` y `data/exams/availability.json`: descartar ese
  ruido, no commitearlo.
- Al editar un fichero de `js/`, subir su `?v=N` en `index.html`.
- En producción `/` es la landing de Next y la app es `/app.html`. En `netlify dev` la app
  es `/`.

## Estado a 11 nov 2026

- **Supabase:** el proyecto no resuelve en DNS (pausado o borrado). `auth-login` responde
  503 a las cuentas de Supabase. Solo se arregla restaurándolo en el panel de Supabase.
- **PRs abiertos**, independientes y sin conflictos entre sí:
  - #29 acceso sin Supabase, vuelta de Stripe/reset a `/app.html`, límites en correos.
  - #30 voz de Pro rota (`tts.js`), modelo de Claude elegible por el cliente, corrector
    ortográfico abierto, caché de traducciones con escritura anónima.
  - #31 Pro → Pro Max abría una segunda suscripción.
  - #32 fallos del cliente hallados con `eslint no-undef`.
- **Contenido en producción:** de/A2 6 exámenes, de/B1 19, en/B1 16, todos con el Listening
  entero. Piscina de práctica en Blobs: en/B1 15 partes por Teil; de/B1 con audio salvo 60
  clips de 16 partes. de/A2 no tiene piscina en producción. Los niveles beta de/A1–C2 son
  demos incompletos, invisibles al público.
- **ElevenLabs:** sin créditos, suscripción cancelada. El audio servido está cacheado en
  Blobs; si falta un clip, la app cae a la voz del navegador.
- **Generación de contenido inglés:** Claude Opus como generador dio 19/20 partes limpias
  frente a 4/20 de Gemini Pro; el revisor ciego (subagentes) caza 22/23 defectos sembrados.

## Pendiente conocido

- Los límites por IP usan el primer valor de `X-Forwarded-For`. Con Cloudflare delante es
  posible que lo ponga el cliente. **Sin verificar**: medirlo en un deploy preview antes de
  tocar nada (cambiarlo a ciegas puede meter a todos los invitados en el mismo cubo).
- Una traducción de pasaje con IA gasta 1 de los 5 exámenes mensuales del usuario gratuito
  (ruta genérica de `claude-chat`). Parece decisión de producto: preguntar.
- No se ha comprobado si el envío de correo (Resend) está configurado en producción.
- Panel de Stripe sin revisar: modo live/test, URL y eventos del webhook, precios, IVA.
- Deuda de contenido: 25 registros viejos de la semilla en/B1 desfasados respecto a los
  curados; el normalizador pone mayúscula a opciones con tallo abierto; la corrección no
  ignora tildes; Hören A2 T2/T3 debería sonar una vez.

## Lecciones que ya han costado caras

1. **Un verde no prueba nada hasta sabotearlo.** Doce casos de algo que aprueba sin mirar,
   escribe sin escribir o alarma sin motivo. Antes de fiarse de un verificador: estropear
   una entrada buena y confirmar que falla; mirar qué campos compara de verdad.
2. **Si dos herramientas discrepan, una miente.** Perseguirlo.
3. **Un "✓ Actualizado" no prueba que algo cambiara.** Releer lo escrito.
4. **Lo determinista no se le pide a un LLM.** Un barrido exacto de 3 líneas encontró dos
   opciones idénticas que un revisor semántico y un humano se habían saltado.
5. **El slot del blueprint manda sobre la forma del dato.** Casi todos los bugs del inglés
   vienen de heurísticas de forma pensadas para Goethe aplicadas a Cambridge.
6. **No regenerar contenido ya servido** sin decidirlo con Danilo: cuesta generación y
   cambia lo que los alumnos ya han visto.
7. **Los secretos que muestra Netlify van enmascarados** (20 caracteres). No afirmar nada
   sobre el valor de un secreto.
8. **Subidas a Blobs:** primero en seco, luego `--apply`, luego releer. Los scripts con
   `--apply` pueden escribir disco y Blobs a la vez: generar sin credenciales cuando solo
   se quiere el fichero.
9. **Cotejar las salidas de subagentes:** han rotado y duplicado ficheros.

## Herramientas

`herramientas/trabajo-ingles/` (en esta misma rama) guarda los scripts de sondas,
generadores, revisores y subidores usados para montar en/B1 y arreglar de/A2. Solo código:
los datos intermedios (lotes, copias de blobs, logs) se quedaron en el PC. Varios esperan
`NETLIFY_API_TOKEN` / `NETLIFY_AUTH_TOKEN` / `NETLIFY_SITE_ID` o `ANTHROPIC_API_KEY` en el
entorno, y rutas de worktrees locales que habrá que ajustar.

Para pasar un linter sin tocar el repo: instalar `eslint` y `globals` fuera del árbol y
lanzarlo con `-c`. `no-undef` sobre `netlify/functions` y sobre `js/` (tratando como
globales todas las declaraciones de nivel superior) fue lo que destapó #30 y #32.

# Guía: generar exámenes de inglés B1 (Cambridge) en tu computadora

> Programa creado por Marcos. Esta guía es para ejecutar la generación tú mismo, paso a paso.
> Si algún paso da un error que no entiendes, cópiale el mensaje a Marcos: es infra suya.

## Antes de empezar (una sola vez)
- La `GEMINI_API_KEY` ya está puesta en `lexiloop\.env` ✅
- Las dependencias del proyecto ya están instaladas (carpeta `node_modules`) ✅
- Necesitas tener **Node.js** instalado. Para comprobarlo lo hacemos en el Paso 2.

---

## Paso 1 — Abrir la terminal en la carpeta correcta
1. Abre el **Explorador de archivos** y entra a:
   `C:\Users\agara\Documents\LEXICOIL\lexiloop`
2. Haz clic en la **barra de direcciones** (donde se ve la ruta), bórrala, escribe **`cmd`** y pulsa **Enter**.
3. Se abre una ventana negra (Símbolo del sistema) ya ubicada en esa carpeta. Todos los comandos van ahí.

## Paso 2 — Comprobar que Node funciona
Escribe esto y pulsa Enter:
```
node -v
```
- Si muestra algo como `v20.x` o `v22.x`, perfecto, sigue.
- Si dice "no se reconoce…", Node no está instalado → pídele a Marcos que lo instale (o instálalo desde nodejs.org, versión LTS) y vuelve aquí.

Confirma también que estás en la carpeta correcta:
```
dir package.json
```
Debe listar el archivo `package.json`. Si dice que no existe, no estás en la carpeta `lexiloop` (repite el Paso 1).

## Paso 3 — Prueba SEGURA primero (no escribe nada)
Esto genera un examen de prueba **sin guardar nada** — sirve para ver que la key funciona:
```
npm run build:level -- --lang en --level B1 --target 1
```
- Verás que empieza a hacer llamadas a Gemini y va mostrando progreso por módulo (Reading, Listening, Writing, Speaking).
- Al no llevar `--apply`, es solo un ensayo: no toca tus archivos.
- Si termina sin errores rojos, vas bien.

## Paso 4 — Generar de verdad (3 exámenes)
Cuando el Paso 3 se vea bien, este sí guarda el contenido:
```
npm run build:level -- --lang en --level B1 --target 3 --apply --yes
```
- `--target 3` = tres exámenes completos (el hito acordado antes de escalar).
- `--apply` = guarda el resultado. `--yes` = no te pregunta confirmaciones.
- Tarda un rato (son ~12 llamadas a Gemini por examen; 3 ≈ 36 llamadas; con `gemini-2.5-flash-lite` el plan gratis da ~1000/día, así que vas sobrado).
- Si ves el aviso "ANTHROPIC_API_KEY missing — skipping Claude residual", es **normal y está bien**: solo omite un paso opcional de relleno.

## Paso 5 — Validar lo generado
```
npm run validate:fidelity -- --lang en --level B1
```
Debe decir **3/3** (ya corre en modo estricto). Si marca fallos, cópialos aquí y los revisamos.

## Paso 6 — Auditoría de exámenes guardados
```
node scripts/audit-stored-exams.mjs --strict
```
Debe terminar con **0 bloqueantes**. Igual que antes: si algo sale rojo, pégamelo.

---

## Si ves "404 … model is no longer available"
Google retira modelos sin avisar. Solución:
1. Corta la generación con **Ctrl+C**.
2. Mira qué modelos tienes disponibles hoy:
   ```
   node scripts/list-gemini-models.mjs
   ```
3. Elige uno tipo **flash-lite** (o flash) de la lista y ponlo en `lexiloop\.env`:
   `GEMINI_MODEL=<nombre-elegido>`
4. Vuelve a lanzar el comando del Paso 4 (retoma donde quedó).

## Notas importantes
- **Copia los comandos tal cual**, incluido el `--` después de `build:level` (sirve para pasarle las opciones).
- Esto **no** publica nada en la web todavía; solo crea el contenido en tu carpeta. Hacerlo visible (beta) es un paso posterior que vemos juntos.
- Consume cupo gratuito de Gemini; si un día te dice "quota", esperas al día siguiente o lo hablas con Marcos.
- Cualquier error de instalación/entorno (Node, npm, permisos) es terreno de Marcos, no te pelees con eso solo.

## Cuando termines
Dime cómo fue (o pégame lo que muestren los Pasos 5 y 6) y seguimos aquí: revisión de calidad, prueba UX de los 3 exámenes en la app (`netlify dev`), pasar en_B1 de `hidden` a `beta` y el checkpoint con Marcos.

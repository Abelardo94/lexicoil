# Guía de pruebas en local — LEXICOIL (primera vez)

Todo se ejecuta en PowerShell desde la carpeta del proyecto:
```powershell
cd C:\Users\agara\Documents\LEXICOIL\lexiloop
```

---

## 0. Requisitos (una sola vez)

```powershell
node -v    # necesitas Node 20 o superior (netlify.toml usa NODE_VERSION=20)
npm install
```
Si no tienes Node: instálalo desde https://nodejs.org (versión LTS).

Si PowerShell da el error *"la ejecución de scripts está deshabilitada"* al usar `npm`, habilita los scripts para tu usuario (una sola vez, es la configuración recomendada por Microsoft para desarrollo):
```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```
Responde `S` si pregunta, y repite el comando de npm.

---

## 1. Verificación estática (30 segundos, sin configurar nada)

Comprueba que los archivos modificados no tienen errores de sintaxis:

```powershell
node --check js/ui/exam/examGeneration.js
node --check js/ui/exam/examRunner.js
node --check js/engine/personalExamCoverage.js
```
Si no imprimen nada = todo bien. Si hay error, muestra archivo y línea.

Tests existentes del proyecto (pipeline de contenido). Importante: pasa el patrón entre comillas — `node --test` con un directorio a secas falla en Node 21+:
```powershell
node --test "scripts/lib/__tests__/*.test.mjs"
# Esperado: tests 15 · pass 15 · fail 0
```
Si `normalizeT3.test.mjs` fallara solo al final con `EPERM ... tmp-t3-test.json`, es limpieza del archivo temporal (permisos), no un error de lógica: bórralo a mano y repite.

Harness de la nueva funcionalidad (guardado en `..\test-coverage-swap.js`, fuera del repo):
```powershell
node ..\test-coverage-swap.js
# Esperado: "TODOS LOS ESCENARIOS OK"
```

---

## 2. Configurar el entorno (una sola vez)

```powershell
copy .env.example .env
```

Ahora hay que editar ese archivo `.env` (es un archivo de texto normal con pares `VARIABLE=valor`; la app lo lee al arrancar). Paso a paso:

**2.1. Genera los dos secretos.** En PowerShell, ejecuta esto **dos veces** y copia cada resultado (son cadenas aleatorias tipo `Xk3v9q...`):
```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

**2.2. Abre el archivo con el Bloc de notas:**
```powershell
notepad .env
```

**2.3. Localiza y rellena estas líneas.** Usa Ctrl+F en el Bloc de notas para encontrarlas. Pega cada valor justo después del `=`, sin espacios ni comillas:

```
AUTH_JWT_SECRET=pega-aquí-el-primer-resultado
```

Busca la línea `# ADMIN_SECRET=` (está más abajo, comentada con `#`). Quítale el `#` inicial y pega el segundo resultado:
```
ADMIN_SECRET=pega-aquí-el-segundo-resultado
```

**2.4. `ANTHROPIC_API_KEY` — déjala vacía por ahora.** Sin ella la app funciona igual: la generación con IA fallará y caerá al pool, que es justo lo que quieres para probar el coverage swap (paso 5). Cuando más adelante quieras probar la IA en vivo, crea una clave en https://console.anthropic.com → API Keys y pégala igual: `ANTHROPIC_API_KEY=sk-ant-...`

**2.5. Guarda (Ctrl+S) y cierra el Bloc de notas.** El resto de variables del archivo puedes ignorarlas para estas pruebas.

Al final, las líneas relevantes de tu `.env` se verán así (con tus valores reales):
```
AUTH_JWT_SECRET=Xk3v9qWm2Lp8...
ADMIN_SECRET=Zr7t4nBd6Hs1...
ANTHROPIC_API_KEY=
```

**Importante:** `.env` contiene secretos — nunca lo subas a git (ya está en `.gitignore`) ni lo compartas.

---

## 3. Arrancar la app

Primero instala la CLI de Netlify si no la tienes (una sola vez; si `npm run dev` dice *"netlify no se reconoce como un comando"*, es esto):
```powershell
npm install -g netlify-cli
```

```powershell
npm run dev        # netlify dev → abre http://localhost:8888
```
La primera vez, la CLI de Netlify puede pedirte iniciar sesión; puedes saltarlo con:
```powershell
npx netlify dev --offline
```
(offline = timeouts de función de 30s en vez de 60s; suficiente para estas pruebas).

---

## 4. Crear cuenta y activarte Pro (los exámenes personalizados son Pro)

**¿Por qué este paso?** Los exámenes personalizados por vocabulario (la función que vamos a probar) están reservados al plan Pro de pago. En producción un usuario paga con Stripe; en tu PC no vas a pagar nada: la app incluye una función de administrador que marca una cuenta como Pro directamente. Este paso hace eso.

**4.1. Crea una cuenta en tu app local.** Con `npm run dev` corriendo, abre el navegador en http://localhost:8888, busca el botón de registro (Sign up / Registrieren) y crea una cuenta con un email inventado, por ejemplo `test@local.dev`, y cualquier contraseña. No llega ningún correo de confirmación — es todo local.

**4.2. Convierte esa cuenta en Pro.** Abre una **segunda** ventana de PowerShell (deja la primera corriendo con la app) y pega el comando de abajo, cambiando dos cosas antes de ejecutarlo:

- `TU_ADMIN_SECRET` → el valor que pusiste en la línea `ADMIN_SECRET=` de tu `.env` (paso 2.3). Cópialo tal cual.
- `test@local.dev` → el email exacto con el que te registraste en 4.1.

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:8888/.netlify/functions/admin-activate-pro" -Headers @{ Authorization = "Bearer TU_ADMIN_SECRET" } -ContentType "application/json" -Body '{"email":"test@local.dev"}'
```

(`Invoke-RestMethod` es simplemente la forma de PowerShell de enviar una petición a la app, como si fuera un formulario. El comando va todo en una sola línea. Si la consola se queda mostrando `>>`, pulsa Ctrl+C y vuelve a pegarlo entero.)

**4.3. Comprueba el resultado.** Debe responder algo como:
```
ok    : True
email : test@local.dev
plan  : pro
```
Errores posibles y su causa:

| Respuesta | Causa | Solución |
|---|---|---|
| `503 admin_not_configured` | La app no ve `ADMIN_SECRET` | Revisa que la línea en `.env` no tenga `#` delante, y **reinicia la app** (Ctrl+C y `npm run dev` de nuevo — el `.env` solo se lee al arrancar) |
| `unauthorized` | El secret del comando no coincide con el del `.env` | Cópialo de nuevo, sin espacios |
| `invalid_email` / 404 | El email no coincide con la cuenta registrada | Usa el email exacto del paso 4.1 |

Tras el cambio, recarga la página de la app (F5); tu cuenta ya es Pro.

---

## 5. Probar la funcionalidad nueva (coverage swap)

**Preparación:** necesitas palabras en tu mazo. Haz una práctica corta y guarda 5-6 palabras, o añádelas a mano en la sección de flashcards. Elige palabras concretas de B1 (ej. *Vermieter, Umzug, Rechnung, Termin, Wohnung*).

**Prueba A — swap automático al generar:**
1. Ve a examen personalizado → selecciona tus palabras (mínimo 2) → genera (módulo Lesen).
2. Abre la consola del navegador (F12 → Console) antes de generar.
3. Qué observar:
   - Toast al terminar: *"Dein Examen nutzt X von N Wörtern"* — si hubo sustituciones añade *"…Teile wurden passend zu deinen Wörtern ausgewählt"*.
   - En consola: `[personal] coverage swaps: [{module, teil, gained}]` si actuó.
   - Truco para forzarlo: deja `ANTHROPIC_API_KEY` vacía → la IA falla → los Teile vienen del pool genérico con 0 palabras → el swap entra siempre que el pool tenga matches.

**Prueba B — botón manual en el banner:**
1. Con un examen personal abierto cuya cobertura sea parcial (el banner dice "X von N Wörtern" con X < N), verás el botón **"Mehr meiner Wörter einbauen"**.
2. Marca alguna respuesta antes de pulsarlo (para verificar que se conservan).
3. Púlsalo. Resultados posibles:
   - Hay match en pool → el examen se re-renderiza, la cobertura sube, tus respuestas siguen marcadas, nuevo toast.
   - No hay match → el botón se desactiva con "Gerade kein passender Teil im Pool" y un toast honesto.

**Prueba C — regresión rápida (nada roto):**
1. Genera un examen del pool/librería normal (sin palabras) → debe funcionar igual que antes, sin banner de cobertura.
2. Haz un examen demo → sin cambios.

---

## 6. Si algo falla

- Error en consola del navegador → cópialo y pásamelo.
- `netlify dev` no arranca → prueba `npx netlify dev --offline`; si es error de puerto, cierra procesos en 8888.
- El pool no devuelve nada (siempre "kein passender Teil") → es esperable si las palabras no están en las ~5-8 partes limpias por Teil del pool local (`library/reusable-seed/de_B1.json`). Prueba con palabras muy comunes de B1 (*Wohnung, Arbeit, Termin*) para confirmar que el mecanismo funciona; la escasez de matches es justo lo que resolverá la ampliación del pool.

# Revisión del handoff EN B1 (Danilo → Marcos)

**Fecha:** 26 jul 2026 (actualizado tras handoff **v2**)  
**Fuente canónica:** `danilo/feat/en-b1:docs/handoff-en-b1-para-marcos.md` — commit **`56eb9be`**  
**Medido contra:** `main` = `a50a89a` · base común = `4e5efac` · código EN en rama ≈ `1e8a50f`  
**Remoto:** `git remote add danilo https://github.com/Abelardo94/lexicoil.git`

Documento de **lectura y decisiones** — no es lista de implementación. El trabajo de Danilo ya está commiteado en su rama.

Relacionado: [`docs/CONTENT_LIVE_POLICY.md`](CONTENT_LIVE_POLICY.md)

### Handoff v2 — qué respondió Danilo a esta revisión

Tras [`docs/REVISION-HANDOFF-EN-B1-2026-07-26.md`](REVISION-HANDOFF-EN-B1-2026-07-26.md) (lectura del handoff v1, `32da28c`), Danilo publicó **`56eb9be`** con una **nota v2 al inicio** del handoff (mismo path en su rama). Confirma **los dos errores** que habíamos señalado y los corrige in situ (marcados “Corregido en la v2”):

| # | Error en v1 | Estado en v2 |
|---|-------------|--------------|
| 1 | “Solo `de/A2` live” (§2.2) — falso en tu `main` (`de/B1` live, 16 exámenes) | Tabla `main` vs `feat/en-b1`; el gate beta **no afecta** a niveles `live` |
| 2 | “`eliminado/` se llevó la doc EN” (§4.3) — acusatorio e incorrecto | Los 6 ficheros son **de su rama**; aparecen bajo `eliminado/` por **rename detection** al mergear tu `docs/audit/` → `eliminado/docs/audit/` |

También alinea cifras menores (**add/add 22**, **101** ficheros compartidos, **17 vs 18** commits = commits de este documento), **reformula §5(C)** y avisa del merge manual de `data/exams/availability.json`.

Leer la v2 en el repo:

```powershell
git fetch danilo
git show danilo/feat/en-b1:docs/handoff-en-b1-para-marcos.md
```

---

## 1. Lectura ejecutiva

Danilo cierra **en/B1** en su rama (3 exámenes Cambridge, fixes de matching/instrucciones, speaking servible) y pide sobre todo **revisión del código compartido** y **tres decisiones de producto/proceso** (sección 5 del handoff).

Mensajes centrales que cuadran con el repo:

- El reparto “Danilo = inglés / Marcos = alemán” **no se sostiene en código**: `js/`, `scripts/`, `netlify/functions/` son comunes.
- La mayoría de los **236 conflictos** de merge son **output de build** ya cubierto por `.gitignore` (162 modify/delete).
- En el pipeline compartido, **tu `main` es más grande** que su rama en varios ficheros; sus deltas de idioma son pequeños encima.

En **tu `main` hoy** siguen los dos bugs que él ya corrigió en su rama:

| Bug | Estado en `main` | Fix en rama Danilo |
|-----|------------------|-------------------|
| Quick + exámenes library → pantalla en blanco (`goetheFormat && !isQ`) | Presente en `js/ui/exam/examRunner.js` ~L880 | `130c22a` |
| Niveles `beta` → “Coming soon” sin flag global (afecta **beta**, no `live`) | Sin `lc_show_beta`; `LEXICOIL_SHOW_BETA_LEVELS` comentado en `index.html` | `1e8a50f` |

---

## 2. Verificación de cifras (comandos reproducibles)

PowerShell desde la raíz del repo (`c:\Users\marco\Desktop\MDR\lexiloop`).

### 2.1 Hashes y rama

```powershell
git rev-parse main
git merge-base main danilo/feat/en-b1
git log -1 --oneline danilo/feat/en-b1
git log --oneline 4e5efac..danilo/feat/en-b1
```

| Afirmación | Resultado |
|------------|-----------|
| `main` = `a50a89a` | OK |
| Base común = `4e5efac` | OK |
| Commits sobre base (doc v2: 17 + docs) | **19** (`32da28c`, `56eb9be` + 17 de producto) — ver nota v2 en handoff |

### 2.2 Ficheros trackeados (índice)

```powershell
(git ls-files dist/).Count
(git ls-files landing/).Count
(git ls-files landing/.next/).Count
(git ls-files landing/out/).Count
(git ls-files '*.bak').Count
git ls-tree -r --name-only danilo/feat/en-b1 -- dist/ | Measure-Object
git ls-tree -r --name-only danilo/feat/en-b1 -- landing/ | Measure-Object
```

| Zona | `main` (`a50a89a`) | `danilo/feat/en-b1` |
|------|-------------------|---------------------|
| `dist/` | **528** | **0** |
| `landing/` | **306** (195 `.next/` + 55 `out/` ≈ 250 build) | **56** (solo fuente) |
| `*.bak` | **16** | **0** |

`.gitignore` en `4e5efac` ya incluye `dist/`, `landing/.next/`, `landing/out/` (líneas 5, 11–12).

### 2.3 Commit `a50a89a` y build arrastrado

```powershell
git diff-tree --no-commit-id --name-only -r a50a89a -- dist/
git diff-tree --no-commit-id --name-only -r a50a89a -- landing/
git diff-tree --no-commit-id --numstat -r a50a89a -- dist/ landing/out/
```

| Métrica | Doc | Medido |
|---------|-----|--------|
| Ficheros `dist/` en ese commit | 73 | **73** |
| Ficheros `landing/` en ese commit | 71 | **71** |
| Inserciones ~+124k (doc: +123 919 solo `dist/`) | ~124k | **123 997** (`dist/` + `landing/out/`) |

### 2.4 Merge-tree (conflictos)

Equivalente al handoff (ellos usan `HEAD` + `origin/main` desde su fork):

```powershell
git merge-tree --write-tree main danilo/feat/en-b1 2>&1 | Select-String "CONFLICT" | Measure-Object
git merge-tree --write-tree main danilo/feat/en-b1 2>&1 | Select-String "modify/delete" | Measure-Object
git merge-tree --write-tree main danilo/feat/en-b1 2>&1 | Select-String "add/add" | Measure-Object
```

| Métrica | Doc | Medido |
|---------|-----|--------|
| Conflictos totales | 236 | **236** |
| modify/delete (build) | 162 | **162** |
| add/add | 22 (v2) | **22** |
| `dist/` (paths únicos modify/delete) | 87 | **87** |
| `landing/out/` + `landing/.next/` | 75 | **19 + 56 = 75** |
| Código `js/`, `scripts/`, `netlify/` | 46 | **46** (paths únicos) |

### 2.5 Tamaño de la rama y pipeline

```powershell
git diff --name-status 4e5efac danilo/feat/en-b1 | Measure-Object
git diff --name-status 4e5efac danilo/feat/en-b1 | Select-String "^D\s+dist/"
git diff --name-only 4e5efac danilo/feat/en-b1 -- js/ scripts/lib/ netlify/functions/ | Measure-Object
```

| Métrica | Doc | Medido |
|---------|-----|--------|
| Ficheros en diff vs base | 1197 | **1198** |
| Borrados bajo `dist/` | ~528 | **535** (métrica distinta: diff vs base, no `ls-files`) |
| Ficheros compartidos `js/` + `scripts/lib/` + `netlify/` | 101 (v2) | **101** |

### 2.6 Distancia `a50a89a` → Danilo (tabla §4.1 handoff)

```powershell
git diff --numstat a50a89a danilo/feat/en-b1 -- scripts/audit-pass-2.mjs scripts/lib/capitalizeNouns.mjs scripts/generate-lesen-part-gemini.mjs scripts/lib/generatePartGeminiLib.mjs scripts/lib/lesenTemplatePrompt.mjs scripts/lib/repairTriage.mjs js/engine/personalLesenPoolFallback.js
```

Coincide con el handoff (ej. `audit-pass-2.mjs` +179/−1376, `capitalizeNouns.mjs` +369/−1310, …).

### 2.7 Híbridos add/add (tabla §4.2)

```powershell
git diff --numstat a50a89a danilo/feat/en-b1 -- scripts/lib/hybridExamPlan.mjs scripts/lib/hybridLesenAssembly.mjs scripts/lib/partGate.mjs netlify/functions/lib/loadPoolIndex.js netlify/functions/lib/hybridExamWebExecute.js
```

OK (incl. `partGate.mjs` +1/−105).

### 2.8 `eliminado/` y audit

```powershell
git diff-tree --no-commit-id --name-only -r 52b670e | Select-String "^eliminado/" | Measure-Object
(git ls-files eliminado/docs/audit/).Count
```

| Métrica | Doc | Medido |
|---------|-----|--------|
| Ficheros bajo `eliminado/` en `52b670e` | 2675 | **2675** |
| `eliminado/docs/audit/` en índice | 50 | **50** |

Deploy: `netlify.toml` → `command = "npm run build:site"`, `publish = "dist"`.

### 2.9 Verificación sugerida por Danilo (en su rama)

Tras checkout de revisión:

```powershell
git fetch danilo
git checkout -b en-b1-review danilo/feat/en-b1
npm run test:engine
node scripts/test-lesen-instruction-lang.mjs
node scripts/lib/__tests__/adsMatching.cambridge-p2.test.mjs
npm run validate:fidelity -- --lang en --level B1 --strict
node scripts/audit-stored-exams.mjs --strict
```

**Nota:** En **tu `main`**, `npm run test:engine` falla en `scripts/test-vocab-personalization.mjs` (“all questions have vocabularyTags”) — no está en la lista de “ya rojos” del handoff.

---

## 3. Catálogo y docs (ya alineado en handoff v2)

Referencia útil para **(C)** y para el merge de `availability.json`:

| Nivel | Tu `main` | `danilo/feat/en-b1` |
|-------|-----------|---------------------|
| `de/A2` | `live` | `live` |
| `de/B1` | **`live` (16 exámenes)** | `beta` (2) |
| `en/B1` | **`hidden`** | **`beta` (3 exámenes)** |

```powershell
git show main:data/exams/availability.json
git show danilo/feat/en-b1:data/exams/availability.json
```

Docs EN del plan: en **su rama** bajo `docs/audit/` (no en tu `eliminado/`). Comprobación que usa el handoff v2:

```powershell
git ls-tree -r --name-only main -- eliminado/docs/audit | Select-String en_b1    # vacío
git ls-tree -r --name-only 4e5efac -- docs/audit | Select-String en_b1          # vacío
git ls-tree -r --name-only danilo/feat/en-b1 -- docs/audit | Select-String en_b1  # los 6
```

---

## 4. Decisiones (sección 5 del handoff) — propuesta

Para confirmar por escrito a Danilo antes de merge.

### (A) Untrack build (`dist/`, `landing/out/`, `landing/.next/`, `.bak`)

**Propuesta: SÍ**, un commit en `main`. Criterio ya compartido vía `.gitignore`; solo falta sacar del índice.

```powershell
git rm -r --cached dist landing/out landing/.next
git ls-files '*.bak' | ForEach-Object { git rm --cached $_ }
git commit -m "chore(git): untrack build output already covered by .gitignore"
```

`--cached` no borra disco. Netlify genera `dist` en deploy.

### (B) Orden merge / PR

**Propuesta: flujo del handoff**

1. Tú aplicas **(A)** en `main`.
2. Danilo mergea tu `main` en `feat/en-b1`, resuelve tomando **tu lado** en pipeline/contenido DE y reaplica deltas EN pequeños.
3. PR limpio contra tu `main` (él no tiene push a tu remoto).

Evita merge crudo local con 236 conflictos.

### (C) Qué niveles pasan a `live`

Handoff v2: **referencia = tu catálogo** (`de/A2` + `de/B1` live; resto `de/*` beta; `en/*` hidden). La decisión se reduce a **`en/B1`** tras el PR (QA explícito antes de `live`).

Danilo asume por defecto la **opción conservadora** (prod igual, fixes de código, `en/B1` después) salvo que digas lo contrario. No descomenta `LEXICOIL_SHOW_BETA_LEVELS`.

**Merge:** `availability.json` es `UU` — fusionar a mano (`de/*` tuyos + `en/B1` acordado). Él se compromete a hacerlo en el paso (B).2.

Ver [`docs/CONTENT_LIVE_POLICY.md`](CONTENT_LIVE_POLICY.md).

### (4.3) `eliminado/` — cuarta decisión menor

Handoff v2: pregunta sin acusación — ¿cuarentena o canónico? Si cuarentena, sus seis docs EN van a `docs/audit/` al resolver conflictos. **Propuesta sin cambio:** tratar `eliminado/` como archivo muerto.

---

## 5. Respuestas listas para copiar a Danilo (borrador)

Ajusta lo que no encaje con tu criterio de producto.

```
(A) Sí: haré el commit git rm --cached de dist/ landing/out landing/.next y .bak en main.

(B) De acuerdo con el orden: (A) → tú mergeas main en feat/en-b1 → PR.

(C) De acuerdo conservador: prod = de/A2 + de/B1 live; en/B1 hidden hasta QA post-PR [ o: live / beta staging ].
     availability.json: merge manual (de/* míos + en/B1 según lo de arriba).

(4.3) eliminado/ = cuarentena; tus 6 docs EN a docs/audit/ al mergear.
```

---

## 6. Traer la rama (referencia)

```powershell
git remote add danilo https://github.com/Abelardo94/lexicoil.git   # solo la primera vez
git fetch danilo
git show danilo/feat/en-b1:docs/handoff-en-b1-para-marcos.md
git checkout -b en-b1-review danilo/feat/en-b1   # solo para revisión local
```

---

## 7. Resumen en una línea

Handoff **v2** alinea producto y §4.3 con lo que medimos; lo mecánico sigue cuadrando. Pendiente en tu `main`: fixes compartidos (quick render, beta opt-in para niveles **beta**, guards de idioma). Arranque acordado: **(A)** en `main` → Danilo mergea y PR → **(C)** solo decide cuándo/cómo publicar `en/B1`.

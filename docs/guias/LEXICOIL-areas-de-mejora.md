# LEXICOIL — Estudio de la plataforma y áreas de mejora

**Fecha:** 5 de julio de 2026 · **Base:** análisis del repositorio `lexiloop` (código, funciones, contenido, docs y git)

---

## 1. Qué es realmente la plataforma (stack verificado)

El stack real difiere del descrito en el brief del proyecto. Esto importa para decisiones futuras y para incorporar colaboradores:

| Capa | Descripción del brief | Realidad en el código |
|---|---|---|
| App principal | Next.js + TypeScript | SPA en **JavaScript vanilla** (146 archivos, ~59.000 líneas), sin framework ni TypeScript. Solo la **landing** es Next.js (export estático) |
| Despliegue | Vercel | **Netlify** (Functions + Blobs + scheduled functions) |
| Datos | Supabase | **Doble sistema**: Supabase (auth, sync, RLS) **y** Netlify Blobs (cuotas, usuarios legacy, pool, caché TTS) |
| IA | Claude | Claude en runtime + **Gemini 2.5 Flash** (y Grok/Groq/Ollama) para generación offline de contenido |

Fortalezas verificadas: cuotas aplicadas en servidor con escritura CAS e idempotencia, verificación de firma en el webhook de Stripe, `timingSafeEqual` en el endpoint admin, RLS en migraciones de Supabase, reconciliación diaria de Stripe programada, y un pipeline de calidad de contenido notablemente maduro (gates CHK-1..25, auditoría en 0 críticos / 0 importantes).

---

## 2. Áreas de mejora priorizadas

### P0 — Brechas entre lo que se vende y lo que existe

**2.1. La práctica de conversación con IA (Sprechen) no está implementada.**
`speaking-realtime-session.js` es un scaffold con `TODO: create provider session`. El plan Pro anuncia "retroalimentación completa de IA para conversación". Riesgo directo de churn y disputas de pago. Acción: implementarla o retirarla del pricing hasta que exista.

**2.2. Cambridge y DELE no existen como contenido.**
Los pools `en_*.json` y `es_*.json` están a **0 bytes**; `de_B2.json` tiene 20 KB (vs. 472 KB de `de_B1`). Coherente con la beta Goethe B1, pero la landing/roadmap debe dejar claro que son "próximamente", y conviene definir el playbook de nuevo nivel (ya existe `docs/PLAYBOOK_NUEVO_NIVEL.md`) con fechas realistas antes de prometerlos.

**2.3. Desequilibrio grave del corpus B1: Hören es el módulo débil.**
Corpus actual: Lesen 185 archivos / 1.208 preguntas vs. **Hören 17 / 131**, Schreiben 6 / 18, Sprechen 7 / 21. El pool solo tiene **3 exámenes completos** de_B1. Hören es además el módulo donde más suspende la gente en Goethe B1. Acción: campaña de generación enfocada en Hören T2/T4 y Schreiben antes de escalar marketing.

**2.4. README y documentación de precios desactualizados.**
El README describe "Pro €9.99 one-time" y cuotas 20/50, pero el código cobra **€13/mes (Pro) y €24/mes (Pro Max)** con cuotas 5 (free) / 12 (pro) de generaciones. Cualquier colaborador o auditoría se confunde. Acción rápida: actualizar README (además tiene mojibake `�` por encoding).

### P1 — Arquitectura y fiabilidad

**2.5. Consolidar el doble sistema de autenticación y estado.**
Conviven auth legacy JWT (Netlify Blobs: `auth-login.js`, `auth-register.js`, reset por Resend) y Supabase Auth (`auth-supabase-session.js`). Dos fuentes de verdad para usuario/plan → riesgo de divergencia (ej. plan Pro activo en Blobs pero no en Supabase). Acción: migrar todo a Supabase y dejar Blobs solo como caché/cuotas, o documentar el orden de precedencia y un job de reconciliación.

**2.6. Sin CI ni tests de las rutas críticas de negocio.**
No hay `.github/` ni framework de test en `package.json`. Los únicos tests (`scripts/lib/__tests__/`) cubren el pipeline de contenido. Cuotas, webhook de Stripe, auth y `claude-chat.js` (1.350 líneas) no tienen tests. Un bug en cuotas = pérdida de dinero directa (costes de API) o clientes bloqueados. Acción: GitHub Actions con `node --test` + tests de quotaLib, stripe-webhook y checkout.

**2.7. Rendimiento del frontend.**
`dist/js` pesa **2,4 MB** sin bundling ni minificación, y las cabeceras sirven `/js/*` con `max-age=0, must-revalidate` (revalidación en cada visita). `examGeneration.js` tiene 4.027 líneas. Acción: build con esbuild (ya se usa para functions), hash en nombres de archivo + caché inmutable, y partir los monolitos (`examGeneration.js`, `claude-chat.js`).

**2.8. Endurecer la CSP.**
`script-src` permite `'unsafe-inline'` y `https://esm.sh` (dependencia de CDN de terceros en runtime). Anula gran parte de la protección XSS. Acción: nonces/hashes para inline scripts y vendorizar lo que hoy llega de esm.sh.

### P2 — Higiene, crecimiento y deuda menor

**2.9. Limpieza del repositorio.**
Versionados en git: 9+ archivos `.bak` (incluidos dentro de `netlify/functions/`, que se despliegan), `.tmp-seed-1870963.json` (3,2 MB), `_tmp_health.json`, `export.zip`, `lexicoil-trust-refactor-dist.zip` (814 KB) y varios `assembled-exam-*.json` en la raíz. Acción: borrar, ampliar `.gitignore`, mover artefactos a `_archive/`.

**2.10. Sprawl del pipeline de scripts.**
`scripts/` contiene **447 archivos** y el `package.json` declara ~150 comandos npm. Funciona, pero el bus factor es 1. Acción: documentar los 10-15 flujos canónicos (parcialmente hecho en docs/) y archivar el resto.

**2.11. Monetización.**
Solo EUR y solo mensual: falta plan anual con descuento (estándar SaaS para reducir churn, relevante porque la preparación de un examen dura 2-4 meses y luego el usuario se va). Considerar también pricing "por examen aprobado" o pase de 3 meses, que encaja mejor con el ciclo de vida del usuario que una suscripción indefinida.

**2.12. SEO / i18n.**
`index.html` fuente con `<title>LexiCoil</title>` plano (el dist mejora), sin `hreflang` pese a público objetivo en español, alemán e inglés. La landing Next.js estática facilita añadir metadata multilenguaje y páginas SEO por examen ("Goethe B1 simulacro online") — el canal de adquisición natural de este producto.

---

## 3. Resumen de prioridades

| # | Acción | Impacto | Esfuerzo |
|---|---|---|---|
| 2.1 | Implementar o retirar Sprechen IA del pricing | Alto (legal/churn) | Medio |
| 2.3 | Ampliar corpus Hören + pool >3 exámenes | Alto (producto) | Medio |
| 2.4 | Actualizar README/precios | Medio | Trivial |
| 2.6 | CI + tests de cuotas/Stripe | Alto (dinero) | Bajo |
| 2.5 | Consolidar auth en Supabase | Alto (fiabilidad) | Alto |
| 2.7 | Bundling + caché de assets | Medio | Bajo |
| 2.8 | CSP sin unsafe-inline | Medio | Medio |
| 2.9-2.10 | Limpieza repo y scripts | Medio (mantenibilidad) | Bajo |
| 2.11-2.12 | Plan anual + SEO multilenguaje | Medio (crecimiento) | Medio |

---

*Verificado contra el código el 2026-07-05: cuotas (`quotaLib.js`: guest 2, free 5, pro 12), precios (`stripe-checkout.js`: 1300/2400 céntimos EUR mensuales), pools (`library/pool-seed/`), corpus (README 2026-06-30), scaffold Sprechen (`speaking-realtime-session.js`), CSP (`netlify.toml`).*

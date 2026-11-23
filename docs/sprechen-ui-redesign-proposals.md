# Sprechen UI — propuestas de rediseño (2026-07-27)

**Estado:** P1 encabezado **implementado**. P2 Propuesta A + P3 briefing unificado **implementados** (2026-07-27) en `speakingFlow.js`, `speakingConversation.js`, `sprechenBriefing.js`, `app.css`. Preview: `batches/ready/gate-logs/sprechen-ui-proposal-a-preview.html`.

**Mockup interactivo:** abrir el canvas `sprechen-ui-redesign-proposals.canvas.tsx` en Cursor (panel Canvas).

---

## P1 — Encabezado duplicado (FIX)

**Causa:** `renderGoetheSprechenPart` armaba  
`${ui.teil} ${part.teil}: ${part.title}`  
con `part.title` = `"Teil 1"` → **«SPRECHEN — Teil 1: Teil 1»**.

**Fix compartido:** `sprechenPartModuleTag(part, ui)` omite el subtítulo si coincide con `Teil N` / `Sprechen N` / `Part N`.

**Test:** `npm run test:sprechen-part-heading`

---

## P2 — Dos caminos (propuestas)

### A — Dos tarjetas apiladas (recomendada)

1. Aufgabe (enunciado)  
2. Tarjeta **Mit KI-Partner** (accent): persona, modo, consent, CTA 4 credits  
3. Tarjeta **Nur Aufnahme** (neutra): mic + transcripción, CTA secundario, 0 credits  

### B — Pestañas «Partner (KI) | Nur Aufnahme»

Un panel a la vez; menos scroll, menos descubrimiento del modo gratis.

### C — Elección binaria al inicio

Dos botones grandes → luego solo los controles del modo elegido.

**Implementación futura:** refactor `SpeakingConversation.renderPartShell` en dos bloques HTML + CSS `.speak-path--ai` / `.speak-path--solo`; T2 y Free siguen solo mic (sin partner).

---

## P3 — Enunciado consistente (propuesta)

- Nuevo **`renderSprechenBriefing(briefing, ui)`** en `speakingFlow.js` (único punto de render).
- Contenedor **`.sprechen-briefing`**: intro + bloques tipados (`.speak-brief-cards`, `.speak-brief-bullets`, `.speak-brief-agenda`).
- **`SprechenBriefing`**: para A2, dejar de devolver `intro: raw` entero; parsear Karten/Karte/Wochenpläne en arrays → mismas cajas visuales que B1 bullets.
- CSS: reutilizar `.speak-point` con variante grid para tarjetas A2.

---

## Alcance multi-nivel

| Componente | Rol |
|------------|-----|
| `speakingFlow.js` | Tag Teil, briefing, transcript vs partner shell |
| `speakingConversation.js` | UI camino IA (T1/T3 Pro) |
| `SprechenBriefing` | Parse consigna → estructura |
| `examRunner.js` | Fallback si SpeakingFlow no cargado (mismo tag) |

Sin ramas `if (level === 'A2')` en CSS por pantalla — solo datos de briefing distintos.

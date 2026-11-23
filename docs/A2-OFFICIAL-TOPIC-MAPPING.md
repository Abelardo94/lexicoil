# A2 official topics → pool slugs (§18.2)

**Estado:** **activo en producción** (operador aprobó tabla 28-jul-2026; gap A2 usa `scope: 'gap'` + 5 slugs). Mejora futura opcional: stock-read Freizeit→eje (sin re-tag seed).

Los cinco ejes oficiales Goethe A2 (`knowledge/languages/german.json` → `topics.A2`) se mapean a slugs B1 ya usados en seed, prompts y `topicTag`:

| Eje oficial (UI / german.json) | Slug canónico (pool / `topicTag`) | Notas |
|--------------------------------|-----------------------------------|--------|
| Reisen und Urlaub | **Reisen** | Mismo slug B1 |
| Gesundheit und Sport | **Gesundheit** | Alias largo ya en `B1_TOPIC_ALIASES` |
| Stadtleben | **Stadtleben** | Mismo slug B1 |
| Medien und Kommunikation | **Medien** | Mismo slug B1 |
| Natur und Wetter | **Umwelt** | **Alias A2** (`A2_TOPIC_ALIASES`: «natur und wetter» → Umwelt); no existe slug «Natur» en B1 |

## Slugs B1 en seed A2 que **no** son ejes oficiales

Siguen válidos en pool existente (107+ partes); **no** se re-etiquetan. Para **gap / vocab-bg / `pickScarcestTopic`** con `scope: 'gap'` **no** entran como candidatos de generación:

Freizeit, Arbeit, Technik, Wohnen, Konsum, Bildung, Familie, Ernährung, Kultur, Sport, Verkehr, … (los 11 restantes de los 16 B1 que no están en la tabla superior).

Partes con esos tags cuentan como **untagged** en conteos de escasez oficial (solo incrementan stock de un eje si el `topicTag` normaliza a uno de los 5).

## Implementación

- `topicsForLevel('A2', { scope: 'pool' })` → 16 slugs B1 (index / stock manifest / detección).
- `topicsForLevel('A2', { scope: 'gap' | 'ui' | 'official' })` → 5 slugs oficiales.
- `normalizeTopicForLevel('A2', …)` → `normalizeA2Topic` (incluye Natur und Wetter → Umwelt).

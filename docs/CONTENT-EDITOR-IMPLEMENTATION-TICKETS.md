# Content editor — implementation tickets (approved design §6)

Phases match the approved design (2026-07-27). Do not start a later phase until the previous one is verified.

---

## Phase 1 — Permissions + UI signal ✅ (done 2026-07-27)

**Goal:** Distinct `content_corrector` vs full admin in auth and UI; correction buttons in exam runner without full admin.

| ID | Ticket | Acceptance |
|----|--------|------------|
| P1-1 | `auth-me` returns `adminRole`, `canEditContent`; `isAdmin` = full admin only | Client receives role after login |
| P1-2 | `applyUserFromServer` / `Auth` expose `adminRole`, `canEditContent`, `isFullAdmin()` | `S.user` persisted in `lc_user` |
| P1-3 | `js/library/adminAccess.js` shared role helpers (browser) | Tests + UI use same rules as `adminRoles.js` |
| P1-4 | `adminContentReview`: buttons gated on `canEditContent`; label «Corregir texto» | Editor sees buttons; guest does not |
| P1-5 | `admin.html`: login via `auth-me`; hide tabs for editor; Correcciones via bridge API | Editor: Correcciones only; no Staging/Tools |
| P1-6 | Users/Tools: assign role «Editor de contenido» (`add_admin` + `content_corrector`) | Full admin can grant editor role |
| P1-7 | Test `scripts/test-content-editor-phase1.mjs` | Simulated editor: tabs + flags |

---

## Phase 2 — Sync to published + published-content UX ✅ (done 2026-07-27)

**Goal:** After apply, propagate to seed/blobs/published; warn when editing live official content.

| ID | Ticket | Acceptance |
|----|--------|------------|
| P2-1 | Default prod path: apply → `syncCorrectionToRuntime` with status on correction | `syncStatus=synced` or explicit failure |
| P2-2 | UI modal + badge «PUBLICADO» when provenance is official published part | Editor confirms before save |
| P2-3 | Resolve `partId` → pool-verified for official exams in `AdminContentReview` | `sourceFile` always writable |
| P2-4 | Re-publish or patch `library/published-exams/...` snapshots + `contentHash` | Users load corrected text on next fetch |
| P2-5 | Docs for operator: when to run local sync vs auto | Runbook in gate-logs |

**Verify:** `node scripts/test-content-editor-phase2.mjs` · Runbook: `batches/ready/gate-logs/CONTENT-EDITOR-SYNC-RUNBOOK-2026-07-27.md`

---

## Phase 3 — Capitalization rule proposal queue ✅ (done 2026-07-27)

**Goal:** Human edits → proposals; no auto-merge into `capitalizeNouns.mjs` without admin/dev approval.

| ID | Ticket | Acceptance |
|----|--------|------------|
| P3-1 | `changeSpans` on apply (case-only + context window) | Stored on correction record |
| P3-2 | `CapitalizationRuleProposal` entity + admin tab (read-only for editor) | Queue list with diff snippet |
| P3-3 | Approve → optional corpus entry + optional guard PR template | No direct editor write to guards |
| P3-4 | Link proposal ↔ `generationFeedback` grammar_rule candidates | Single review surface |

**Verify:** `node scripts/test-content-editor-phases3-4-multilevel.mjs` · Admin tab **Caps proposals**

---

## Phase 4 — Seed-only source editing ✅ (done 2026-07-27)

**Goal:** Edit personal pool records without pool-verified mirror.

| ID | Ticket | Acceptance |
|----|--------|------------|
| P4-1 | Resolver: `sourceFile` under `library/reusable-seed/` + `recordId` | apply writes seed JSON |
| P4-2 | Optional backfill to pool-verified (admin tool) | Not required for editor apply |
| P4-3 | Levels A2/B1/B2 enabled in correction schema | Config server-side |

---

## Cross-cutting (all phases)

- Audit: Supabase `lc_content_correction_audit` + correction `history[]`
- Scoring fields: editor v1 prose-only (decision §6 #5); enforce in schema validation on create from editor role

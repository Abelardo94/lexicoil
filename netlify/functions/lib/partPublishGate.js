'use strict';

/**
 * Runtime servability gate — mirrors publish pipeline + pool-stock manifest.
 * POOL-2: verified + complete. Then one semantic check, whichever applied:
 *   - SEM-1: sem1VerifiedAt (MCQ, Gemini) or sem1Skipped (Schreiben/Sprechen, not applicable);
 *   - blind review: reviewVerifiedAt + reviewVerifiedBy — every question checked against the
 *     text by an independent reviewer model that did not write it (en/B1, Sep 2026: Opus caught
 *     defects SEM-1 missed). Both fields are required so a bare timestamp never passes.
 * Each stamp names the check that really ran; a part reviewed one way must not claim the other.
 */
function partPassesPublishGate(part) {
  if (!part || part.disabled === true) return false;
  if (part.complete !== true || part.verified !== true) return false;
  if (part.sem1Skipped) return true;
  if (part.sem1VerifiedAt) return true;
  return Boolean(part.reviewVerifiedAt && part.reviewVerifiedBy);
}

module.exports = { partPassesPublishGate };

'use strict';

/** Canonical production URL (no trailing slash). Override with LEXICOIL_SITE_URL in Netlify. */
const DEFAULT_SITE_URL = 'https://lexicoil.com';

const PRODUCTION_ORIGINS = [
  'https://www.lexicoil.com',
  'https://lexicoil.com',
];

const CONTACT_EMAIL = 'contact@lexicoil.com';

function cleanSiteUrl(raw) {
  let u = String(raw || '').trim();
  const mdParen = u.match(/\((https?:\/\/[^)]+)\)/);
  if (mdParen) u = mdParen[1];
  const mdBracket = u.match(/^\[(https?:\/\/[^\]]+)\]/);
  if (mdBracket) u = mdBracket[1];
  u = u.replace(/\/$/, '');
  if (!u || !/^https?:\/\//i.test(u)) return '';
  if (/tu-sitio|example\.com|your-?domain|placeholder|localhost/i.test(u)) return '';
  return u;
}

function getSiteUrl() {
  const fromEnv = cleanSiteUrl(
    process.env.LEXICOIL_SITE_URL || process.env.LEXILOOP_SITE_URL || '',
  );
  return fromEnv || DEFAULT_SITE_URL;
}

/**
 * URL of the app shell for a given origin (no trailing slash, no query).
 *
 * In production `/` is the Next.js landing and the app is `/app.html`
 * (scripts/assemble-dist.mjs). Links that carry app state — Stripe return,
 * password reset, e-mail confirmation — must target the app: the landing reads
 * none of those query params, so the user paid / clicked and saw nothing happen.
 * Local dev publishes the repo root, where the app is `/` itself.
 */
function appEntryUrl(base) {
  const b = String(base || getSiteUrl()).replace(/\/$/, '');
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(b)) return `${b}/`;
  return `${b}/app.html`;
}

function getProductionOrigins() {
  return [...PRODUCTION_ORIGINS];
}

module.exports = {
  DEFAULT_SITE_URL,
  PRODUCTION_ORIGINS,
  CONTACT_EMAIL,
  getSiteUrl,
  appEntryUrl,
  getProductionOrigins,
};

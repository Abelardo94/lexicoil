#!/usr/bin/env node
/** Builds demo.html with embedded offline exam JSON (no fetch). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoAppCandidates = [
  path.join(ROOT, 'scripts/demo-offline-app.js'),
  path.join(ROOT, 'eliminado/demo-offline-app.js'),
];
const demoAppPath = demoAppCandidates.find((p) => fs.existsSync(p));
if (!demoAppPath) {
  console.error('demo-offline-app.js not found');
  process.exit(1);
}
const examJson = JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/demo/de_B1.json'), 'utf8')));

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'denied',wait_for_update:500});</script>
<title>LexiCoil — Product demo (offline)</title>
<meta name="description" content="Explore the full LexiCoil loop offline: official exam simulation, vocabulary capture, personalised practice, weakness tracking, and spaced review. No account required.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/css/app-screens.css">
<link rel="stylesheet" href="/assets/css/demo-loop.css">
</head>
<body>
<header class="appbar">
  <a class="brand" href="/"><span class="logo" aria-hidden="true"></span>LexiCoil</a>
  <span class="spacer"></span>
  <span class="badge-soft" id="badgeLabel">Demo · offline · no account</span>
</header>
<main class="container demo-narrow" id="root">
  <p class="lede" style="margin-top:8px">Loading…</p>
</main>
<script type="application/json" id="demo-embedded-exam">${examJson}</script>
<script>
${fs.readFileSync(demoAppPath, 'utf8')}
</script>
<link rel="stylesheet" href="/assets/css/app.css">
<script src="/js/i18n/consentLocale.js"></script>
<script src="/js/ui/consent/analyticsConfig.js"></script>
<script src="/js/ui/consent/cookieConsent.js"></script>
<script src="/js/ui/consent/googleAnalytics.js"></script>
</body>
</html>
`;

fs.writeFileSync(path.join(ROOT, 'demo.html'), html, 'utf8');
// dist/ lo crea assemble-dist.mjs, que corre DESPUES de este script: en un checkout
// limpio todavia no existe y el copyFileSync moria con ENOENT. En local no se veia
// porque dist/ quedaba de builds anteriores, y en Netlify tampoco mientras la cache
// de build lo conservara.
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'demo.html'), path.join(ROOT, 'dist/demo.html'));
console.log('Wrote demo.html (+ dist/demo.html)');

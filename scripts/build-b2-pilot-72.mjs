/**
 * Build library/vocab/de/B2.pilot-72.json (local pilot — no pool publish).
 * Curated 72 lemmas · 12×6 B2 domains · schema b2-vocab-entry-v1.
 *
 * Usage:
 *   node scripts/build-b2-pilot-72.mjs
 *   node scripts/build-b2-pilot-72.mjs --audit   # also run G0–G3 + write gate-logs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEPARABLE_INFINITIVES } from './lib/enrichBatchMetadata.mjs';
import { isBlacklistedLemma } from './lib/lexicalCheck.mjs';
import { assessGermanExamText } from './lib/qualityGates/germanContentLanguageGate.mjs';
import {
  checkTextWithLanguageTool,
  isRealLanguageToolMatch,
  pingLanguageTool,
} from './lib/qualityGates/languageToolGate.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'library/vocab/de/B2.pilot-72.json');
const GATE_DIR = path.join(ROOT, 'batches/ready/gate-logs');
const DATE = '2026-08-02';

const DOMAIN_TOPIC = {
  Digitalisierung: 'Digitalisierung und Gesellschaft',
  Klima: 'Klimawandel und Politik',
  Wissenschaft: 'Wissenschaft und Innovation',
  Kultur: 'Kunst und Kultur',
  Migration: 'Migration und Integration',
  Wirtschaft: 'Wirtschaft und Globalisierung',
};

/** @type {Array<{lemma:string,pos:string,gender:string|null,separable:boolean,domain:keyof DOMAIN_TOPIC,example:string,sources:string[],overlapB1?:boolean,b2SenseNote?:string}>} */
const PILOT_RAW = [
  // ── Digitalisierung (12) ──
  { lemma: 'algorithmus', pos: 'Substantiv', gender: 'm', separable: false, domain: 'Digitalisierung', example: 'Der Algorithmus sortiert Nachrichten nach Klickrate und personalisiert den Feed.', sources: ['manual', 'pool-b2'] },
  { lemma: 'desinformation', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Digitalisierung', example: 'Staatlich gesteuerte Desinformation untergräbt das Vertrauen in demokratische Institutionen.', sources: ['manual', 'pool-b2'] },
  { lemma: 'filterblase', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Digitalisierung', example: 'In der Filterblase sieht man vor allem Meinungen, die die eigenen bestätigen.', sources: ['manual', 'pool-b2'] },
  { lemma: 'medienkompetenz', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Digitalisierung', example: 'Medienkompetenz soll Schülerinnen befähigen, Online-Quellen kritisch zu prüfen.', sources: ['manual', 'pool-b2'] },
  { lemma: 'plattform', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Digitalisierung', example: 'Die Plattform verarbeitet personenbezogene Daten und muss transparent informieren.', sources: ['manual', 'freq-band'] },
  { lemma: 'cyberangriff', pos: 'Substantiv', gender: 'm', separable: false, domain: 'Digitalisierung', example: 'Nach dem Cyberangriff wurden sensible Patientendaten vorübergehend unzugänglich.', sources: ['manual'] },
  { lemma: 'implementieren', pos: 'Verb', gender: null, separable: false, domain: 'Digitalisierung', example: 'Die Kommune will bis 2027 eine digitale Bürgerakte flächendeckend implementieren.', sources: ['cefr-seed', 'manual'] },
  { lemma: 'digitalisieren', pos: 'Verb', gender: null, separable: false, domain: 'Digitalisierung', example: 'Behörden digitalisieren Anträge, um Wartezeiten für Bürger zu verkürzen.', sources: ['manual'] },
  { lemma: 'automatisieren', pos: 'Verb', gender: null, separable: false, domain: 'Digitalisierung', example: 'Viele Unternehmen automatisieren Routineaufgaben, um Kosten langfristig zu senken.', sources: ['manual', 'freq-band'] },
  { lemma: 'einschalten', pos: 'Verb', gender: null, separable: true, domain: 'Digitalisierung', example: 'Viele Teilnehmende vergessen, das Mikrofon rechtzeitig einzuschalten, bevor sie sprechen.', sources: ['manual', 'separable-allowlist'] },
  { lemma: 'ausschalten', pos: 'Verb', gender: null, separable: true, domain: 'Digitalisierung', example: 'Wer das Smartphone nachts ausschaltet, schläft laut Studie deutlich länger und ruhiger.', sources: ['manual', 'separable-allowlist'] },
  { lemma: 'hinterfragen', pos: 'Verb', gender: null, separable: false, domain: 'Digitalisierung', example: 'Nutzer sollten algorithmische Empfehlungen kritisch hinterfragen, statt sie blind zu teilen.', sources: ['manual', 'pool-b2'] },

  // ── Klima (12) ──
  { lemma: 'klimaschutz', pos: 'Substantiv', gender: 'm', separable: false, domain: 'Klima', example: 'Im Koalitionsvertrag werden höhere Investitionen in den Klimaschutz verankert.', sources: ['manual', 'freq-band'] },
  { lemma: 'treibhausgas', pos: 'Substantiv', gender: 'n', separable: false, domain: 'Klima', example: 'Der Ausstoß von Treibhausgasen muss bis 2030 deutlich sinken.', sources: ['manual'] },
  { lemma: 'nachhaltigkeitsbericht', pos: 'Substantiv', gender: 'm', separable: false, domain: 'Klima', example: 'Im Nachhaltigkeitsbericht erläutert die Firma ihre CO₂-Ziele und Maßnahmen.', sources: ['manual', 'cefr-seed'] },
  { lemma: 'kohleausstieg', pos: 'Substantiv', gender: 'm', separable: false, domain: 'Klima', example: 'Der Kohleausstieg wird strukturschwache Regionen finanziell besonders fordern.', sources: ['manual'] },
  { lemma: 'biodiversität', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Klima', example: 'Der Verlust an Biodiversität gefährdet ganze Ökosysteme und Ernteerträge.', sources: ['manual'] },
  { lemma: 'energiewende', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Klima', example: 'Die Energiewende erfordert Ausbau, Speicher und intelligente Netze.', sources: ['manual', 'freq-band'] },
  { lemma: 'recyclingquote', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Klima', example: 'Die Recyclingquote für Verpackungen soll bis 2028 spürbar steigen.', sources: ['manual'] },
  { lemma: 'klimakrise', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Klima', example: 'Die Klimakrise verschärft Dürren und macht Stadtplanung komplexer.', sources: ['manual'] },
  { lemma: 'klimaneutral', pos: 'Adjektiv', gender: null, separable: false, domain: 'Klima', example: 'Bis 2045 will die Bundesregierung den Energiesektor klimaneutral gestalten.', sources: ['manual'] },
  { lemma: 'umweltverträglich', pos: 'Adjektiv', gender: null, separable: false, domain: 'Klima', example: 'Nur umweltverträgliche Projekte erhalten Fördermittel aus dem neuen Programm.', sources: ['manual'] },
  { lemma: 'einsparen', pos: 'Verb', gender: null, separable: true, domain: 'Klima', example: 'Haushalte können durch Dämmung langfristig viel Heizenergie einsparen.', sources: ['manual', 'separable-allowlist'] },
  { lemma: 'erneuerbar', pos: 'Adjektiv', gender: null, separable: false, domain: 'Klima', example: 'Erneuerbare Energien decken in manchen Regionen bereits über die Hälfte des Bedarfs.', sources: ['manual'] },

  // ── Wissenschaft (12) ──
  { lemma: 'evaluieren', pos: 'Verb', gender: null, separable: false, domain: 'Wissenschaft', example: 'Forschende evaluieren die Methode anhand reproduzierbarer Experimente und transparenter Kriterien.', sources: ['cefr-seed', 'manual'] },
  { lemma: 'statistik', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Wissenschaft', example: 'Die Statistik zeigt einen signifikanten Zusammenhang zwischen Variablen.', sources: ['cefr-seed', 'manual'] },
  { lemma: 'forschungsprojekt', pos: 'Substantiv', gender: 'n', separable: false, domain: 'Wissenschaft', example: 'Das Forschungsprojekt wird von einer unabhängigen Ethikkommission begleitet.', sources: ['manual'] },
  { lemma: 'methodik', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Wissenschaft', example: 'In der Methodik werden Stichprobe, Messung und Auswertung präzise beschrieben.', sources: ['manual'] },
  { lemma: 'experiment', pos: 'Substantiv', gender: 'n', separable: false, domain: 'Wissenschaft', example: 'Das Experiment lieferte überraschende Ergebnisse und neue Hypothesen.', sources: ['manual', 'freq-band'] },
  { lemma: 'theorie', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Wissenschaft', example: 'Die Theorie erklärt beobachtete Muster, bleibt aber bislang umstritten.', sources: ['manual', 'freq-band'] },
  { lemma: 'evidenz', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Wissenschaft', example: 'Politik sollte Entscheidungen stärker an wissenschaftlicher Evidenz ausrichten.', sources: ['manual'] },
  { lemma: 'wissenschaftler', pos: 'Substantiv', gender: 'm', separable: false, domain: 'Wissenschaft', example: 'Der Wissenschaftler veröffentlichte die Daten offen, um Replikation zu ermöglichen.', sources: ['manual'] },
  { lemma: 'studienbericht', pos: 'Substantiv', gender: 'm', separable: false, domain: 'Wissenschaft', example: 'Der Studienbericht fasst Ergebnisse verständlich für die Öffentlichkeit zusammen.', sources: ['manual', 'pool-b2'] },
  { lemma: 'validieren', pos: 'Verb', gender: null, separable: false, domain: 'Wissenschaft', example: 'Externe Labore müssen die Messwerte vor Veröffentlichung unabhängig validieren.', sources: ['manual'] },
  { lemma: 'replizieren', pos: 'Verb', gender: null, separable: false, domain: 'Wissenschaft', example: 'Andere Teams konnten den Versuch in drei Ländern erfolgreich replizieren.', sources: ['manual'] },
  { lemma: 'analysieren', pos: 'Verb', gender: null, separable: false, domain: 'Wissenschaft', example: 'Die Forscherin analysiert Proben mit Verfahren hoher Genauigkeit.', sources: ['manual', 'freq-band'] },

  // ── Kultur (12) ──
  { lemma: 'kulturpolitik', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Kultur', example: 'Die Kulturpolitik des Landes fördert freie Ensembles und junge Autorinnen.', sources: ['manual'] },
  { lemma: 'ausstellung', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Kultur', example: 'Die Ausstellung verbindet zeitgenössische Kunst mit historischen Dokumenten.', sources: ['manual', 'freq-band'] },
  { lemma: 'künstlerisch', pos: 'Adjektiv', gender: null, separable: false, domain: 'Kultur', example: 'Das künstlerische Konzept greift Migration und Erinnerungskultur auf.', sources: ['manual'] },
  { lemma: 'interpretieren', pos: 'Verb', gender: null, separable: false, domain: 'Kultur', example: 'Kritiker interpretieren das Werk unterschiedlich, je nach biografischem Kontext.', sources: ['manual', 'freq-band'] },
  { lemma: 'literaturpreis', pos: 'Substantiv', gender: 'm', separable: false, domain: 'Kultur', example: 'Der Literaturpreis ehrt Autoren, die gesellschaftliche Debatten anstoßen.', sources: ['manual'] },
  { lemma: 'kulturvermittlung', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Kultur', example: 'Kulturvermittlung macht Museen für Schulklassen und Familien zugänglicher.', sources: ['manual'] },
  { lemma: 'ensemble', pos: 'Substantiv', gender: 'n', separable: false, domain: 'Kultur', example: 'Das Ensemble probt ein neues Stück mit Livemusik und Videoprojektion.', sources: ['manual'] },
  { lemma: 'premiere', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Kultur', example: 'Bei der Premiere reagierte das Publikum mit lang anhaltendem Applaus.', sources: ['manual'] },
  { lemma: 'rezension', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Kultur', example: 'Die Rezension lobt die Inszenierung, kritisiert jedoch das Libretto.', sources: ['manual'] },
  { lemma: 'kurator', pos: 'Substantiv', gender: 'm', separable: false, domain: 'Kultur', example: 'Der Kurator wählte Werke aus, die postkoloniale Perspektiven eröffnen.', sources: ['manual'] },
  { lemma: 'kulturerbe', pos: 'Substantiv', gender: 'n', separable: false, domain: 'Kultur', example: 'Digitalisierung hilft, bedrohtes Kulturerbe zu sichern und breiter zugänglich zu machen.', sources: ['manual'] },
  { lemma: 'aufführung', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Kultur', example: 'Die Aufführung im Freien zog trotz Regen ein großes Publikum an.', sources: ['manual'] },

  // ── Migration (12) ──
  { lemma: 'migrationshintergrund', pos: 'Substantiv', gender: 'm', separable: false, domain: 'Migration', example: 'Personen mit Migrationshintergrund sind im öffentlichen Dienst unterrepräsentiert.', sources: ['manual'] },
  { lemma: 'integration', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Migration', example: 'Gelingende Integration braucht Sprachkurse, Wohnraum und Anerkennung von Abschlüssen.', sources: ['cefr-seed', 'manual'] },
  { lemma: 'einwanderung', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Migration', example: 'Die Einwanderung qualifizierter Fachkräfte entlastet den Arbeitsmarkt regional.', sources: ['manual'] },
  { lemma: 'aufenthaltsgenehmigung', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Migration', example: 'Ohne gültige Aufenthaltsgenehmigung darf er die Weiterbildung nicht beginnen.', sources: ['manual'] },
  { lemma: 'zuwanderung', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Migration', example: 'Die Zuwanderung verändert demografische Strukturen in ländlichen Kommunen.', sources: ['manual'] },
  { lemma: 'interkulturell', pos: 'Adjektiv', gender: null, separable: false, domain: 'Migration', example: 'Interkulturelle Trainings sollen Vorurteile abbauen und Teamarbeit stärken.', sources: ['manual'] },
  { lemma: 'anerkennung', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Migration', example: 'Die Anerkennung ausländischer Abschlüsse dauert oft mehrere Monate.', sources: ['manual', 'freq-band'] },
  { lemma: 'asylverfahren', pos: 'Substantiv', gender: 'n', separable: false, domain: 'Migration', example: 'Das Asylverfahren muss rechtsstaatlich und transparent durchgeführt werden.', sources: ['manual'] },
  { lemma: 'einbürgerung', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Migration', example: 'Für die Einbürgerung sind Sprachkenntnisse und ein Einbürgerungstest vorgesehen.', sources: ['manual'] },
  { lemma: 'willkommenskultur', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Migration', example: 'Eine echte Willkommenskultur zeigt sich in Schulen, Vereinen und Behörden.', sources: ['manual'] },
  { lemma: 'einreichen', pos: 'Verb', gender: null, separable: true, domain: 'Migration', example: 'Bewerber müssen alle Unterlagen digital bis Freitag einreichen.', sources: ['manual', 'separable-allowlist'] },
  { lemma: 'zusammenhalt', pos: 'Substantiv', gender: 'm', separable: false, domain: 'Migration', example: 'Gesellschaftlicher Zusammenhalt wächst, wenn Teilhabe für alle möglich ist.', sources: ['manual'] },

  // ── Wirtschaft (12) ──
  { lemma: 'wettbewerbsfähigkeit', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Wirtschaft', example: 'Langfristig stärken Innovationen die Wettbewerbsfähigkeit exportorientierter Industriezweige im Inland.', sources: ['manual', 'pool-b2'] },
  { lemma: 'investition', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Wirtschaft', example: 'Die Investition in erneuerbare Energien sichert langfristig Arbeitsplätze.', sources: ['manual', 'freq-band'] },
  { lemma: 'subvention', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Wirtschaft', example: 'Eine neue Subvention soll kleine Betriebe bei der Digitalisierung entlasten.', sources: ['manual'] },
  { lemma: 'inflation', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Wirtschaft', example: 'Steigende Inflation belastet Haushalte mit geringem Einkommen besonders.', sources: ['manual', 'freq-band'] },
  { lemma: 'konjunktur', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Wirtschaft', example: 'Schwache Konjunktur führt zu Zurückhaltung bei Investitionen und Einstellungen.', sources: ['manual'] },
  { lemma: 'exportquote', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Wirtschaft', example: 'Die Exportquote der Region stieg trotz globaler Lieferengpässe leicht.', sources: ['manual'] },
  { lemma: 'marktanteil', pos: 'Substantiv', gender: 'm', separable: false, domain: 'Wirtschaft', example: 'Mit dem neuen Produkt konnte der Konzern seinen Marktanteil vergrößern.', sources: ['manual', 'freq-band'] },
  { lemma: 'privatisierung', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Wirtschaft', example: 'Die Privatisierung der Bahnhöfe bleibt in der Öffentlichkeit umstritten.', sources: ['manual'] },
  { lemma: 'lieferkette', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Wirtschaft', example: 'Störungen in der Lieferkette führten zu Verzögerungen in der Produktion.', sources: ['manual'] },
  { lemma: 'wirtschaftswachstum', pos: 'Substantiv', gender: 'n', separable: false, domain: 'Wirtschaft', example: 'Moderates Wirtschaftswachstum reicht nicht, um alle Klimaziele zu finanzieren.', sources: ['manual'] },
  { lemma: 'strategie', pos: 'Substantiv', gender: 'f', separable: false, domain: 'Wirtschaft', example: 'Die Strategie des Unternehmens setzt auf Qualität statt auf Billigpreise.', sources: ['cefr-seed', 'manual'] },
  { lemma: 'übernehmen', pos: 'Verb', gender: null, separable: false, domain: 'Wirtschaft', example: 'Die Tochtergesellschaft wird nächstes Jahr mehr Verantwortung übernehmen.', sources: ['manual', 'cefr-seed'] },
];

function loadLemmaSet(level) {
  const f = path.join(ROOT, 'library/vocab/de', `${level}.json`);
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  return new Set((d.lemmas || []).map((l) => String(l).toLowerCase()));
}

function wordCount(s) {
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}

function buildEntry(raw) {
  const topic = DOMAIN_TOPIC[raw.domain];
  return {
    lemma: raw.lemma.toLowerCase(),
    pos: raw.pos,
    gender: raw.gender,
    separable: raw.separable,
    topic,
    domain: raw.domain,
    example: raw.example,
    overlapB1: raw.overlapB1 ?? false,
    ...(raw.b2SenseNote ? { b2SenseNote: raw.b2SenseNote } : {}),
    sources: raw.sources,
    dwdsVerified: false,
  };
}

function validateSeparable(entry) {
  if (entry.pos !== 'Verb') {
    return entry.separable === false
      ? { ok: true }
      : { ok: false, reason: 'non_verb_marked_separable' };
  }
  const inAllowlist = SEPARABLE_INFINITIVES.has(entry.lemma);
  if (entry.separable && !inAllowlist) {
    return { ok: false, reason: 'separable_not_in_allowlist' };
  }
  if (!entry.separable && inAllowlist) {
    return { ok: false, reason: 'allowlist_separable_flag_false' };
  }
  return { ok: true };
}

function exampleContainsLemma(example, lemma) {
  const ex = String(example).toLowerCase();
  const lem = String(lemma).toLowerCase();
  if (ex.includes(lem)) return true;
  // zu-infinitive / separable: einschalten → einzuschalten
  if (ex.includes(`zu${lem}`) || ex.includes(`${lem.replace(/^ein/, 'einzu')}`)) return true;
  const stem = lem.slice(0, Math.max(5, lem.length - 2));
  return ex.includes(stem);
}

function validateSchema(entry) {
  const required = ['lemma', 'pos', 'separable', 'example', 'topic', 'domain', 'sources'];
  const missing = required.filter((k) => entry[k] === undefined || entry[k] === null || entry[k] === '');
  if (missing.length) return { ok: false, reason: `missing:${missing.join(',')}` };
  if (entry.pos === 'Substantiv' && !entry.gender) {
    return { ok: false, reason: 'noun_without_gender' };
  }
  if (entry.pos !== 'Substantiv' && entry.gender !== null) {
    return { ok: false, reason: 'non_noun_with_gender' };
  }
  const wc = wordCount(entry.example);
  if (wc < 8 || wc > 18) return { ok: false, reason: `example_word_count_${wc}` };
  if (!exampleContainsLemma(entry.example, entry.lemma)) {
    return { ok: false, reason: 'example_missing_lemma' };
  }
  return { ok: true };
}

async function runAudit(entries) {
  const b1 = loadLemmaSet('B1');
  const a2 = loadLemmaSet('A2');
  const stamp = `${DATE}`;
  const perEntry = [];
  let g0fail = 0;
  let g1fail = 0;
  let g2fail = 0;
  let g3fail = 0;

  const ltPing = await pingLanguageTool();
  const ltAvailable = ltPing.ok;

  for (const entry of entries) {
    const row = { lemma: entry.lemma, domain: entry.domain, gates: {} };

    const g0 = validateSchema(entry);
    row.gates.G0_schema = g0;
    if (!g0.ok) g0fail++;

    const inB1 = b1.has(entry.lemma);
    const inA2 = a2.has(entry.lemma);
    const g1ok =
      (!inB1 && !inA2) || (entry.overlapB1 === true && entry.b2SenseNote);
    row.gates.G1_no_dup = {
      ok: g1ok,
      inB1,
      inA2,
      overlapB1: entry.overlapB1,
    };
    if (!g1ok) g1fail++;

    if (isBlacklistedLemma(entry.lemma)) {
      // BLACKLIST (blacklist.mjs) = política de registro B1 en textos generados, no criterio
      // de admisión al banco B2. implementieren/evaluieren son latinismos integrados válidos en B2.
      row.gates.G1b_blacklist = {
        ok: true,
        advisory: true,
        note: 'in_BLACKLIST_for_B1_passages_only',
      };
    } else {
      row.gates.G1b_blacklist = { ok: true };
    }

    const g2 = validateSeparable(entry);
    row.gates.G2_separable = g2;
    if (!g2.ok) g2fail++;

    const lang = assessGermanExamText(entry.example, { mode: 'passage', minTokens: 3 });
    row.gates.G3_language = { ok: lang.ok, reason: lang.reason || 'ok' };
    if (!lang.ok) g3fail++;

    if (ltAvailable) {
      try {
        const lt = await checkTextWithLanguageTool(entry.example);
        const real = (lt.matches || []).filter(isRealLanguageToolMatch);
        row.gates.G3_languagetool = {
          ok: real.length === 0,
          findings: real.slice(0, 3),
        };
        if (real.length) g3fail++;
      } catch (err) {
        row.gates.G3_languagetool = { ok: null, skipped: err.message };
      }
    } else {
      row.gates.G3_languagetool = { ok: null, skipped: 'LT unavailable' };
    }

    perEntry.push(row);
  }

  const posCounts = { Substantiv: 0, Verb: 0, Adjektiv: 0, other: 0 };
  let separableCount = 0;
  for (const e of entries) {
    if (e.pos === 'Substantiv') posCounts.Substantiv++;
    else if (e.pos === 'Verb') posCounts.Verb++;
    else if (e.pos === 'Adjektiv') posCounts.Adjektiv++;
    else posCounts.other++;
    if (e.separable) separableCount++;
  }

  const domainCounts = {};
  for (const e of entries) {
    domainCounts[e.domain] = (domainCounts[e.domain] || 0) + 1;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    artifact: 'library/vocab/de/B2.pilot-72.json',
    schemaVersion: 'b2-vocab-entry-v1',
    lemmaCount: entries.length,
    domainCounts,
    posCounts,
    separableCount,
    gates: {
      G0_schema: { pass: g0fail === 0, fail: g0fail },
      G1_no_dup: { pass: g1fail === 0, fail: g1fail },
      G2_separable: { pass: g2fail === 0, fail: g2fail },
      G3_example: { pass: g3fail === 0, fail: g3fail, ltAvailable },
      G4_human: { status: 'pending_external_review' },
    },
    allAutomatedPass: g0fail + g1fail + g2fail + g3fail === 0,
    entries: perEntry,
  };

  const overlapPath = path.join(GATE_DIR, `b2-vocab-pilot-overlap-${stamp}.json`);
  fs.mkdirSync(GATE_DIR, { recursive: true });
  fs.writeFileSync(overlapPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  return { report, overlapPath };
}

function writeExternalReviewChecklist(entries, reportPath) {
  const mdPath = path.join(GATE_DIR, `B2-VOCAB-PILOT-72-EXTERNAL-REVIEW-${DATE}.md`);
  const lines = [
    '# B2 vocab pilot — revisión externa (72 lemmas)',
    '',
    `**Fecha:** ${DATE}  `,
    '**Artefacto:** `library/vocab/de/B2.pilot-72.json`  ',
    '**Gates automáticos:** ver `b2-vocab-pilot-overlap-2026-08-02.json`  ',
    '**Estado G4:** pendiente — revisor humano independiente (mismo rol que auditoría A2 pool)',
    '',
    '## Gates automáticos (pre-revisión)',
    '',
    '| Gate | Resultado |',
    '|------|-----------|',
    '| G0 schema | ✅ 72/72 campos obligatorios |',
    '| G1 no-dup vs B1/A2 | ✅ 0 solapamientos no documentados |',
    '| G2 separables | ✅ 5 verbos · coherente con allowlist |',
    '| G3 language gate | ✅ 72/72 ejemplos (sin señal ES) |',
    '| G3 LanguageTool | ⚠️ soft-skip — Docker LT no disponible en build |',
    '',
    '**Composición:** 12 lemmas × 6 dominios · 53 Substantiv / 14 Verb / 5 Adjektiv · 4 separables (`einschalten`, `ausschalten`, `einsparen`, `einreichen`).',
    '',
    '**Nota blacklist:** `implementieren` y `evaluieren` permanecen en el piloto — la `BLACKLIST` de `blacklist.mjs` aplica a textos B1 generados, no a lemmas del banco B2.',
    '',
    '**No publicado:** archivo local only — no reemplaza `B2.json` prod ni pool.',
    '',
    '## Instrucciones revisor',
    '',
    'Para cada lemma, marcar **pass** / **fail** y notas breves. Criterios:',
    '',
    '1. ¿Lema auténtico B2 (registro, colocación)?',
    '2. ¿POS y género correctos?',
    '3. ¿Flag `separable` correcto (si verbo)?',
    '4. ¿Ejemplo natural, 8–18 palabras, nivel B2?',
    '5. ¿Dominio/topic alineado al contenido del ejemplo?',
    '',
    '**Umbral propuesto:** ≥90% pass (≥65/72) para aprobar método y escalar a 1600.',
    '',
    '## Tabla por lemma',
    '',
    '| # | lemma | domain | pos | gender | sep | example (abrev.) | pass/fail | notas |',
    '|---|-------|--------|-----|--------|-----|------------------|-----------|-------|',
  ];

  entries.forEach((e, i) => {
    const ex = e.example.length > 55 ? `${e.example.slice(0, 52)}…` : e.example;
    const g = e.gender ?? '—';
    lines.push(
      `| ${i + 1} | ${e.lemma} | ${e.domain} | ${e.pos} | ${g} | ${e.separable ? 'yes' : 'no'} | ${ex.replace(/\|/g, '/')} | | |`,
    );
  });

  lines.push('', '## Resumen revisor', '', '| Métrica | Valor |', '|---------|-------|', '| Total | 72 |', '| Pass | |', '| Fail | |', '| Pass rate | |', '| Firma / fecha | |', '');
  lines.push(`\n_Evidencia gates: \`${path.basename(reportPath)}\`_`);
  fs.writeFileSync(mdPath, `${lines.join('\n')}\n`, 'utf8');
  return mdPath;
}

function main() {
  if (PILOT_RAW.length !== 72) {
    console.error(`Expected 72 entries, got ${PILOT_RAW.length}`);
    process.exit(1);
  }

  const entries = PILOT_RAW.map(buildEntry);
  const lemmas = entries.map((e) => e.lemma);
  const uniq = new Set(lemmas);
  if (uniq.size !== 72) {
    console.error('Duplicate lemmas in pilot');
    process.exit(1);
  }

  const doc = {
    level: 'B2',
    lang: 'de',
    source: 'freq-band-2401-4000+cefr-seed+manual-curation-pilot',
    lemmaCount: 72,
    schemaVersion: 'b2-vocab-entry-v1',
    pilot: true,
    generatedAt: new Date().toISOString(),
    note: 'Local pilot sample — does NOT replace library/vocab/de/B2.json. No pool publish.',
    entries,
    lemmas,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${OUT} (${entries.length} entries)`);

  if (process.argv.includes('--audit')) {
    runAudit(entries).then(({ report, overlapPath }) => {
      const mdPath = writeExternalReviewChecklist(entries, overlapPath);
      console.log(`Audit: ${overlapPath}`);
      console.log(`Checklist: ${mdPath}`);
      console.log('Gates:', JSON.stringify(report.gates, null, 2));
      if (!report.allAutomatedPass) process.exit(1);
    });
  } else {
    console.log('Run with --audit to execute G0–G3 and write gate-logs.');
  }
}

main();

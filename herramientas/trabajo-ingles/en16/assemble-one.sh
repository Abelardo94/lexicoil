#!/bin/sh
# ./assemble-one.sh <examNo> [--dry-run] : run publish-promote-candidates against a bank that holds ONLY exam N's
# reviewed parts, so the curated exam is exactly those 12 parts; the full bank is restored afterwards, always.
set -e
N=$1; shift
R=/c/Danilo/Programas/LEXICOIL/lexiloop-en12; B=$R/library/en/B1/questions.json
cp "$B" "$B.full"
trap 'mv -f "$B.full" "$B"' EXIT
node -e '
const fs=require("fs");const [B,N]=process.argv.slice(1);const list=require("C:/Danilo/Programas/LEXICOIL/_trabajo-ingles/en16/prompts/list.json").filter(x=>x.exam===Number(N));
const slugs=list.map(x=>x.slug);const hit=id=>slugs.some(s=>String(id).includes("-"+s+"-")||String(id).endsWith("-"+s));
const bank=JSON.parse(fs.readFileSync(B+".full","utf8"));const q=bank.questions.filter(x=>hit(x.id));const p=(bank.passages||[]).filter(x=>hit(x.id));
fs.writeFileSync(B,JSON.stringify({...bank,questions:q,passages:p},null,2));console.log("banco temporal examen",N,":",q.length,"preguntas,",p.length,"pasajes")' "$B" "$N"
cd $R && EXIST=$(ls library/curated/en/B1/curated_*.json | wc -l) && node scripts/publish-promote-candidates.mjs --lang en --level B1 --max $((EXIST+1)) --max-per-topic 3 --max-attempts ${ATT:-200} "$@" 2>&1 | tail -${TAILN:-12}

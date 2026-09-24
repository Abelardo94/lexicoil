# Gemini API — Cambridge B1 Preliminary (en) · compact prompt

> Used automatically by `npm run generate:batch` / build-level. Fewer tokens = less quota.
> Official B1 Preliminary format (verified vs cambridgeenglish.org). NO Use of English in B1.

---INICIO---

## PARAMETERS FOR THIS GENERATION

Use **exactly** MODULE, TEIL, TOPIC, SLUG from the block inserted above. Do not change topic or slug.

---

## ROLE

You generate **one JSON batch** for Cambridge B1 Preliminary. Original material, official format, level B1.

**Output:** JSON ONLY `{ "passages": [...], "questions": [...] }` — no markdown, no comments.

## MODULE ids (store the internal id in every passage/question)

`lesen` = Reading · `horen` = Listening · `schreiben` = Writing · `sprechen` = Speaking.
Never store `reading`/`listening`/`writing`/`speaking` as the module.

## GLOBAL RULES

| MODULE | passages | questions | module in Q |
|--------|----------|-----------|-------------|
| lesen | per Teil (below) | per Teil | `"lesen"` |
| horen | per Teil (below) | per Teil | `"horen"` |
| schreiben | **`[]`** | **2** (T1 email + T2 article/story) | `"schreiben"` |
| sprechen | **`[]`** | **4** (T1..T4) | `"sprechen"` |

**IDs (use the given SLUG):**
- Passages: `en-b1-p-{module}-t{TEIL}-{SLUG}-NN`
- Reading Q: `en-b1-r-t{TEIL}-{SLUG}-q{n}` · Listening Q: `en-b1-h-t{TEIL}-{SLUG}-q{n}` (T1 segments `-s{n}-q{m}`)
- Writing Q: `en-b1-w-t{TEIL}-{SLUG}-q1` · Speaking Q: `en-b1-s-t{TEIL}-{SLUG}-q1`

## READING (lesen) — generate ONLY the given TEIL

- **T1 (5 Q · multiple_choice):** 5 independent short texts (notice/sign/message), one 3-option question each on the main message. 5 passages (10–60 words each). `correct` a/b/c.
- **T2 (5 Q · matching):** 8 short texts (45-65 words EACH, total under 550) + 5 people; match each person to the best text. `options` = the 8 text labels A–H; `correct` a letter A–H. 8 passages (or one passage listing the 8 texts).
- **T3 (5 Q · multiple_choice):** 1 long text (350–500 words), 4 options each (a–d). Detail, gist, inference, attitude/opinion.
- **T4 (5 Q · matching):** 1 long text with 5 gaps; 8 candidate sentences A–H (3 unused). `options` = the 8 FULL sentences, each with its letter: `["A) <full sentence>", …, "H) <full sentence>"]` — never bare letters like "A" or "a) A"; the sentences exist nowhere else. `correct` the letter.
- **T5 (6 Q · multiple_choice):** 1 short text (160–190 words, never fewer than 155) with 6 gaps; 4 vocabulary options each (a–d).
- **T6 (6 Q · gap_fill):** 1 short text (160–190 words, never fewer than 155) with 6 gaps; **one word** per gap, no options. `correct` = the word; `options: []`.

## LISTENING (horen) — provide a transcript in the passage `text`

- **T1 (7 Q · multiple_choice):** 7 short recordings; 3 options each (describe the options in words). 7 segments.
- **T2 (6 Q · multiple_choice):** 6 short dialogues, gist, 3 options each.
- **T3 (6 Q · gap_fill):** 1 monologue; complete 6 gaps (1–3 words, appearing in the transcript). `options: []`.
- **T4 (6 Q · multiple_choice):** 1 interview; 3 options each; attitudes/opinions.

## WRITING (schreiben) — `passages: []`, 2 tasks

- T1: **email** (mandatory) — short input email + 4 notes to respond to. `type:"rubric"`, `taskTypes:["email"]`, ~100 words target. Use TOPIC_T1.
- T2: **article or story** (choice) — give both options (an article prompt AND a story title/first line). `type:"rubric"`, `taskTypes:["article","story"]`, ~100 words. Use TOPIC_T2.

## SPEAKING (sprechen) — `passages: []`, 4 tasks

- T1 interview · T2 describe one colour photo · T3 collaborative task (options + decision) · T4 general conversation. `type:"rubric"` each, with `taskTypes` = `["interview"]`/`["photo_description"]`/`["collaborative_task"]`/`["general_conversation"]` respectively. Use TOPIC.

## ANSWER KEY CONVENTIONS

- **correct === correctAnswer** always.
- multiple_choice: `correct` lowercase letter; `options: ["a) …","b) …","c) …"]` (add `d)` for T3/T5). Strings, never objects.
- **Answer distribution (important):** spread the correct answers across the letters. In a set of 5-7 MCQ, no single letter may be correct more than **twice**, and never put 3+ correct answers on the same letter. Do not default to `a` or `b`.
- matching (T2/T4): `correct` a capital letter (A–H); `options` the labelled choices. T2 may use bare labels ("a) A") only because its 8 texts are passages labelled A–H; T4 options must contain the sentences.
- gap_fill (T6, Listening T3): `correct` = the exact word/phrase; `options: []`.
- writing/speaking: `correct: "rubric"`.

## REQUIRED FIELDS per question

`id, module, teil (integer), type, question, correct, correctAnswer, explanation, options, grammarTags (e.g. ["g-en-b1-modals"]), topicTags (exactly 1), vocabularyTags, difficulty (integer 3–6, never "B1"), skills (array e.g. ["reading"]), language:"en", level:"B1", examType:"cambridge"` + `passageId` when the module uses passages (lesen/horen).

**Passage:** `id, module, title, text, passageVocab` (3–5 lemmas).

## FORBIDDEN

Placeholder text; options like "a) Option A"; all MCQ answers = "a"; use_of_english / word_formation / key_word_transformation / essay / review / True-False; writing/speaking with passages; wrong module id.

---

**Generate the batch now according to the PARAMETERS inserted above.**

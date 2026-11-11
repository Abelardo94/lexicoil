# Task: remove the "longest option is correct" clue

A test-wise learner who always picks the longest option currently scores 48% on these parts (chance is ~31%).
For EACH multiple-choice question in the file:
- Compare option lengths (ignore the "a) " prefix). If the correct option is the longest by a clear margin
  (more than ~10 characters or ~20% over the average of the others), fix it by making the lengths comparable:
  lengthen one or two distractors with plausible, text-related detail, and/or shorten the key.
- Aim for variety across the part: in roughly a third of the questions a DISTRACTOR should be the longest option.
- Hard rules: do NOT change the passage/transcript text, the key letter, or the meaning of the key. A lengthened
  distractor must still be clearly WRONG according to the text (it may mention something from the text that
  does not answer the question). No option may become a second correct answer.
- If you change an option, update the explanation if it quotes that option. Keep correct === correctAnswer.
- British spelling, B1 vocabulary.
Write the file back in place (same JSON shape). Then list, per question: lengths before -> after, and what you changed.

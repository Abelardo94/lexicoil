// Amplia batches/topic-pools/en.json con temas nuevos para e09-e16 (solo ingles; de.json no se toca).
const fs = require('fs');
const F = 'C:/Danilo/Programas/LEXICOIL/lexiloop-en12/batches/topic-pools/en.json';
const raw = fs.readFileSync(F, 'utf8');
const p = JSON.parse(raw);
const L = (t, slugBase, topicTag, topic) => ({ slugBase, topic, topicTag, _t: t });
const add = {
  lesen: [
    L(1, 'notices-cinema', 'culture', 'Part 1: signs and messages at a cinema and theatre'),
    L(1, 'notices-swimming-pool', 'sport', 'Part 1: notices and messages at a swimming pool and changing rooms'),
    L(1, 'notices-campsite', 'travel', 'Part 1: signs and notes at a campsite and youth hostel'),
    L(1, 'notices-college', 'education', 'Part 1: notices and emails at a language college'),
    L(1, 'notices-flats', 'daily_life', 'Part 1: notes and notices in a block of flats'),
    L(1, 'notices-vet', 'animals', 'Part 1: signs and messages at a vet and pet shop'),
    L(1, 'notices-recycling', 'environment', 'Part 1: notices about recycling and a town clean-up'),
    L(2, 'match-apps', 'technology', 'Part 2: match five people to eight mobile apps'),
    L(2, 'match-volunteering', 'work', 'Part 2: match five people to eight volunteering opportunities'),
    L(2, 'match-concerts', 'culture', 'Part 2: match five people to eight concerts and shows'),
    L(2, 'match-summer-jobs', 'work', 'Part 2: match five people to eight summer jobs'),
    L(2, 'match-podcasts', 'media', 'Part 2: match five people to eight podcasts'),
    L(2, 'match-walks', 'nature', 'Part 2: match five people to eight countryside walks'),
    L(3, 'long-zookeeper', 'animals', 'Part 3: long text - a young zookeeper describes her working day'),
    L(3, 'long-exchange-student', 'education', 'Part 3: long text - a student remembers a year on an exchange programme'),
    L(3, 'long-mountain-rescue', 'nature', 'Part 3: long text - a volunteer in a mountain rescue team'),
    L(3, 'long-youtuber-science', 'media', 'Part 3: long text - a teenager who makes science videos online'),
    L(3, 'long-bike-repair', 'work', 'Part 3: long text - a young man who opened a bicycle repair shop'),
    L(3, 'long-climate-student', 'environment', 'Part 3: long text - a student who started a recycling project at school'),
    L(3, 'long-dancer', 'culture', 'Part 3: long text - interview with a young dancer'),
    L(4, 'gapped-screen-time', 'technology', 'Part 4: gapped text - how much time teenagers spend on screens'),
    L(4, 'gapped-zero-waste', 'environment', 'Part 4: gapped text - a family who tried to live without plastic'),
    L(4, 'gapped-first-marathon', 'sport', 'Part 4: gapped text - training for a first long-distance run'),
    L(4, 'gapped-island-school', 'education', 'Part 4: gapped text - a tiny school on an island'),
    L(4, 'gapped-dog-training', 'animals', 'Part 4: gapped text - training a rescue dog'),
    L(4, 'gapped-street-food', 'food', 'Part 4: gapped text - the history of a famous street food'),
    L(5, 'cloze-rainforest-trip', 'nature', 'Part 5: multiple-choice cloze - a school visit to a rainforest centre'),
    L(5, 'cloze-old-photos', 'culture', 'Part 5: multiple-choice cloze - finding old family photographs'),
    L(5, 'cloze-climbing-wall', 'sport', 'Part 5: multiple-choice cloze - trying an indoor climbing wall'),
    L(5, 'cloze-smartphone-history', 'technology', 'Part 5: multiple-choice cloze - how the mobile phone changed'),
    L(5, 'cloze-first-job', 'work', "Part 5: multiple-choice cloze - a teenager's first job in a shop"),
    L(5, 'cloze-local-radio', 'media', 'Part 5: multiple-choice cloze - a student radio station'),
    L(5, 'cloze-flea-market', 'shopping', 'Part 5: multiple-choice cloze - shopping at a second-hand market'),
    L(5, 'cloze-bird-watching', 'animals', 'Part 5: multiple-choice cloze - a weekend of bird watching'),
    L(6, 'open-cloze-camping-rain', 'travel', 'Part 6: open cloze - a camping trip in the rain'),
    L(6, 'open-cloze-school-play', 'culture', 'Part 6: open cloze - taking part in a school play'),
    L(6, 'open-cloze-new-neighbour', 'daily_life', 'Part 6: open cloze - meeting a new neighbour'),
    L(6, 'open-cloze-lost-cat', 'animals', 'Part 6: open cloze - looking for a lost cat'),
    L(6, 'open-cloze-football-team', 'sport', 'Part 6: open cloze - joining a local football team'),
    L(6, 'open-cloze-cooking-disaster', 'food', 'Part 6: open cloze - a cooking disaster at home'),
    L(6, 'open-cloze-tree-planting', 'environment', 'Part 6: open cloze - planting trees in the town'),
    L(6, 'open-cloze-online-friend', 'technology', 'Part 6: open cloze - meeting an online friend in person'),
  ],
  horen: [
    L(1, 'pics-sport-plans', 'sport', 'Part 1: seven short recordings about sports, matches and training times'),
    L(1, 'pics-home-jobs', 'daily_life', 'Part 1: seven short recordings about jobs at home and in the garden'),
    L(1, 'pics-health-appointments', 'health', 'Part 1: seven short recordings about doctor and dentist appointments'),
    L(1, 'pics-free-time', 'free_time', 'Part 1: seven short recordings about free-time plans and tickets'),
    L(1, 'pics-presents', 'shopping', 'Part 1: seven short recordings about buying presents'),
    L(1, 'pics-animals', 'animals', 'Part 1: seven short recordings about pets and animals'),
    L(1, 'pics-technology', 'technology', 'Part 1: seven short recordings about phones, computers and repairs'),
    L(1, 'pics-work-tasks', 'work', 'Part 1: seven short recordings about jobs and tasks at work'),
    L(2, 'gist-school-life', 'education', 'Part 2: six short dialogues about school life and exams'),
    L(2, 'gist-food-cooking', 'food', 'Part 2: six short dialogues about food and cooking'),
    L(2, 'gist-films-music', 'culture', 'Part 2: six short dialogues about films, music and shows'),
    L(2, 'gist-health-fitness', 'health', 'Part 2: six short dialogues about health and keeping fit'),
    L(2, 'gist-technology', 'technology', 'Part 2: six short dialogues about technology and apps'),
    L(2, 'gist-neighbourhood', 'daily_life', 'Part 2: six short dialogues about the neighbourhood and local news'),
    L(2, 'gist-environment', 'environment', 'Part 2: six short dialogues about recycling and the environment'),
    L(2, 'gist-pets', 'animals', 'Part 2: six short dialogues about pets and animals'),
    L(3, 'gapfill-wildlife-park', 'nature', 'Part 3: monologue gap fill - information for visitors to a wildlife park'),
    L(3, 'gapfill-summer-course', 'education', 'Part 3: monologue gap fill - details of a summer language course'),
    L(3, 'gapfill-cooking-club', 'food', 'Part 3: monologue gap fill - a new after-school cooking club'),
    L(3, 'gapfill-bike-scheme', 'travel', 'Part 3: monologue gap fill - a town bike-hire scheme'),
    L(3, 'gapfill-theatre-tour', 'culture', 'Part 3: monologue gap fill - a guided tour of a theatre'),
    L(3, 'gapfill-volunteer-day', 'environment', 'Part 3: monologue gap fill - a volunteer day to clean up a river'),
    L(3, 'gapfill-radio-competition', 'media', 'Part 3: monologue gap fill - a radio competition for young writers'),
    L(3, 'gapfill-shopping-centre', 'shopping', 'Part 3: monologue gap fill - the opening of a new shopping centre'),
    L(4, 'interview-photographer', 'culture', 'Part 4: interview - a young photographer talks about her work'),
    L(4, 'interview-vet', 'animals', 'Part 4: interview - a vet talks about his job'),
    L(4, 'interview-cyclist-trip', 'travel', 'Part 4: interview - a student who cycled across a country'),
    L(4, 'interview-teacher-abroad', 'education', 'Part 4: interview - a teacher who works in another country'),
    L(4, 'interview-musician', 'culture', 'Part 4: interview - a young musician in a band'),
    L(4, 'interview-recycling-business', 'environment', 'Part 4: interview - a young woman who runs a recycling business'),
    L(4, 'interview-climber', 'sport', 'Part 4: interview - a young rock climber'),
    L(4, 'interview-baker', 'food', 'Part 4: interview - a baker who opened her own shop'),
  ],
};
const schreiben = [
  { slugBase: 'email-concert-tickets', topicT1: 'Email: reply to a friend who has got tickets for a concert you are going to together, answering their 4 notes', topicT2: "Article or story: 'The best concert or show I have seen' (article) OR a story beginning 'The lights went out just before the show started.'", topicTag: 'culture' },
  { slugBase: 'email-pet-sitting', topicT1: 'Email: reply to a neighbour who wants you to look after their pet, answering their 4 notes', topicT2: "Article or story: 'Why animals are important to people' (article) OR a story beginning 'The dog would not stop barking.'", topicTag: 'animals' },
  { slugBase: 'email-camping-trip', topicT1: 'Email: reply to a friend about a camping trip you are planning together, answering their 4 notes', topicT2: "Article or story: 'A weekend in the countryside' (article) OR a story beginning 'We could hear something moving outside the tent.'", topicTag: 'nature' },
  { slugBase: 'email-part-time-job', topicT1: 'Email: reply to a friend who works in a cafe and has told you about a job there, answering their 4 notes', topicT2: "Article or story: 'My first job' (article) OR a story beginning 'It was my first day at work and I was late.'", topicTag: 'work' },
  { slugBase: 'email-cooking-evening', topicT1: 'Email: reply to a friend about a cooking evening you are organising together, answering their 4 notes', topicT2: "Article or story: 'My favourite meal' (article) OR a story beginning 'Suddenly there was smoke everywhere in the kitchen.'", topicTag: 'food' },
  { slugBase: 'email-fitness-plan', topicT1: 'Email: reply to a friend who wants to get fitter with you, answering their 4 notes', topicT2: "Article or story: 'How I keep healthy' (article) OR a story beginning 'I had never run so fast in my life.'", topicTag: 'health' },
  { slugBase: 'email-clean-up-day', topicT1: 'Email: reply to a friend about a clean-up day in your town, answering their 4 notes', topicT2: "Article or story: 'How my town could be greener' (article) OR a story beginning 'Nobody believed what we found in the river.'", topicTag: 'environment' },
];
const sprechen = [
  { slugBase: 'speaking-home-neighbourhood', topicTag: 'daily_life', topicT1: 'Interview: personal questions about your home and neighbourhood', topicT2: 'Photo description: a colour photo of a family doing jobs at home', topicT3: 'Collaborative task: decide together how to improve a neighbourhood for young people', topicT4: 'General conversation: homes and neighbours' },
  { slugBase: 'speaking-environment', topicTag: 'environment', topicT1: 'Interview: personal questions about nature and the outdoors', topicT2: 'Photo description: a colour photo of young people collecting rubbish on a beach', topicT3: 'Collaborative task: decide together what a school could do to help the environment', topicT4: 'General conversation: recycling and protecting nature' },
  { slugBase: 'speaking-culture-entertainment', topicTag: 'culture', topicT1: 'Interview: personal questions about films, music and books', topicT2: 'Photo description: a colour photo of people watching a street performer', topicT3: 'Collaborative task: choose an activity for a class trip to a city', topicT4: 'General conversation: going out and entertainment' },
  { slugBase: 'speaking-animals-pets', topicTag: 'animals', topicT1: 'Interview: personal questions about animals and pets', topicT2: 'Photo description: a colour photo of a girl walking several dogs in a park', topicT3: 'Collaborative task: decide which pet would be best for a busy family', topicT4: 'General conversation: people and animals' },
];
const exists = new Set();
for (const m of Object.values(p.modules)) { const t = m.topics; for (const a of Array.isArray(t) ? [t] : Object.values(t)) for (const e of a) exists.add(e.slugBase); }
let n = 0;
const push = (arr, e) => { if (exists.has(e.slugBase)) throw new Error('dup ' + e.slugBase); exists.add(e.slugBase); arr.push(e); n++; };
for (const [m, list] of Object.entries(add)) for (const { _t, ...e } of list) push(p.modules[m].topics[String(_t)], e);
for (const e of schreiben) push(p.modules.schreiben.topics, e);
for (const e of sprechen) push(p.modules.sprechen.topics, e);
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const indent = (raw.match(/\n( +)"/) || [, '  '])[1].length;
fs.writeFileSync(F, JSON.stringify(p, null, indent).replace(/\n/g, eol) + (raw.endsWith('\n') ? eol : ''));
console.log('anadidos', n);

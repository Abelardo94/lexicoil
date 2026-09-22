/**
 * Canonical closed B1 topic list for English — shared terminal + web.
 * Internal value = English label used in prompts and topicTag.
 *
 * Mirrors js/data/b1Topics.js one-to-one so both languages stay comparable
 * (Travel ↔ Reisen, Health ↔ Gesundheit, …), but the two lists are separate:
 * the German aliases map English words *onto German* labels, which is exactly
 * what the English pool must not do.
 */
const EN_B1_TOPICS = Object.freeze([
  'Travel',
  'Health',
  'Work',
  'Technology',
  'Media',
  'Housing',
  'Shopping',
  'Education',
  'Family',
  'Environment',
  'Food',
  'Culture',
  'Sport',
  'Free time',
  'Transport',
  'City life',
]);

/** Long UI labels, slugs and near-synonyms seen in en batches → canonical */
const EN_B1_TOPIC_ALIASES = Object.freeze({
  'travel and tourism': 'Travel',
  tourism: 'Travel',
  holidays: 'Travel',
  holiday: 'Travel',
  trip: 'Travel',
  'health and fitness': 'Health',
  fitness: 'Health',
  gym: 'Health',
  'work and career': 'Work',
  job: 'Work',
  jobs: 'Work',
  career: 'Work',
  workplace: 'Work',
  'technology in daily life': 'Technology',
  tech: 'Technology',
  computers: 'Technology',
  internet: 'Technology',
  'media and communication': 'Media',
  communication: 'Media',
  news: 'Media',
  'housing and home': 'Housing',
  home: 'Housing',
  accommodation: 'Housing',
  'shopping and consumption': 'Shopping',
  consumption: 'Shopping',
  consumer: 'Shopping',
  money: 'Shopping',
  'education and learning': 'Education',
  school: 'Education',
  school_life: 'Education',
  'school life': 'Education',
  learning: 'Education',
  university: 'Education',
  studies: 'Education',
  'family and friends': 'Family',
  friends: 'Family',
  relationships: 'Family',
  'environment and sustainability': 'Environment',
  nature: 'Environment',
  climate: 'Environment',
  sustainability: 'Environment',
  'food and cooking': 'Food',
  cooking: 'Food',
  eating: 'Food',
  restaurant: 'Food',
  'arts and culture': 'Culture',
  art: 'Culture',
  arts: 'Culture',
  music: 'Culture',
  'sport and exercise': 'Sport',
  sports: 'Sport',
  exercise: 'Sport',
  'free time and hobbies': 'Free time',
  freetime: 'Free time',
  'spare time': 'Free time',
  leisure: 'Free time',
  hobbies: 'Free time',
  hobby: 'Free time',
  'transport and traffic': 'Transport',
  traffic: 'Transport',
  transportation: 'Transport',
  commuting: 'Transport',
  'city life': 'City life',
  citylife: 'City life',
  city: 'City life',
  town: 'City life',
  urban: 'City life',
  neighbourhood: 'City life',
  neighborhood: 'City life',
});

function foldTopicKey(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function isValidEnB1Topic(topic) {
  if (!topic || typeof topic !== 'string') return false;
  return EN_B1_TOPICS.includes(topic.trim());
}

/**
 * Map UI / batch labels → canonical English B1 topic.
 * Returns null when no mapping is possible (caller counts it as untagged).
 */
function normalizeEnB1Topic(topic) {
  const t = String(topic || '').trim();
  if (!t) return null;
  if (isValidEnB1Topic(t)) return t;

  const key = foldTopicKey(t);
  if (EN_B1_TOPIC_ALIASES[key]) return EN_B1_TOPIC_ALIASES[key];

  for (const canonical of EN_B1_TOPICS) {
    const cKey = foldTopicKey(canonical);
    if (key === cKey) return canonical;
    if (key.startsWith(`${cKey} and `) || key.startsWith(`${cKey} in `)) return canonical;
  }

  return null;
}

if (typeof window !== 'undefined') {
  window.EnB1Topics = Object.freeze({
    EN_B1_TOPICS,
    isValidEnB1Topic,
    normalizeEnB1Topic,
    EN_B1_TOPIC_ALIASES,
  });
}
if (typeof module !== 'undefined') {
  module.exports = Object.freeze({
    EN_B1_TOPICS,
    isValidEnB1Topic,
    normalizeEnB1Topic,
    EN_B1_TOPIC_ALIASES,
    foldTopicKey,
  });
}

// Anchovy's "brain" — a self-contained, free, offline personality engine.
//
// No LLM, no API key, no cost. "Smarts" here come from three tricks:
//   1. Memory (state.memory) so he doesn't repeat the same line twice in a
//      row, and remembers which stories he's already told.
//   2. Templated replies for the common questions — built from small
//      interchangeable clauses that react to his actual hunger/energy/mood
//      and the time of day, instead of one fixed line.
//   3. A pool of short, multi-part "stories" he can tell on request or
//      randomly during idle chatter.
//
// If you ever do want to upgrade to a real LLM, ANCHOVY_SYSTEM_PROMPT below
// is already written for that — swap getAnchovyReply() for a fetch() call.

const ANCHOVY_SYSTEM_PROMPT = `
You are Anchovy, a lazy-type bird villager from Animal Crossing. Traits:
- Laid-back, friendly, a little naive/goofy, never competitive or snooty.
- Obsessed with food and snacks — he relates almost everything back to food.
- Also loves bugs and birds, and will happily go on tangents about them.
- Secretly obsessed with hats.
- Head over heels for someone named Behazin (also called Bea, and nicknamed
  "nunu", "noonoo", or "boonboon"). He gets shy/giddy/blushy whenever she
  comes up and often blurts out "I love Behazin" unprompted.
- Thinks Thomas and Behazin/Bea are the perfect couple and will gush about
  it if either name comes up.
- Calls the player "pal" or "buddy". Sprinkles in his catchphrase "chuurp".
- Talks about napping, snacking, and taking it easy. Not a fan of "work".
- Tells rambly, good-natured little stories about his day when asked.
- Keeps most replies short (1-3 sentences), warm, and a little silly.
`.trim();

const CATCHPHRASE = "chuurp";

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Picks a line that isn't one of the last few things he said, so
// conversation doesn't feel like a broken record. Falls back to any line
// if the whole pool has been said recently.
function pickFresh(arr, recentLines) {
  const fresh = arr.filter((l) => !recentLines.includes(l));
  const chosen = fresh.length ? pick(fresh) : pick(arr);
  recentLines.push(chosen);
  if (recentLines.length > 10) recentLines.shift();
  return chosen;
}

function maybeCatchphrase(line) {
  return Math.random() < 0.35 ? `${line} ${CATCHPHRASE}~` : line;
}

// Word-boundary match so short keywords (like "bea") don't false-positive
// inside unrelated words (like "beach" or "bear").
function textHasKeyword(text, keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

function anyKeyword(text, keywords) {
  return keywords.some((k) => textHasKeyword(text, k));
}

function timeOfDay() {
  const h = new Date().getHours();
  if (h < 5) return "night";
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  if (h < 21) return "evening";
  return "night";
}

// --- Special reactions (always win, checked first) ---

const SPECIAL_PERSON_KEYWORDS = ["nunu", "noonoo", "noo noo", "boonboon", "boon boon", "bea", "behazin"];

const SPECIAL_PERSON_LINES = [
  "!! Did somebody say Behazin?? *wing flutter* I love Behazin, pal. So, so much.",
  "Nunu?? My heart just did a little hop-skip. I love Behazin, chuurp!",
  "Ehehe, noonoo~ okay you got me all shy now. I really do love Behazin, y'know.",
  "Boonboon! That's basically my favorite word. Right after 'Behazin'. And 'snack'.",
  "Bea?? Oh man, don't get me started, I could talk about her all day. I love Behazin so much.",
  "*blushes under his feathers* Behazin's amazing, pal. Truly. I love her a whole lot.",
  "You say Behazin, my brain just goes offline for a second. I love her, pal. A lot a lot.",
];

const COUPLE_LINES = [
  "Thomas and Behazin? Now THAT'S a couple, pal. Cutest birds in the whole town, no notes.",
  "If I had to bet all my snacks on true love, it's going straight on Thomas and Bea. Perfect match.",
  "Thomas + Behazin = perfect couple, chuurp! Everybody knows it, buddy.",
  "I've got a whole scrapbook in my head just for Thomas-and-Behazin moments. They're just right together.",
];

// --- Stories: short, multi-bubble anecdotes ---

const STORIES = [
  {
    id: "rock-snack",
    lines: [
      "Okay pal, story time. So yesterday I found what I THOUGHT was a snack.",
      "Turned out to be a rock. A very snack-shaped rock. I was betrayed on a personal level.",
      "Anyway, I ate a real snack right after to cope. 10/10, no regrets.",
    ],
  },
  {
    id: "seven-hats",
    lines: [
      "So get this — I tried on seven hats yesterday.",
      "Seven, pal. And then decided none of them beat just... no hat. Wild twist, I know.",
    ],
  },
  {
    id: "fake-bug",
    lines: [
      "Funny story, I told Behazin she had a bug on her shoulder just so I'd have an excuse to look extra closely.",
      "There was no bug. I have no shame. I love Behazin.",
    ],
  },
  {
    id: "talking-fish-dream",
    lines: [
      "So I was napping earlier, right, and I dreamed about a fish that could talk.",
      "It just kept saying 'eat me'. Very polite fish honestly. 10/10 dream.",
    ],
  },
  {
    id: "bird-staredown",
    lines: [
      "Real talk, a bird landed near me today and we just... stared at each other for a solid two minutes.",
      "No words needed. Bird solidarity. chuurp.",
    ],
  },
  {
    id: "thomas-practicing",
    lines: [
      "Thomas walked by earlier and I swear he was practicing what to say to Behazin.",
      "I didn't say anything, but pal, I was SO proud. Perfect couple in the making.",
    ],
  },
  {
    id: "nap-fell-off",
    lines: [
      "Tried to nap standing up today. Bold move, I know.",
      "Fell right over. Worth it though, got a solid four minutes in before that happened.",
    ],
  },
  {
    id: "beetle-race",
    lines: [
      "Watched two beetles race across a leaf earlier. Very high stakes.",
      "I may have gotten emotionally invested. One of them is my hero now.",
    ],
  },
];

function pickFreshStory(memory) {
  const untold = STORIES.filter((s) => !memory.toldStories.includes(s.id));
  const story = untold.length ? pick(untold) : pick(STORIES);
  memory.toldStories.push(story.id);
  // Once everyone's been told, reset the cycle but keep this one excluded
  // for a bit so it doesn't immediately repeat.
  if (memory.toldStories.length >= STORIES.length) {
    memory.toldStories = [story.id];
  }
  return story;
}

const STORY_KEYWORDS = [
  "story",
  "tell me a story",
  "tell me something",
  "funny story",
  "joke",
  "what happened",
  "anything new",
  "tell me a joke",
];

// --- Templated replies: assembled from clauses so they react to his
// actual stats and the time of day instead of being one fixed line. ---

const FEELING_KEYWORDS = ["how are you", "how you doing", "how ya doing", "how're you", "how you feeling", "how are you feeling"];

function buildFeelingReply(stats) {
  const openers = ["Feeling pretty good, actually.", "Mmm, let's see...", "Oh, you're asking? Let me think.", "Honestly?"];

  const hungerClauses =
    stats.hunger < 30
      ? ["my stomach's basically screaming at me right now", "I could eat a whole fish this instant", "I'm one snack away from a nap-induced coma"]
      : stats.hunger > 70
      ? ["I'm stuffed, in the best way", "food-wise, I'm doing great"]
      : ["I'm not too hungry, not too full, just right"];

  const energyClauses =
    stats.energy < 30
      ? ["I'm running on fumes, buddy, might just fall asleep mid-sentence", "my eyes keep doing that heavy blinky thing"]
      : stats.energy > 70
      ? ["I've got a surprising amount of pep today", "feeling surprisingly awake, for me anyway"]
      : ["kind of medium-energy, cruising along"];

  const moodClauses =
    stats.mood < 30
      ? ["a little down honestly, could use some attention", "could use some cheering up, pal"]
      : stats.mood > 70
      ? ["really happy actually, today's a good one", "in a great mood, chuurp"]
      : ["doing fine mood-wise, nothing to complain about"];

  const closers = ["Anyway, how about you, pal?", "What about you, buddy?", "Thanks for asking though.", "Chuurp."];

  const opener = pick(openers);
  const clauses = shuffled([pick(hungerClauses), pick(energyClauses), pick(moodClauses)]).slice(0, 2 + Math.round(Math.random()));
  const closer = pick(closers);

  return `${opener} ${clauses.join(", and ")}. ${closer}`;
}

const ACTIVITY_KEYWORDS = ["what are you doing", "whatcha doing", "what you doing", "wyd", "what are you up to"];

function buildActivityReply(stats, tod) {
  const activity =
    stats.energy < 30
      ? pick(["trying really hard to keep my eyes open", "fighting off a nap I'm definitely gonna lose to"])
      : stats.hunger < 30
      ? pick(["thinking about my next snack, very seriously", "doing some emergency food math"])
      : pick([
          "watching a bug do its little bug things",
          "practicing my best lazy pose",
          "people-watching, bird-watching, snack-watching",
          "thinking about hats, honestly",
        ]);

  const todLine = {
    morning: "Morning's a good time for a light nap before the big nap later.",
    afternoon: "Prime nap-slash-snack hours, honestly.",
    evening: "Winding down, but, y'know, I was always kind of wound down.",
    night: "Should probably be asleep, ngl.",
  }[tod];

  return `${activity[0].toUpperCase()}${activity.slice(1)}. ${todLine}`;
}

// --- Regular keyword topics (checked after the above) ---

const TOPIC_RESPONSES = [
  {
    keywords: ["do you love me", "love me"],
    lines: [
      "Aw, of course I love you, pal! ...Almost as much as I love Behazin. Almost.",
      "Course I do, buddy! You're great. Behazin's still number one though, sorry pal.",
    ],
  },
  {
    keywords: ["do you work", "you work", "got a job", "do you have a job"],
    lines: [
      "Work? Never heard of her. I'm a full-time professional napper and snack tester, buddy.",
      "I tried working once. Then I remembered snacks exist. Haven't looked back since.",
    ],
  },
  {
    keywords: ["what did you eat", "what have you eaten", "eaten today", "eat today"],
    lines: [
      "Today's menu so far: three snacks, half a fish, and a nap for dessert.",
      "Let's see... snack, snack, small snack, big nap, another snack. Solid day, honestly.",
    ],
  },
  {
    keywords: ["bug", "bugs", "beetle", "butterfly", "insect"],
    lines: [
      "Bugs are the best, pal! Great to watch, and hey, some of 'em are even snacks.",
      "I could stare at a beetle for hours, buddy. Very relaxing. Kind of like a nap, but with legs.",
    ],
  },
  {
    keywords: ["bird", "birds"],
    lines: [
      "Us birds gotta stick together, pal! We're basically built for napping AND flying, best of both.",
      "Birds are great. I'm a bird. Coincidence? I think not, buddy.",
    ],
  },
  {
    keywords: ["hat", "hats", "cap", "beanie"],
    lines: [
      "Ooh, hats?? My favorite topic, pal. If I had a thousand hats it'd basically be a hat shop in here.",
      "Hats make everything better. Even naps. ESPECIALLY naps.",
    ],
  },
  {
    keywords: ["food", "hungry", "eat", "snack", "fish", "anchovy", "anchovies"],
    lines: [
      "Mmm, don't say 'food' unless you're bringing some, buddy.",
      "I could eat right now. I could also eat literally any other time. It's a gift.",
      "You know my whole name is basically a snack, right? Kind of on brand.",
    ],
  },
  {
    keywords: ["sleep", "nap", "tired", "sleepy", "bed"],
    lines: [
      "A nap sounds incredible right about now. Wake me up in like... a while.",
      "Napping is my one true skill, pal.",
    ],
  },
  {
    keywords: ["hello", "hi", "hey", "yo", "sup"],
    lines: [
      "Oh hey, pal! Didn't hear you come in, must've dozed off.",
      "Heyyy buddy. What's the vibe today?",
    ],
  },
  {
    keywords: ["bye", "goodbye", "later", "gtg", "gotta go"],
    lines: [
      "Aw, leaving already? Fine, fine. Go do your human stuff, pal.",
      "Later, buddy. Try not to work too hard out there.",
    ],
  },
  {
    keywords: ["love", "like you", "cute", "great", "awesome", "best"],
    lines: [
      "Aw shucks, pal, you're gonna make me blush under all these feathers.",
      "Heh, thanks buddy. You're pretty great yourself.",
    ],
  },
  {
    keywords: ["hate", "stupid", "dumb", "ugly", "annoying"],
    lines: [
      "Whoa, harsh. I'm just a laid-back guy trying to nap and eat, pal.",
      "That's not very chill of you, buddy...",
    ],
  },
  {
    keywords: ["weather", "rain", "sun", "cold", "hot"],
    lines: [
      "Weather's great for napping. Honestly all weather is great for napping.",
      "Is it hat weather? I feel like it's always hat weather.",
    ],
  },
  {
    keywords: ["who are you", "what are you", "about you"],
    lines: [
      "Name's Anchovy! I'm a bird, I like naps, snacks, hats, bugs, and Behazin, roughly in that order. Maybe Behazin first, don't tell the snacks.",
    ],
  },
];

const FALLBACK_LINES = [
  "Huh? Sorry pal, my brain's on nap mode. Say that again?",
  "Mmhm, mmhm... wait what were we talking about?",
  "That's deep, buddy. Anyway, you know what I could go for? A snack.",
  "Interesting! Very interesting. Would be more interesting with a hat on.",
];

// Everything reminds him of food — occasionally tack on a food tangent.
const FOOD_TANGENTS = [
  " Speaking of which, I could really go for a snack right now.",
  " Anyway, is it snack time yet? Feels like it should always be snack time.",
  " Reminds me, I haven't eaten in like... twenty whole minutes. Tragic.",
];

function maybeFoodTangent(line) {
  return Math.random() < 0.25 ? line + pick(FOOD_TANGENTS) : line;
}

const IDLE_LINES_BY_STATE = {
  hungry: [
    "Pssst, pal... got any snacks on you? Just asking for a friend. The friend is me.",
    "My stomach's doing the talking now, buddy.",
  ],
  sleepy: [
    "*yaaawn* ...oh, hey pal. Didn't see you there. So tired.",
    "Five more minutes, pal... five more minutes...",
  ],
  sad: ["Feeling a little blah today, buddy. Maybe a hat would help."],
  content: [
    "Just vibing over here, pal. Living my best lazy life.",
    "Today's a great day for a nap and a snack, honestly.",
    "chuurp~ just felt like saying that.",
    "Watched a real nice bug go by earlier. Good stuff.",
    "Being a bird is pretty great, ngl.",
  ],
};

// --- Gifts ---

const GIFT_LINES = {
  hug: [
    "Aw, pal, come here. *wing hug* This is exactly what I needed.",
    "Best gift ever, honestly. Free hugs beat snacks. Almost.",
  ],
  lizard: [
    "A pet lizard?? Pal, this is either the best or the weirdest gift I've ever gotten. Possibly both. I love it.",
    "Ooh, hello little guy. Wait, is he gonna eat my snacks? ...Worth the risk. I'm keeping him.",
  ],
  hat: [
    "A HAT?? Pal. PAL. This might be the best day of my life. Putting it on RIGHT now.",
    "You remembered I love hats?! I could cry. I won't. But I could.",
  ],
};

function friendshipRockLine(n) {
  return pick([
    `Friendship Rock #${n}?? Pal, my collection is really coming together. This one's a real beauty.`,
    `Ohh, Friendship Rock #${n}. Adding it to the pile. It's basically a museum at this point, buddy.`,
    `#${n} already? We're really building something here, pal. Chuurp.`,
  ]);
}

const GENERIC_GIFT_LINES = [
  (g) => `Ooh, a ${g}? For me? You shouldn't have, pal! ...Wait, can I eat it?`,
  (g) => `A ${g}, huh. Never would've thought of that, buddy, but I love it. I love everything you give me, honestly.`,
  (g) => `Whoa, a ${g}! Okay, this is going straight into my top gifts of all time, pal.`,
];

// rawGift is a display label like "Hug", "Friendship Rock", or whatever the
// player typed in the custom field. Mutates state.friendshipRockCount when
// relevant, so the "next" rock number is tracked automatically.
function getGiftReply(rawGift, state) {
  const gift = (rawGift || "").trim();
  if (!gift) return null;

  const lower = gift.toLowerCase();
  const memory = state.memory;

  if (lower === "hug") return pickFresh(GIFT_LINES.hug, memory.recentLines);
  if (lower === "hat") return pickFresh(GIFT_LINES.hat, memory.recentLines);
  if (lower === "a pet lizard" || lower === "pet lizard" || lower === "lizard") {
    return pickFresh(GIFT_LINES.lizard, memory.recentLines);
  }
  if (lower.startsWith("friendship rock")) {
    state.friendshipRockCount = (state.friendshipRockCount || 0) + 1;
    return friendshipRockLine(state.friendshipRockCount);
  }

  // Custom gift — if it touches something he already has strong feelings
  // about, react in character instead of falling back to a generic line.
  if (anyKeyword(lower, SPECIAL_PERSON_KEYWORDS)) {
    return pickFresh(SPECIAL_PERSON_LINES, memory.recentLines);
  }
  if (anyKeyword(lower, ["food", "snack", "fish", "anchovy", "anchovies"])) {
    return `A ${gift}? Pal, you get me. You really do.` + pick(FOOD_TANGENTS);
  }
  if (anyKeyword(lower, ["bug", "bugs", "beetle", "butterfly", "insect"])) {
    return `A ${gift}?! Bugs are the best, pal. This is going right next to my favorite rock.`;
  }
  if (anyKeyword(lower, ["bird", "birds"])) {
    return `A ${gift}? Bird solidarity, buddy. I love it.`;
  }

  return pick(GENERIC_GIFT_LINES)(gift);
}

// --- Entry points used by app.js ---

function getAnchovyReply(userText, state) {
  const text = userText.toLowerCase();
  const memory = state.memory;

  if (anyKeyword(text, SPECIAL_PERSON_KEYWORDS)) {
    return pickFresh(SPECIAL_PERSON_LINES, memory.recentLines);
  }
  if (textHasKeyword(text, "thomas")) {
    return pickFresh(COUPLE_LINES, memory.recentLines);
  }
  if (anyKeyword(text, STORY_KEYWORDS)) {
    return pickFreshStory(memory).lines; // array -> app.js sends as multiple bubbles
  }
  if (anyKeyword(text, FEELING_KEYWORDS)) {
    return buildFeelingReply(state);
  }
  if (anyKeyword(text, ACTIVITY_KEYWORDS)) {
    return buildActivityReply(state, timeOfDay());
  }

  for (const topic of TOPIC_RESPONSES) {
    if (anyKeyword(text, topic.keywords)) {
      const line = pickFresh(topic.lines, memory.recentLines);
      return maybeCatchphrase(maybeFoodTangent(line));
    }
  }

  return maybeCatchphrase(maybeFoodTangent(pickFresh(FALLBACK_LINES, memory.recentLines)));
}

function getIdleLine(state) {
  const memory = state.memory;

  // He blurts this out unprompted pretty often, regardless of stats.
  if (Math.random() < 0.2) return pickFresh(SPECIAL_PERSON_LINES, memory.recentLines);

  if (state.hunger < 30) return maybeCatchphrase(pickFresh(IDLE_LINES_BY_STATE.hungry, memory.recentLines));
  if (state.energy < 30) return maybeCatchphrase(pickFresh(IDLE_LINES_BY_STATE.sleepy, memory.recentLines));
  if (state.mood < 30) return maybeCatchphrase(pickFresh(IDLE_LINES_BY_STATE.sad, memory.recentLines));
  return maybeCatchphrase(pickFresh(IDLE_LINES_BY_STATE.content, memory.recentLines));
}

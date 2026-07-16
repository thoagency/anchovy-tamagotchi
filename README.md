# Anchovy Tamagotchi

A little fan-made, offline Tamagotchi-style pet based on Anchovy, the lazy
bird villager from Animal Crossing. Runs entirely in the browser, no
backend or API key required.

## Run it

Just open `index.html` in a browser. That's it. Stats and chat history
persist in `localStorage`, so closing and reopening the page (or the tab)
picks up where you left off, decay included.

## How it works

The screen is split in two:

- **Left: your chat with Behazin (or Thomas).** A normal human-to-human chat
  thread. Type `@anchy` anywhere in a message to also pull Anchovy into the
  conversation — his reply pops up as a floating speech bubble over the
  tamagotchi on the right (see below), not in this thread.
- **Right: the tamagotchi.** Stats, avatar, Feed/Nap/Gift actions, and
  Anchovy's own speech bubble.

On first visit (per browser) you pick who you are — Thomas or Behazin — via
a full-screen prompt. That choice is what determines which side of the left
chat your own messages land on, and is stored in `localStorage`.

Files:

- `index.html` — layout: character-select overlay, chat panel, tamagotchi
  stat bars/avatar/actions.
- `style.css` — Tamagotchi-shell look, chat panel, and the floating bubble.
- `brain.js` — Anchovy's personality engine (`getAnchovyReply`,
  `getIdleLine`). Currently a local, rule-based keyword matcher — no LLM
  needed.
- `app.js` — state (hunger/energy/mood), real-time decay based on elapsed
  wall-clock time, chat panel rendering, the `@anchy` mention trigger, and
  wiring for the Feed/Nap/Gift buttons.

Stats decay for real between visits (based on `Date.now()` deltas), so if
you leave him for a few hours he'll be hungrier/sleepier/moodier when you
come back — same idea as an actual Tamagotchi.

## Smarter replies via Gemini (optional)

Click the ⚙️ button (top-right of the screen) and paste in a free
[Gemini API key](https://aistudio.google.com) (Get API key → Create API
key). The key is saved only in your browser's `localStorage` — never
written to any file — and chat replies then go through `gemini-2.5-flash`
(see `llm.js`), using `ANCHOVY_SYSTEM_PROMPT` from `brain.js` plus your
recent chat history as context, so Anchovy stays in character and
"remembers" the conversation so far.

If no key is set, or a request fails (offline, rate-limited, etc.), it
falls back to the offline keyword-based brain automatically — Gift replies
and idle chatter always stay on the offline brain, so a busy chat session
won't burn through the free tier's daily quota.

**Heads up:** this is fine for personal/local use, but the key lives in
plain browser storage — don't use this setup if the site is ever deployed
publicly, since anyone could read the key out of the page. A real shared
deployment needs a small server-side proxy to hold the key instead.

### Long-term memory

Local chat history is capped at 40 messages. As older messages fall off
that window, `app.js` batches them (10 at a time) and asks Gemini to pull
out anything worth remembering permanently (names, preferences, running
jokes) into `state.memory.notes`, which then rides along in every future
system prompt (see `buildSystemInstruction` in `llm.js`). This only runs
when a Gemini key is set — offline mode has no way to summarize.

## Shared chat with Behazin (via Supabase)

Both devices talk to the same Anchovy in real time — human chat messages
and `@anchy` replies sent from either device show up on both, live.

The Supabase project URL and publishable key are baked directly into
`sync.js` (`DEFAULT_SUPABASE_URL`/`DEFAULT_SUPABASE_KEY`) rather than entered
per-device — this is safe specifically for the *publishable* key, since it's
designed to be exposed client-side and still can't do anything the RLS
policies below don't allow. All you need on each device is to open the app
and pick Thomas or Behazin once.

Underlying table setup (already done, kept here for reference/re-creating
the project later):
```sql
create table messages (
  id uuid primary key default gen_random_uuid(),
  client_id text,
  sender text not null, -- 'thomas' | 'behazin' | 'anchovy'
  text text not null,
  created_at timestamptz not null default now()
);

alter table messages enable row level security;
create policy "Allow all reads" on messages for select using (true);
create policy "Allow all inserts" on messages for insert with check (true);

alter publication supabase_realtime add table messages;
```

Feed/Nap/Gift reactions and idle chatter stay local to each device on
purpose, so they don't clutter the shared conversation or spam the other
person's tamagotchi bubble.

**Heads up:** the RLS policies above allow anyone with the URL + publishable
key to read/write the table — acceptable for a private two-person gift
project. The **secret key** must never be pasted into the app or committed
anywhere in this repo — only the publishable key belongs here.

## About the character / art

Anchovy's personality here (lazy type, catchphrase "chuurp", food +
hat-obsessed, calls you "pal"/"buddy") is written from publicly available
facts about the character, not copied from the game's actual script.

The avatar is currently just an emoji placeholder. If you want to swap in
real game art for your own local/offline use, you can drop an image file
into this folder and swap the `<div id="avatar">` in `index.html` for an
`<img>` tag pointing at it (there's a commented-out example already in the
file). Since that art is Nintendo's IP, keep it to personal, non-public use
rather than deploying it on a live site.

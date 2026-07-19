const BASE_STORAGE_KEY = "anchovy-tamagotchi-state";

// Guest gets its own fully isolated storage bucket -- if a guest is using
// one of Thomas/Behazin's own devices (handed a phone, say), this keeps
// their session from ever loading the real chat history/memory into
// memory at all, not just hiding it in the UI.
function storageKeyFor(identity) {
  return identity === "guest" ? `${BASE_STORAGE_KEY}-guest` : BASE_STORAGE_KEY;
}

const MAX_STAT = 100;
const MIN_STAT = 0;

// Decay rates, per real-world hour.
const DECAY = { hunger: 6, energy: 4, mood: 3 };

const DEFAULT_STATE = {
  hunger: 80,
  energy: 80,
  mood: 80,
  lastUpdate: Date.now(),
  chatHistory: [],
  memory: { recentLines: [], toldStories: [], notes: [], pendingSummary: [] },
  friendshipRockCount: 0,
  giftCounts: { lizard: 0, hat: 0 },
};

const CHAT_HISTORY_CAP = 40;
const MEMORY_SUMMARY_BATCH = 10;
const MEMORY_NOTES_CAP = 30;
const MENTION_RE = /@anchy\b/i;

const GIFT_LABELS = { hug: "Hug", lizard: "A pet lizard", hat: "Hat", rock: "Friendship Rock" };
const GIFT_MOOD_BOOST = { hug: 15, lizard: 10, hat: 25, rock: 12, custom: 15 };

// Which Anchovy speech-bubble style is active. Both styles are always kept
// up to date in the DOM regardless of this flag -- it only controls which
// one CSS shows (body.bubble-v2) -- so flipping this is the entire toggle,
// no other code changes needed.
const BUBBLE_STYLE_V2 = true;

let state = loadState();

const el = {
  hunger: document.getElementById("bar-hunger"),
  energy: document.getElementById("bar-energy"),
  mood: document.getElementById("bar-mood"),
  avatar: document.getElementById("avatar"),
  anchovyBubbles: document.getElementById("anchovy-bubbles"),
  gameboxRoot: document.getElementById("anchovy-gamebox"),
  gameboxText: document.getElementById("gamebox-text"),
  gameboxTime: document.getElementById("gamebox-time"),
  gameboxPointer: document.getElementById("gamebox-pointer"),
  gameboxPointerUp: document.getElementById("gamebox-pointer-up"),
  chatlog: document.getElementById("chatlog"),
  chatForm: document.getElementById("chat-form"),
  chatInput: document.getElementById("chat-input"),
  btnFeed: document.getElementById("btn-feed"),
  btnNap: document.getElementById("btn-nap"),
  giftBtn: document.getElementById("gift-btn"),
  giftMenu: document.getElementById("gift-menu"),
  giftList: document.querySelector("#gift-menu .gift-list"),
  giftRockLabel: document.getElementById("gift-rock-label"),
  giftCustomForm: document.getElementById("gift-custom-form"),
  giftCustom: document.getElementById("gift-custom"),
  pocketBtn: document.getElementById("pocket-btn"),
  pocketMenu: document.getElementById("pocket-menu"),
  pocketClose: document.getElementById("pocket-close"),
  pocketCountRock: document.getElementById("pocket-count-rock"),
  pocketCountPet: document.getElementById("pocket-count-pet"),
  pocketCountHat: document.getElementById("pocket-count-hat"),
  settingsBtn: document.getElementById("settings-btn"),
  settingsMenu: document.getElementById("settings-menu"),
  settingsKeyInput: document.getElementById("gemini-key-input"),
  settingsStatus: document.getElementById("settings-status"),
  settingsSave: document.getElementById("settings-save"),
  settingsClear: document.getElementById("settings-clear"),
  identityStatus: document.getElementById("identity-status"),
  identitySwitch: document.getElementById("identity-switch"),
  charScreen: document.getElementById("char-screen"),
  charPicker: document.getElementById("char-picker"),
  charThomas: document.getElementById("char-thomas"),
  charBehazin: document.getElementById("char-behazin"),
  charGuest: document.getElementById("char-guest"),
  charPinForm: document.getElementById("char-pin-form"),
  charPinTitle: document.getElementById("char-pin-title"),
  charPinInput: document.getElementById("char-pin-input"),
  charPinError: document.getElementById("char-pin-error"),
  charPinCancel: document.getElementById("char-pin-cancel"),
  nookphoneSettingsApp: document.querySelector('.nookphone-app[data-app="settings"]'),
};

document.body.classList.toggle("bubble-v2", BUBBLE_STYLE_V2);

// Client-generated ids for messages this device has already rendered, so
// this device's own inserts don't get rendered a second time when they
// echo back through the realtime subscription.
const sentClientIds = new Set();

// Row ids already rendered, so a row delivered twice (once by the realtime
// subscription, once by the polling backstop) only shows up once.
const seenRowIds = new Set();

const BUBBLE_LIMIT = 4;
const BUBBLE_TRANSITION_MS = 350;

function loadState() {
  try {
    const raw = localStorage.getItem(storageKeyFor(getIdentity()));
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_STATE,
      ...parsed,
      memory: { ...DEFAULT_STATE.memory, ...(parsed.memory || {}) },
      giftCounts: { ...DEFAULT_STATE.giftCounts, ...(parsed.giftCounts || {}) },
    };
  } catch (e) {
    return { ...DEFAULT_STATE };
  }
}

function saveState() {
  localStorage.setItem(storageKeyFor(getIdentity()), JSON.stringify(state));
}

function clamp(n) {
  return Math.max(MIN_STAT, Math.min(MAX_STAT, n));
}

function applyDecay() {
  const now = Date.now();
  const hoursPassed = (now - state.lastUpdate) / (1000 * 60 * 60);
  if (hoursPassed <= 0) return false;

  state.hunger = clamp(state.hunger - DECAY.hunger * hoursPassed);
  state.energy = clamp(state.energy - DECAY.energy * hoursPassed);
  // Mood drifts down on its own, and faster if he's hungry or tired.
  const moodPenalty =
    DECAY.mood * hoursPassed +
    (state.hunger < 30 ? hoursPassed * 4 : 0) +
    (state.energy < 30 ? hoursPassed * 3 : 0);
  state.mood = clamp(state.mood - moodPenalty);

  state.lastUpdate = now;
  return hoursPassed > 0.02; // meaningful time away (~1+ min)
}

function render() {
  el.hunger.style.width = `${state.hunger}%`;
  el.energy.style.width = `${state.energy}%`;
  el.mood.style.width = `${state.mood}%`;
}

function bounceAvatar() {
  el.avatar.classList.remove("bounce");
  void el.avatar.offsetWidth; // restart animation
  el.avatar.classList.add("bounce");
}

// opts.skipSync: true for local-only flavor text (feed/nap/gift/idle) that
// shouldn't show up on the other person's device. opts.fromRemote: true
// when hydrating a message that arrived via realtime (already in Supabase,
// so must not be pushed back up). opts.ts: use this device's own send time
// only when it doesn't matter; for anything remote, pass the message's
// actual `created_at` so the shown time doesn't depend on when this device
// happened to receive it (which drifts with poll timing / tab throttling
// and would otherwise disagree with what a refresh recomputes from Supabase).
function addMessage(who, text, opts = {}) {
  // isReply marks a genuine reaction to something said in chat (routed
  // through Supabase, i.e. not skipSync) as opposed to flavor text from
  // feed/nap/gift/idle chatter -- only the former gets a timestamp bubble.
  const msg = { who, text, ts: opts.ts || Date.now(), isReply: who === "anchovy" && !opts.skipSync };
  state.chatHistory.push(msg);
  if (state.chatHistory.length > CHAT_HISTORY_CAP) {
    const dropped = state.chatHistory.shift();
    state.memory.pendingSummary.push(dropped);
    if (state.memory.pendingSummary.length >= MEMORY_SUMMARY_BATCH) {
      const batch = state.memory.pendingSummary;
      state.memory.pendingSummary = [];
      summarizeForMemory(batch).then((note) => {
        if (!note) return;
        state.memory.notes.push(note);
        if (state.memory.notes.length > MEMORY_NOTES_CAP) state.memory.notes.shift();
        saveState();
      });
    }
  }
  renderMessage(msg);
  saveState();

  if (!opts.fromRemote && !opts.skipSync && isSyncConfigured()) {
    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sentClientIds.add(clientId);
    pushSharedMessage(who, text, clientId).then(({ row, error }) => {
      if (error) {
        showSyncError(`Send failed: ${error.message || error}`);
        return;
      }
      // Reconcile this message's timestamp with the server's authoritative
      // created_at now, instead of leaving this device's own Date.now()
      // guess in place until the next refresh recomputes it from Supabase
      // -- that gap (network latency, clock drift) is what made timestamps
      // appear to jump after a reload.
      if (row && row.created_at) {
        const oldTs = msg.ts;
        msg.ts = new Date(row.created_at).getTime();
        if (latestHumanMsgEl && Number(latestHumanMsgEl.dataset.ts) === oldTs) {
          latestHumanMsgEl.dataset.ts = msg.ts;
        }
        saveState();
      }
    });
  }
}

function showSyncError(message) {
  el.identityStatus.textContent = message;
  el.identityStatus.style.color = "#c0392b";
}

// Anchovy's lines stack up above the tamagotchi (never over the avatar
// itself) instead of sitting in a permanent log -- everything else (Thomas'
// and Behazin's own messages to each other) lives in the left chat panel.
// Keeps the last BUBBLE_LIMIT; older ones fade out as new ones arrive.
function showAnchovyBubble(text, ts, isReply) {
  const bubble = document.createElement("div");
  bubble.className = "anchovy-bubble";
  bubble.appendChild(document.createTextNode(text));
  if (isReply) {
    const time = document.createElement("span");
    time.className = "msg-time";
    time.textContent = formatTimestamp(ts);
    bubble.appendChild(time);
  }
  el.anchovyBubbles.appendChild(bubble);
  requestAnimationFrame(() => bubble.classList.add("visible"));

  // removeBubble() doesn't pull the node out of the DOM immediately (it
  // waits for the fade-out transition), so take a snapshot of who's excess
  // up front rather than re-checking the live child count in a loop --
  // otherwise the count never drops and this spins forever.
  const bubbles = Array.from(el.anchovyBubbles.children);
  const excess = bubbles.length - BUBBLE_LIMIT;
  for (let i = 0; i < excess; i++) {
    removeBubble(bubbles[i]);
  }

  updateGamebox(text, ts);
}

function removeBubble(bubble) {
  bubble.classList.remove("visible");
  bubble.classList.add("leaving");
  bubble.addEventListener("transitionend", () => bubble.remove(), { once: true });
  setTimeout(() => bubble.remove(), BUBBLE_TRANSITION_MS + 100); // fallback
}

function formatTimestamp(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// --- Version 2 dialogue box: shows one message at a time, always with a
// timestamp. The pointer at the bottom steps backward through recent
// messages ("checking recent messages") -- a fresh message always jumps
// the view back to "latest" first.
const GAMEBOX_HISTORY_LIMIT = 20;
const gameboxHistory = [];
let gameboxIndex = -1;

function renderGamebox() {
  if (gameboxIndex < 0 || !gameboxHistory.length) return;
  const msg = gameboxHistory[gameboxIndex];
  el.gameboxText.textContent = msg.text;
  el.gameboxTime.textContent = formatTimestamp(msg.ts);
  // Up-pointer only makes sense if there's something newer to jump to.
  el.gameboxPointerUp.hidden = gameboxIndex >= gameboxHistory.length - 1;
  // Retrigger the pop-in animation even if the box is already showing.
  el.gameboxRoot.classList.remove("pop");
  void el.gameboxRoot.offsetWidth;
  el.gameboxRoot.classList.add("pop");
}

function updateGamebox(text, ts) {
  gameboxHistory.push({ text, ts });
  if (gameboxHistory.length > GAMEBOX_HISTORY_LIMIT) gameboxHistory.shift();
  gameboxIndex = gameboxHistory.length - 1;
  renderGamebox();
}

el.gameboxPointer.addEventListener("click", () => {
  if (gameboxIndex <= 0) return;
  gameboxIndex--;
  renderGamebox();
});

el.gameboxPointerUp.addEventListener("click", () => {
  if (gameboxIndex >= gameboxHistory.length - 1) return;
  gameboxIndex++;
  renderGamebox();
});

// The bubble for whichever human message is currently newest -- shows
// "Just now" until another human message arrives, at which point it gets
// demoted to a real clock time and the new message takes over as "Just now".
let latestHumanMsgEl = null;

function renderHumanMessage(msg, isLatest) {
  const div = document.createElement("div");
  const mine = msg.who === getIdentity();
  div.className = `msg ${mine ? "mine" : "theirs"}`;
  if (!mine) {
    const label = document.createElement("span");
    label.className = "msg-name";
    label.textContent = msg.who === "thomas" ? "Thomas" : "Behazin";
    div.appendChild(label);
  }
  div.appendChild(document.createTextNode(msg.text));

  const time = document.createElement("span");
  time.className = "msg-time";
  time.textContent = isLatest ? "Just now" : formatTimestamp(msg.ts);
  div.appendChild(time);

  el.chatlog.appendChild(div);
  el.chatlog.scrollTop = el.chatlog.scrollHeight;
  return div;
}

function renderMessage(msg) {
  if (msg.who === "anchovy") {
    showAnchovyBubble(msg.text, msg.ts, msg.isReply);
    return;
  }
  if (latestHumanMsgEl) {
    latestHumanMsgEl.querySelector(".msg-time").textContent = formatTimestamp(
      Number(latestHumanMsgEl.dataset.ts)
    );
  }
  latestHumanMsgEl = renderHumanMessage(msg, true);
  latestHumanMsgEl.dataset.ts = msg.ts;
}

function renderChatHistory() {
  el.chatlog.innerHTML = "";
  latestHumanMsgEl = null;
  const humanMsgs = state.chatHistory.filter((msg) => msg.who !== "anchovy");
  humanMsgs.forEach((msg, i) => {
    const isLatest = i === humanMsgs.length - 1;
    const div = renderHumanMessage(msg, isLatest);
    if (isLatest) {
      latestHumanMsgEl = div;
      latestHumanMsgEl.dataset.ts = msg.ts;
    }
  });
}

function anchovySay(text, opts) {
  addMessage("anchovy", text, opts);
  bounceAvatar();
}

// Sends an array of lines as separate chat bubbles, staggered, so
// multi-part stories read like he's actually telling them.
function saySequence(lines, i = 0, opts) {
  if (i >= lines.length) return;
  anchovySay(lines[i], opts);
  if (i < lines.length - 1) {
    setTimeout(() => saySequence(lines, i + 1, opts), 900 + Math.random() * 600);
  }
}

function sayReply(reply, opts) {
  if (Array.isArray(reply)) {
    saySequence(reply, 0, opts);
  } else {
    anchovySay(reply, opts);
  }
}

// Always says something on load -- a stat-aware idle line if you were
// genuinely away for a while, otherwise a nickname greeting, so the
// bubble/gamebox is never just empty when you open the app. A short
// delay so it doesn't fire before the screen has visually settled.
function handleWelcomeBack(wasAway) {
  const line = wasAway ? getIdleLine(state) : getWelcomeLine(getIdentity());
  setTimeout(() => anchovySay(line, { skipSync: true }), 500);
}

// --- Character select ---

function showCharScreen() {
  cancelPinPrompt();
  el.charScreen.classList.remove("hidden");
}

function hideCharScreen() {
  el.charScreen.classList.add("hidden");
}

// Wipes everything on screen that came from whoever was previously signed
// in on this device -- Anchovy's own lines aren't secret, but they can
// reference the person he was just talking to, so a guest picking up the
// device mid-session shouldn't see the tail end of a Thomas/Behazin
// conversation for even a moment.
function resetConversationUI() {
  latestHumanMsgEl = null;
  el.chatlog.innerHTML = "";
  el.anchovyBubbles.innerHTML = "";
  gameboxHistory.length = 0;
  gameboxIndex = -1;
  el.gameboxText.textContent = "";
  el.gameboxTime.textContent = "";
  el.gameboxPointerUp.hidden = true;
}

// Guests never touch the shared Thomas<->Behazin thread or Gemini
// settings -- they can still feed/nap/gift/chat with Anchovy directly
// (that chat stays local to their own device, see the skipSync: isGuest
// checks below), and the shared pet stats still sync for them too, since
// it's the same Anchovy either way.
function isGuest() {
  return getIdentity() === "guest";
}

function applyGuestRestrictions() {
  const guest = isGuest();
  el.nookphoneSettingsApp.classList.toggle("nookphone-app--disabled", guest);
}

async function startSessionSync(wasAway) {
  if (isGuest()) {
    await initPetSync();
    handleWelcomeBack(wasAway);
    return;
  }
  renderChatHistory();
  await initSharedSync();
  await initPetSync();
  handleWelcomeBack(wasAway);
}

function chooseIdentity(name) {
  setIdentity(name);
  state = loadState(); // identity-scoped storage -- fresh bucket per person
  resetConversationUI();
  hideCharScreen();
  updateIdentityStatus();
  applyGuestRestrictions();
  applyDecay();
  render();
  updateRockOption();
  // startSessionSync -> handleWelcomeBack handles the greeting bubble
  // (also covers guest and ordinary reloads, not just a fresh pick).
  startSessionSync(false);
}

el.charThomas.addEventListener("click", () => promptForPin("thomas"));
el.charBehazin.addEventListener("click", () => promptForPin("behazin"));
el.charGuest.addEventListener("click", () => chooseIdentity("guest"));

let pendingPinName = null;

function promptForPin(name) {
  pendingPinName = name;
  el.charPinTitle.textContent = `${name === "thomas" ? "Thomas'" : "Behazin's"} PIN`;
  el.charPinError.textContent = "";
  el.charPinInput.value = "";
  el.charPicker.classList.add("hidden");
  el.charPinForm.classList.remove("hidden");
  el.charPinInput.focus();
}

function cancelPinPrompt() {
  pendingPinName = null;
  el.charPinForm.classList.add("hidden");
  el.charPicker.classList.remove("hidden");
}

el.charPinCancel.addEventListener("click", cancelPinPrompt);

el.charPinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (checkIdentityPin(pendingPinName, el.charPinInput.value.trim())) {
    const name = pendingPinName;
    cancelPinPrompt();
    chooseIdentity(name);
  } else {
    el.charPinError.textContent = "Wrong PIN, try again.";
    el.charPinInput.value = "";
    el.charPinInput.focus();
  }
});

el.identitySwitch.addEventListener("click", () => {
  setIdentity("");
  updateIdentityStatus();
  closeSettingsMenu();
  resetConversationUI();
  // Stop the outgoing identity's realtime subscription/polling right now
  // instead of leaving them dangling until the next identity's sync
  // happens to replace them -- that gap was the "stuck on old messages"
  // bug, since a resubscribe can race and silently end up not receiving
  // live updates until a full page reload forces a clean reconnect.
  resetSupabaseClient();
  petStateSynced = false;
  showCharScreen();
});

// --- Shared sync (Supabase) ---

function hydrateChatHistory(rows) {
  state.chatHistory = rows.slice(-CHAT_HISTORY_CAP).map((r) => ({
    who: r.sender,
    text: r.text,
    ts: new Date(r.created_at).getTime(),
  }));
  rows.forEach((r) => { if (r.id) seenRowIds.add(r.id); });
  renderChatHistory();
  saveState();
}

function handleRemoteInsert(row) {
  if (row.id) {
    if (seenRowIds.has(row.id)) return; // already rendered (realtime + poll overlap)
    seenRowIds.add(row.id);
  }
  if (row.client_id && sentClientIds.has(row.client_id)) return; // our own echo
  addMessage(row.sender, row.text, { fromRemote: true, ts: new Date(row.created_at).getTime() });
  if (row.sender === "anchovy") bounceAvatar();
}

async function initSharedSync() {
  const { rows, error } = await fetchSharedHistory(CHAT_HISTORY_CAP);
  if (error) {
    showSyncError(`Connection failed: ${error.message || error}`);
    return;
  }
  if (rows.length) {
    hydrateChatHistory(rows);
    markPolledUpTo(rows[rows.length - 1].created_at);
  }
  subscribeToSharedMessages(handleRemoteInsert);
  startMessagePolling(handleRemoteInsert);
}

// --- Shared pet stats: one Anchovy, so hunger/energy/mood sync across
// every device (Thomas, Behazin, and Guest all feed the same bird) even
// though the chat thread above stays private to Thomas/Behazin. Degrades
// to today's fully-local stats automatically if the pet_state table
// hasn't been created yet (see sync.js header for the SQL) or sync isn't
// configured at all.
let petStateSynced = false;
let petStateHasPocketColumns = false;

async function initPetSync() {
  if (!isSyncConfigured()) return;
  const { row, error } = await fetchPetState();
  if (error || !row) return; // table missing, or offline -- stay local-only
  petStateSynced = true;
  petStateHasPocketColumns = "rock_count" in row;
  applyRemotePetState(row);
  subscribeToPetState(applyRemotePetState);
}

function applyRemotePetState(row) {
  const remoteUpdated = new Date(row.updated_at).getTime();
  // Ignore a remote row that's older than what this device already has --
  // otherwise a slow fetch response arriving after a local action could
  // stomp the fresher value right back down.
  if (remoteUpdated < state.lastUpdate) return;
  state.hunger = row.hunger;
  state.energy = row.energy;
  state.mood = row.mood;
  // Pocket totals (rock/pet/hat counts) are a newer addition to pet_state
  // -- these keys are simply absent from the row on a device that hasn't
  // run the migration yet, so only apply them when present.
  if (row.rock_count != null) state.friendshipRockCount = row.rock_count;
  if (row.pet_count != null) state.giftCounts.lizard = row.pet_count;
  if (row.hat_count != null) state.giftCounts.hat = row.hat_count;
  state.lastUpdate = remoteUpdated;
  saveState();
  render();
  updateRockOption();
  updatePocketCounts();
}

// Called right after any action that changes the stats locally (feed/nap/
// gift). Decay itself isn't pushed on every tick from every open device --
// only real actions write, which is enough for the other side to see it
// live and keeps this from turning into a write storm.
function pushPetStateIfSynced() {
  if (!petStateSynced) return;
  const fields = { hunger: state.hunger, energy: state.energy, mood: state.mood };
  // Only include the pocket-total columns once we've confirmed (via the
  // initial fetch) that this project's pet_state table actually has them
  // -- sending an unknown column would make the whole update fail,
  // breaking hunger/energy/mood sync too on a not-yet-migrated table.
  if (petStateHasPocketColumns) {
    fields.rock_count = state.friendshipRockCount || 0;
    fields.pet_count = (state.giftCounts && state.giftCounts.lizard) || 0;
    fields.hat_count = (state.giftCounts && state.giftCounts.hat) || 0;
  }
  pushPetState(fields);
}

// --- Actions ---

el.btnFeed.addEventListener("click", () => {
  state.hunger = clamp(state.hunger + 25);
  state.mood = clamp(state.mood + 5);
  saveState();
  render();
  pushPetStateIfSynced();
  anchovySay(
    pick([
      "Ahh yeah, that hit the spot, pal. chuurp~",
      "Mmm, snack time is the best time. Thanks buddy!",
    ]),
    { skipSync: true }
  );
});

el.btnNap.addEventListener("click", () => {
  state.energy = clamp(state.energy + 30);
  state.mood = clamp(state.mood + 3);
  saveState();
  render();
  pushPetStateIfSynced();
  anchovySay(
    pick([
      "That was a great nap, buddy. Feel like a new bird.",
      "Zzz... huh? Oh, all rested now. Thanks pal.",
    ]),
    { skipSync: true }
  );
});

function updateRockOption() {
  const next = (state.friendshipRockCount || 0) + 1;
  el.giftRockLabel.textContent = `Friendship Rock #${next}`;
}

// --- Pocket popup: totals of everything he's been given ---

function updatePocketCounts() {
  el.pocketCountRock.textContent = state.friendshipRockCount || 0;
  el.pocketCountPet.textContent = (state.giftCounts && state.giftCounts.lizard) || 0;
  el.pocketCountHat.textContent = (state.giftCounts && state.giftCounts.hat) || 0;
}

function openPocketMenu() {
  updatePocketCounts();
  el.pocketMenu.classList.remove("hidden");
}

function closePocketMenu() {
  el.pocketMenu.classList.add("hidden");
}

el.pocketBtn.addEventListener("click", () => openPocketMenu());
el.pocketClose.addEventListener("click", () => closePocketMenu());
el.pocketMenu.addEventListener("click", (e) => {
  if (e.target === el.pocketMenu) closePocketMenu();
});

function openGiftMenu() {
  el.giftMenu.classList.remove("hidden");
}

function closeGiftMenu() {
  el.giftMenu.classList.add("hidden");
}

function giveGift(kind, giftLabel) {
  const reply = getGiftReply(giftLabel, state);
  if (!reply) return;

  state.mood = clamp(state.mood + (GIFT_MOOD_BOOST[kind] ?? 12));
  if (kind === "lizard") state.giftCounts.lizard = (state.giftCounts.lizard || 0) + 1;
  if (kind === "hat") state.giftCounts.hat = (state.giftCounts.hat || 0) + 1;
  saveState();
  render();
  pushPetStateIfSynced();
  updateRockOption();
  closeGiftMenu();

  anchovySay(reply, { skipSync: true });
}

el.giftBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  el.giftMenu.classList.toggle("hidden");
});

el.giftList.addEventListener("click", (e) => {
  const item = e.target.closest("li[data-gift]");
  if (!item) return;
  const kind = item.dataset.gift;
  giveGift(kind, GIFT_LABELS[kind]);
});

el.giftCustomForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = el.giftCustom.value.trim();
  if (!text) return;
  giveGift("custom", text);
  el.giftCustom.value = "";
});

document.addEventListener("click", (e) => {
  if (!el.giftMenu.classList.contains("hidden") && !e.target.closest(".gift-wrap")) {
    closeGiftMenu();
  }
  if (!el.settingsMenu.classList.contains("hidden") && !e.target.closest(".settings-wrap")) {
    closeSettingsMenu();
  }
});

// --- AI settings (optional Gemini upgrade) ---

function updateSettingsStatus(override) {
  if (override) {
    el.settingsStatus.textContent = override;
    return;
  }
  el.settingsStatus.textContent = getGeminiKey()
    ? "Smarter replies on (using Gemini)."
    : "Offline mode (no key set).";
}

// --- NookPhone home screen / app switching ---

const nookphoneScreens = {
  home: document.getElementById("nookphone-home"),
  settings: document.getElementById("nookphone-settings"),
  switch: document.getElementById("nookphone-switch"),
};

function showNookphoneScreen(name) {
  Object.values(nookphoneScreens).forEach((screen) => screen.classList.add("hidden"));
  nookphoneScreens[name].classList.remove("hidden");
}

document.querySelectorAll(".nookphone-app[data-app]").forEach((app) => {
  app.addEventListener("click", (e) => {
    const target = app.dataset.app;
    if (target === "settings" && isGuest()) {
      e.preventDefault();
      return; // guests can't touch Gemini/API settings
    }
    // Pocket and K.K. Slider aren't sub-screens of the phone -- Pocket
    // reuses the same popup as the yellow action button, and K.K. Slider
    // is a real link (browser handles it, nothing to wire up here).
    if (target === "pocket") {
      closeSettingsMenu();
      openPocketMenu();
      return;
    }
    if (target === "kk") return;
    e.preventDefault();
    showNookphoneScreen(target);
  });
});

document.querySelectorAll(".nookphone-back").forEach((btn) => {
  btn.addEventListener("click", () => showNookphoneScreen("home"));
});

function openSettingsMenu() {
  el.settingsKeyInput.value = getGeminiKey();
  el.settingsMenu.classList.remove("hidden");
}

function closeSettingsMenu() {
  el.settingsMenu.classList.add("hidden");
  showNookphoneScreen("home");
}

el.settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (el.settingsMenu.classList.contains("hidden")) {
    openSettingsMenu();
  } else {
    closeSettingsMenu();
  }
});

el.settingsSave.addEventListener("click", async () => {
  setGeminiKey(el.settingsKeyInput.value.trim());
  if (!getGeminiKey()) {
    updateSettingsStatus();
    closeSettingsMenu();
    return;
  }
  updateSettingsStatus("Testing key...");
  const result = await testGeminiConnection();
  updateSettingsStatus(
    result.ok ? "Smarter replies on (Gemini connected)." : `Gemini error: ${result.message} — using offline brain for now.`
  );
});

el.settingsClear.addEventListener("click", () => {
  setGeminiKey("");
  el.settingsKeyInput.value = "";
  updateSettingsStatus();
});

function updateIdentityStatus() {
  el.identityStatus.style.color = "";
  const name = getIdentity();
  el.identityStatus.textContent =
    name === "thomas" ? "Thomas" : name === "behazin" ? "Behazin" : name === "guest" ? "Guest" : "Not chosen yet.";
}

// --- Left chat panel: Thomas <-> Behazin, with @anchy pulling Anchovy in ---

el.chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = el.chatInput.value.trim();
  if (!text) return;
  // Guests get a real conversation with Anchovy, but it never touches the
  // shared messages table -- it stays local to their own device, same as
  // feed/nap/gift flavor text already does.
  const guestChat = isGuest();
  addMessage(getIdentity(), text, guestChat ? { skipSync: true } : undefined);
  el.chatInput.value = "";

  state.mood = clamp(state.mood + 2);
  saveState();
  render();
  pushPetStateIfSynced();

  if (MENTION_RE.test(text)) {
    const asked = text.replace(MENTION_RE, "").trim() || "Hey Anchovy!";
    setTimeout(async () => {
      let reply = null;
      try {
        reply = await getGeminiReply(asked, state);
      } catch (err) {
        console.warn("Gemini reply failed, falling back to offline brain:", err);
        // Surface this in the settings panel (even if closed right now) so
        // it's visible next time it's opened, instead of silently looking
        // like Gemini just isn't adding anything.
        updateSettingsStatus(`Gemini error: ${err.message || err} — using offline brain for now.`);
      }
      if (!reply) {
        reply = getAnchovyReply(asked, state);
      }
      saveState(); // memory (recent lines / told stories) was updated
      sayReply(reply, guestChat ? { skipSync: true } : undefined);
    }, 400 + Math.random() * 400);
  }
});

// --- Idle chatter, so he talks even if you just leave the tab open ---

setInterval(() => {
  applyDecay();
  render();
  if (Math.random() < 0.3) {
    if (Math.random() < 0.2) {
      saySequence(pickFreshStory(state.memory).lines, 0, { skipSync: true });
    } else {
      anchovySay(getIdleLine(state), { skipSync: true });
    }
  }
  saveState();
}, 60 * 1000);

// --- Init ---

(async function init() {
  const wasAway = applyDecay();
  render();
  updateRockOption();
  updateSettingsStatus();
  updateIdentityStatus();
  applyGuestRestrictions();
  saveState();

  if (getIdentity()) {
    hideCharScreen();
    await startSessionSync(wasAway);
  } else {
    showCharScreen();
  }
})();

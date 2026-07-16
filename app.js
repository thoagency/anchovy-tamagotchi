const STORAGE_KEY = "anchovy-tamagotchi-state";
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
};

const CHAT_HISTORY_CAP = 40;
const MEMORY_SUMMARY_BATCH = 10;
const MEMORY_NOTES_CAP = 30;
const MENTION_RE = /@anchy\b/i;

const GIFT_LABELS = { hug: "Hug", lizard: "A pet lizard", hat: "Hat", rock: "Friendship Rock" };
const GIFT_MOOD_BOOST = { hug: 15, lizard: 10, hat: 25, rock: 12, custom: 15 };

let state = loadState();

const el = {
  hunger: document.getElementById("bar-hunger"),
  energy: document.getElementById("bar-energy"),
  mood: document.getElementById("bar-mood"),
  avatar: document.getElementById("avatar"),
  anchovyBubbles: document.getElementById("anchovy-bubbles"),
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
  settingsBtn: document.getElementById("settings-btn"),
  settingsMenu: document.getElementById("settings-menu"),
  settingsKeyInput: document.getElementById("gemini-key-input"),
  settingsStatus: document.getElementById("settings-status"),
  settingsSave: document.getElementById("settings-save"),
  settingsClear: document.getElementById("settings-clear"),
  identityStatus: document.getElementById("identity-status"),
  identitySwitch: document.getElementById("identity-switch"),
  charScreen: document.getElementById("char-screen"),
  charThomas: document.getElementById("char-thomas"),
  charBehazin: document.getElementById("char-behazin"),
};

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
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_STATE,
      ...parsed,
      memory: { ...DEFAULT_STATE.memory, ...(parsed.memory || {}) },
    };
  } catch (e) {
    return { ...DEFAULT_STATE };
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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

function barColor(value) {
  if (value > 60) return "#6bbf59";
  if (value > 30) return "#e9a24a";
  return "#d1573f";
}

function render() {
  el.hunger.style.width = `${state.hunger}%`;
  el.energy.style.width = `${state.energy}%`;
  el.mood.style.width = `${state.mood}%`;
  el.hunger.style.background = barColor(state.hunger);
  el.energy.style.background = barColor(state.energy);
  el.mood.style.background = barColor(state.mood);
}

function bounceAvatar() {
  el.avatar.classList.remove("bounce");
  void el.avatar.offsetWidth; // restart animation
  el.avatar.classList.add("bounce");
}

// opts.skipSync: true for local-only flavor text (feed/nap/gift/idle) that
// shouldn't show up on the other person's device. opts.fromRemote: true
// when hydrating a message that arrived via realtime (already in Supabase,
// so must not be pushed back up).
function addMessage(who, text, opts = {}) {
  const msg = { who, text, ts: Date.now() };
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
    pushSharedMessage(who, text, clientId).then(({ error }) => {
      if (error) showSyncError(`Send failed: ${error.message || error}`);
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
function showAnchovyBubble(text) {
  const bubble = document.createElement("div");
  bubble.className = "anchovy-bubble";
  bubble.textContent = text;
  el.anchovyBubbles.appendChild(bubble);
  requestAnimationFrame(() => bubble.classList.add("visible"));

  while (el.anchovyBubbles.children.length > BUBBLE_LIMIT) {
    removeBubble(el.anchovyBubbles.children[0]);
  }
}

function removeBubble(bubble) {
  bubble.classList.remove("visible");
  bubble.classList.add("leaving");
  bubble.addEventListener("transitionend", () => bubble.remove(), { once: true });
  setTimeout(() => bubble.remove(), BUBBLE_TRANSITION_MS + 100); // fallback
}

function renderHumanMessage(msg) {
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
  el.chatlog.appendChild(div);
  el.chatlog.scrollTop = el.chatlog.scrollHeight;
}

function renderMessage(msg) {
  if (msg.who === "anchovy") {
    showAnchovyBubble(msg.text);
  } else {
    renderHumanMessage(msg);
  }
}

function renderChatHistory() {
  el.chatlog.innerHTML = "";
  state.chatHistory.forEach((msg) => {
    if (msg.who !== "anchovy") renderHumanMessage(msg);
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

function handleWelcomeBack(wasAway) {
  if (!wasAway) return;
  anchovySay(getIdleLine(state), { skipSync: true });
}

// --- Character select ---

function showCharScreen() {
  el.charScreen.classList.remove("hidden");
}

function hideCharScreen() {
  el.charScreen.classList.add("hidden");
}

function chooseIdentity(name) {
  setIdentity(name);
  hideCharScreen();
  updateIdentityStatus();
  renderChatHistory();
  initSharedSync().then(() => handleWelcomeBack(false));
}

el.charThomas.addEventListener("click", () => chooseIdentity("thomas"));
el.charBehazin.addEventListener("click", () => chooseIdentity("behazin"));

el.identitySwitch.addEventListener("click", () => {
  setIdentity("");
  updateIdentityStatus();
  closeSettingsMenu();
  el.chatlog.innerHTML = "";
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
  addMessage(row.sender, row.text, { fromRemote: true });
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

// --- Actions ---

el.btnFeed.addEventListener("click", () => {
  state.hunger = clamp(state.hunger + 25);
  state.mood = clamp(state.mood + 5);
  saveState();
  render();
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
  saveState();
  render();
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

function updateSettingsStatus() {
  el.settingsStatus.textContent = getGeminiKey()
    ? "Smarter replies on (using Gemini)."
    : "Offline mode (no key set).";
}

function openSettingsMenu() {
  el.settingsKeyInput.value = getGeminiKey();
  el.settingsMenu.classList.remove("hidden");
}

function closeSettingsMenu() {
  el.settingsMenu.classList.add("hidden");
}

el.settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (el.settingsMenu.classList.contains("hidden")) {
    openSettingsMenu();
  } else {
    closeSettingsMenu();
  }
});

el.settingsSave.addEventListener("click", () => {
  setGeminiKey(el.settingsKeyInput.value.trim());
  updateSettingsStatus();
  closeSettingsMenu();
});

el.settingsClear.addEventListener("click", () => {
  setGeminiKey("");
  el.settingsKeyInput.value = "";
  updateSettingsStatus();
});

function updateIdentityStatus() {
  el.identityStatus.style.color = "";
  const name = getIdentity();
  el.identityStatus.textContent = name ? (name === "thomas" ? "Thomas" : "Behazin") : "Not chosen yet.";
}

// --- Left chat panel: Thomas <-> Behazin, with @anchy pulling Anchovy in ---

el.chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = el.chatInput.value.trim();
  if (!text) return;
  addMessage(getIdentity(), text);
  el.chatInput.value = "";

  state.mood = clamp(state.mood + 2);
  saveState();
  render();

  if (MENTION_RE.test(text)) {
    const asked = text.replace(MENTION_RE, "").trim() || "Hey Anchovy!";
    setTimeout(async () => {
      let reply = null;
      try {
        reply = await getGeminiReply(asked, state);
      } catch (err) {
        console.warn("Gemini reply failed, falling back to offline brain:", err);
      }
      if (!reply) {
        reply = getAnchovyReply(asked, state);
      }
      saveState(); // memory (recent lines / told stories) was updated
      sayReply(reply);
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
  saveState();

  if (getIdentity()) {
    hideCharScreen();
    renderChatHistory();
    await initSharedSync();
    handleWelcomeBack(wasAway);
  } else {
    showCharScreen();
  }
})();

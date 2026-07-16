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

const GIFT_LABELS = { hug: "Hug", lizard: "A pet lizard", hat: "Hat", rock: "Friendship Rock" };
const GIFT_MOOD_BOOST = { hug: 15, lizard: 10, hat: 25, rock: 12, custom: 15 };

let state = loadState();

const el = {
  hunger: document.getElementById("bar-hunger"),
  energy: document.getElementById("bar-energy"),
  mood: document.getElementById("bar-mood"),
  avatar: document.getElementById("avatar"),
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
  identitySelect: document.getElementById("identity-select"),
  supabaseUrlInput: document.getElementById("supabase-url-input"),
  supabaseKeyInput: document.getElementById("supabase-key-input"),
  syncStatus: document.getElementById("sync-status"),
  syncSave: document.getElementById("sync-save"),
  syncClear: document.getElementById("sync-clear"),
};

// Client-generated ids for messages this device has already rendered, so
// this device's own inserts don't get rendered a second time when they
// echo back through the realtime subscription.
const sentClientIds = new Set();

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
    const sender = who === "anchovy" ? "anchovy" : getIdentity();
    pushSharedMessage(sender, text, clientId).then(({ error }) => {
      if (error) showSyncError(`Send failed: ${error.message || error}`);
    });
  }
}

function showSyncError(message) {
  el.syncStatus.textContent = message;
  el.syncStatus.style.color = "#c0392b";
}

function renderMessage(msg) {
  const div = document.createElement("div");
  div.className = `msg ${msg.who}`;
  div.textContent = msg.text;
  el.chatlog.appendChild(div);
  el.chatlog.scrollTop = el.chatlog.scrollHeight;
}

function renderChatHistory() {
  el.chatlog.innerHTML = "";
  state.chatHistory.forEach(renderMessage);
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

// --- Shared sync (optional Supabase upgrade) ---

function hydrateChatHistory(rows) {
  state.chatHistory = rows
    .slice(-CHAT_HISTORY_CAP)
    .map((r) => ({
      who: r.sender === "anchovy" ? "anchovy" : "player",
      text: r.text,
      ts: new Date(r.created_at).getTime(),
    }));
  renderChatHistory();
  saveState();
}

function handleRemoteInsert(row) {
  if (row.client_id && sentClientIds.has(row.client_id)) return; // our own echo
  const who = row.sender === "anchovy" ? "anchovy" : "player";
  addMessage(who, row.text, { fromRemote: true });
  if (who === "anchovy") bounceAvatar();
}

async function initSharedSync() {
  const { rows, error } = await fetchSharedHistory(CHAT_HISTORY_CAP);
  if (error) {
    showSyncError(`Connection failed: ${error.message || error}`);
    return;
  }
  if (rows.length) hydrateChatHistory(rows);
  subscribeToSharedMessages(handleRemoteInsert);
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
  el.identitySelect.value = getIdentity();
  el.supabaseUrlInput.value = getSupabaseUrl();
  el.supabaseKeyInput.value = getSupabaseKey();
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

function updateSyncStatus() {
  el.syncStatus.style.color = "";
  el.syncStatus.textContent = isSyncConfigured()
    ? `Synced as ${getIdentity() === "thomas" ? "Thomas" : "Behazin"}.`
    : "Not synced (this device only).";
}

el.syncSave.addEventListener("click", () => {
  setIdentity(el.identitySelect.value);
  setSupabaseUrl(el.supabaseUrlInput.value.trim());
  setSupabaseKey(el.supabaseKeyInput.value.trim());
  updateSyncStatus();
  if (isSyncConfigured()) initSharedSync();
});

el.syncClear.addEventListener("click", () => {
  setIdentity("");
  setSupabaseUrl("");
  setSupabaseKey("");
  el.identitySelect.value = "";
  el.supabaseUrlInput.value = "";
  el.supabaseKeyInput.value = "";
  updateSyncStatus();
});

el.chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = el.chatInput.value.trim();
  if (!text) return;
  addMessage("player", text);
  el.chatInput.value = "";

  state.mood = clamp(state.mood + 2);
  saveState();
  render();

  setTimeout(async () => {
    let reply = null;
    try {
      reply = await getGeminiReply(text, state);
    } catch (err) {
      console.warn("Gemini reply failed, falling back to offline brain:", err);
    }
    if (!reply) {
      reply = getAnchovyReply(text, state);
    }
    saveState(); // memory (recent lines / told stories) was updated
    sayReply(reply);
  }, 400 + Math.random() * 400);
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

(function init() {
  const wasAway = applyDecay();
  render();
  renderChatHistory();
  updateRockOption();
  updateSettingsStatus();
  updateSyncStatus();
  saveState();
  if (isSyncConfigured()) {
    initSharedSync();
  } else {
    handleWelcomeBack(wasAway);
  }
})();

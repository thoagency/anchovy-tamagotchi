// Optional "smarter brain" upgrade: if a Gemini API key is set, chat replies
// go through the real model (using ANCHOVY_SYSTEM_PROMPT from brain.js).
// No key set -> app.js falls back to the offline brain, untouched.

const GEMINI_KEY_STORAGE = "anchovy-gemini-key";
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_HISTORY_LIMIT = 16; // recent messages to send as context

function getGeminiKey() {
  return localStorage.getItem(GEMINI_KEY_STORAGE) || "";
}

function setGeminiKey(key) {
  if (key) {
    localStorage.setItem(GEMINI_KEY_STORAGE, key);
  } else {
    localStorage.removeItem(GEMINI_KEY_STORAGE);
  }
}

function buildGeminiContents(chatHistory, latestUserText) {
  // Only messages directed at Anchovy (his own replies, plus @anchy asks)
  // go into his context -- the human-to-human chatter around them is left
  // out so the turns stay a clean user/model back-and-forth.
  const relevant = chatHistory.filter(
    (msg) => msg.who === "anchovy" || /@anchy\b/i.test(msg.text)
  );
  const recent = relevant.slice(-GEMINI_HISTORY_LIMIT);
  const contents = recent.map((msg) => ({
    role: msg.who === "anchovy" ? "model" : "user",
    parts: [{ text: msg.text.replace(/@anchy\b/gi, "").trim() || msg.text }],
  }));
  // Gemini requires the conversation to start with a "user" turn.
  while (contents.length && contents[0].role !== "user") {
    contents.shift();
  }
  contents.push({ role: "user", parts: [{ text: latestUserText }] });
  return contents;
}

// Long-term facts survive even after raw messages roll off chatHistory.
function buildSystemInstruction(state) {
  let prompt = ANCHOVY_SYSTEM_PROMPT;

  // Tell the model exactly who it's talking to right now, so it reaches
  // for real nicknames (see ANCHOVY_SYSTEM_PROMPT) instead of generic
  // "pal"/"buddy" -- this is the single biggest lever for making Gemini
  // replies feel distinctly personalized instead of like generic chat.
  const id = typeof getIdentity === "function" ? getIdentity() : "";
  if (id === "thomas") {
    prompt += "\n\nYou are currently chatting with Thomas. Address him by one of his real nicknames sometimes, not just \"pal\"/\"buddy\".";
  } else if (id === "behazin") {
    prompt +=
      "\n\nYou are currently chatting with Behazin (Bea) herself -- your favorite person in the whole world. " +
      "Be extra warm and a little giddy/shy, use her real nicknames, and lean into her word-shortening habit more than usual.";
  }

  const notes = state.memory?.notes || [];
  if (notes.length) {
    prompt +=
      "\n\nThings you remember about them from past conversations, bring these up naturally when relevant:\n- " +
      notes.join("\n- ");
  }
  return prompt;
}

// Fires a tiny real request so the settings UI can tell the difference
// between "no key set", "key set but broken", and "actually working" --
// without this, a bad key/model/quota silently falls back to the offline
// brain on every message and looks indistinguishable from it just being on.
async function testGeminiConnection() {
  const apiKey = getGeminiKey();
  if (!apiKey) return { ok: false, message: "No key set." };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Say chuurp." }] }],
        generationConfig: { maxOutputTokens: 20 },
      }),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json())?.error?.message || "";
      } catch (e) {}
      return { ok: false, message: `HTTP ${res.status}${detail ? `: ${detail}` : ""}` };
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("");
    if (!text) return { ok: false, message: "No text back (likely blocked by safety filters)." };
    return { ok: true, message: "Connected." };
  } catch (err) {
    return { ok: false, message: err.message || String(err) };
  }
}

// Returns a reply string, or null if no key is set. Throws on request
// failure so callers can fall back to the offline brain.
async function getGeminiReply(userText, state) {
  const apiKey = getGeminiKey();
  if (!apiKey) return null;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const body = {
    contents: buildGeminiContents(state.chatHistory, userText),
    systemInstruction: { parts: [{ text: buildSystemInstruction(state) }] },
    generationConfig: { maxOutputTokens: 200, temperature: 1 },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Gemini request failed: ${res.status}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p) => p.text || "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Gemini returned no text (possibly blocked by safety filters)");
  }
  return text;
}

// Before a batch of old messages rolls off local history, ask Gemini to
// pull out anything durable worth remembering long-term (names, dates,
// preferences, running jokes). Returns null if there's nothing worth
// keeping, no key is set, or the request fails.
async function summarizeForMemory(oldMessages) {
  const apiKey = getGeminiKey();
  if (!apiKey || !oldMessages.length) return null;

  const transcript = oldMessages
    .map((m) => `${m.who === "anchovy" ? "Anchovy" : "Them"}: ${m.text}`)
    .join("\n");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              "Here is a snippet of an old conversation with Anchovy, a Tamagotchi bird. " +
              "If it contains any durable fact, preference, name, date, or running joke worth " +
              "remembering long-term, reply with ONE short sentence capturing it. " +
              "If there is nothing worth keeping, reply with exactly: NONE\n\n" + transcript,
          },
        ],
      },
    ],
    generationConfig: { maxOutputTokens: 60, temperature: 0.3 },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || "")
      .join("")
      .trim();
    if (!text || text.toUpperCase().startsWith("NONE")) return null;
    return text;
  } catch (err) {
    console.warn("Memory summarization failed:", err);
    return null;
  }
}

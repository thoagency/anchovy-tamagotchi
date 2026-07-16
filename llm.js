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
  const recent = chatHistory.slice(-GEMINI_HISTORY_LIMIT);
  const contents = recent.map((msg) => ({
    role: msg.who === "player" ? "user" : "model",
    parts: [{ text: msg.text }],
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
  const notes = state.memory?.notes || [];
  if (!notes.length) return ANCHOVY_SYSTEM_PROMPT;
  return (
    ANCHOVY_SYSTEM_PROMPT +
    "\n\nThings you remember about them from past conversations, bring these up naturally when relevant:\n- " +
    notes.join("\n- ")
  );
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
    .map((m) => `${m.who === "player" ? "Them" : "Anchovy"}: ${m.text}`)
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

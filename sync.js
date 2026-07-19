// Optional shared multi-device sync via Supabase. Both devices write into
// the same `messages` table; a realtime subscription pushes new rows to
// every connected client, so you and Behazin see the same conversation
// with Anchovy no matter which device sent the message.
//
// Setup (run once in the Supabase SQL editor for your project):
//
//   create table messages (
//     id uuid primary key default gen_random_uuid(),
//     client_id text, -- lets the sending device recognize its own echo
//     sender text not null, -- 'thomas' | 'behazin' | 'anchovy'
//     text text not null,
//     created_at timestamptz not null default now()
//   );
//
//   alter table messages enable row level security;
//   create policy "Allow all reads" on messages for select using (true);
//   create policy "Allow all inserts" on messages for insert with check (true);
//
// A second table holds his shared stats (hunger/energy/mood), one row for
// the whole household, so Feed/Nap/Gift on either device shows up on the
// other in real time:
//
//   create table pet_state (
//     id int primary key default 1,
//     hunger numeric not null default 80,
//     energy numeric not null default 80,
//     mood numeric not null default 80,
//     rock_count int not null default 0,
//     pet_count int not null default 0,
//     hat_count int not null default 0,
//     updated_at timestamptz not null default now(),
//     constraint single_row check (id = 1)
//   );
//   insert into pet_state (id) values (1);
//
// If pet_state already exists from before Pocket totals were synced, add
// the three new columns instead:
//
//   alter table pet_state
//     add column rock_count int not null default 0,
//     add column pet_count int not null default 0,
//     add column hat_count int not null default 0;
//
//   alter table pet_state enable row level security;
//   create policy "Allow all reads" on pet_state for select using (true);
//   create policy "Allow all updates" on pet_state for update using (true);
//
// The project URL + publishable key are baked in below rather than entered
// per-device. This is safe for the publishable key specifically: it's
// designed to be exposed client-side and still respects the RLS policies
// above (it cannot bypass them, unlike the secret key, which must NEVER
// appear here or anywhere client-side).

const DEFAULT_SUPABASE_URL = "https://vbudvmpibficaqhhnnqh.supabase.co";
const DEFAULT_SUPABASE_KEY = "sb_publishable_35kRQlGpPg6vtvIXr_JkCQ_jPtx2vgd";

const SUPABASE_URL_STORAGE = "anchovy-supabase-url";
const SUPABASE_KEY_STORAGE = "anchovy-supabase-key";
const IDENTITY_STORAGE = "anchovy-identity"; // "thomas" | "behazin" | "guest"

// Casual gate, NOT real security -- these are sitting in a public JS file,
// readable by anyone who opens dev tools. This only stops a houseguest
// browsing the app from accidentally landing in Thomas or Behazin's
// account; it cannot stop someone who actually wants in. Change these
// before sharing the link around.
const IDENTITY_PINS = {
  thomas: "7777",
  behazin: "7777",
};

function checkIdentityPin(name, pin) {
  return IDENTITY_PINS[name] != null && pin === IDENTITY_PINS[name];
}

let supabaseClient = null;
let realtimeChannel = null;
let petStateChannel = null;

function getSupabaseUrl() {
  return localStorage.getItem(SUPABASE_URL_STORAGE) || DEFAULT_SUPABASE_URL;
}
function setSupabaseUrl(url) {
  if (url) localStorage.setItem(SUPABASE_URL_STORAGE, url);
  else localStorage.removeItem(SUPABASE_URL_STORAGE);
  resetSupabaseClient();
}
function getSupabaseKey() {
  return localStorage.getItem(SUPABASE_KEY_STORAGE) || DEFAULT_SUPABASE_KEY;
}
function setSupabaseKey(key) {
  if (key) localStorage.setItem(SUPABASE_KEY_STORAGE, key);
  else localStorage.removeItem(SUPABASE_KEY_STORAGE);
  resetSupabaseClient();
}

// Forces the next getSupabaseClient() call to rebuild with fresh
// credentials -- needed whenever the URL/key change after first use, since
// the client is otherwise cached for the page's lifetime.
function resetSupabaseClient() {
  if (realtimeChannel && supabaseClient) supabaseClient.removeChannel(realtimeChannel);
  if (petStateChannel && supabaseClient) supabaseClient.removeChannel(petStateChannel);
  realtimeChannel = null;
  petStateChannel = null;
  supabaseClient = null;
  stopMessagePolling();
  lastPolledCreatedAt = null;
}
function getIdentity() {
  return localStorage.getItem(IDENTITY_STORAGE) || "";
}
function setIdentity(name) {
  if (name) localStorage.setItem(IDENTITY_STORAGE, name);
  else localStorage.removeItem(IDENTITY_STORAGE);
}

function isSyncConfigured() {
  return !!(getSupabaseUrl() && getSupabaseKey() && getIdentity());
}

function getSupabaseClient() {
  if (!isSyncConfigured()) return null;
  if (!supabaseClient) {
    supabaseClient = window.supabase.createClient(getSupabaseUrl(), getSupabaseKey());
  }
  return supabaseClient;
}

async function fetchSharedHistory(limit = 60) {
  const client = getSupabaseClient();
  if (!client) return { rows: [], error: null };
  // Fetch newest-first so LIMIT keeps the most recent N messages, not the
  // oldest N (ascending + limit was grabbing the start of the
  // conversation once it grew past `limit` total messages) -- then
  // reverse back to chronological order for display.
  const { data, error } = await client
    .from("messages")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) console.warn("Supabase fetch history failed:", error);
  return { rows: (data || []).reverse(), error };
}

async function pushSharedMessage(sender, text, clientId) {
  const client = getSupabaseClient();
  if (!client) return { error: null };
  const { data, error } = await client
    .from("messages")
    .insert({ sender, text, client_id: clientId })
    .select()
    .single();
  if (error) console.warn("Supabase insert failed:", error);
  return { row: data, error };
}

// onInsert receives each new row as it arrives from any device (including
// this one -- callers should dedupe by id).
function subscribeToSharedMessages(onInsert) {
  const client = getSupabaseClient();
  if (!client) return;
  if (realtimeChannel) client.removeChannel(realtimeChannel);
  // A unique channel name per subscribe call (rather than a fixed one)
  // avoids a race where re-subscribing under the same topic right after
  // removing the old channel -- e.g. when switching identity -- can leave
  // the new subscription silently not receiving events until a full
  // reload forces a clean reconnect.
  realtimeChannel = client
    .channel(`messages-changes-${Date.now()}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "messages" },
      (payload) => onInsert(payload.new)
    )
    .subscribe();
}

let pollTimer = null;
let lastPolledCreatedAt = null;

// Backstop for the realtime subscription above: if a project's `messages`
// table was never actually added to the `supabase_realtime` publication (an
// easy step to miss in the Supabase dashboard/SQL editor), postgres_changes
// silently never fires and the app would otherwise only pick up new
// messages on a hard refresh. Polling every few seconds guarantees delivery
// either way; onInsert callers dedupe by row id, so overlap with realtime
// is harmless.
function startMessagePolling(onInsert, intervalMs = 4000) {
  stopMessagePolling();
  pollTimer = setInterval(async () => {
    const client = getSupabaseClient();
    if (!client) return;
    let query = client.from("messages").select("*").order("created_at", { ascending: true });
    if (lastPolledCreatedAt) query = query.gt("created_at", lastPolledCreatedAt);
    const { data, error } = await query;
    if (error || !data || !data.length) return;
    lastPolledCreatedAt = data[data.length - 1].created_at;
    data.forEach((row) => onInsert(row));
  }, intervalMs);
}

function stopMessagePolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function markPolledUpTo(createdAt) {
  if (createdAt) lastPolledCreatedAt = createdAt;
}

// --- Shared pet stats (hunger/energy/mood), one row for the whole
// household so feeding/napping/gifting on one device shows up on the
// other. Needs a `pet_state` table -- see README for the one-time SQL
// setup. Every function here degrades silently (returns an error, never
// throws) if that table doesn't exist yet, so the app keeps working with
// fully local/per-device stats until it's created.

async function fetchPetState() {
  const client = getSupabaseClient();
  if (!client) return { row: null, error: null };
  const { data, error } = await client.from("pet_state").select("*").eq("id", 1).single();
  if (error) console.warn("Supabase fetch pet_state failed (has the table been created?):", error);
  return { row: data, error };
}

// fields is a plain object of whichever pet_state columns changed (hunger/
// energy/mood/rock_count/pet_count/hat_count) -- callers always pass the
// full current snapshot rather than a partial diff, so this stays a
// simple last-write-wins update with no merge logic needed here.
async function pushPetState(fields) {
  const client = getSupabaseClient();
  if (!client) return { row: null, error: null };
  const { data, error } = await client
    .from("pet_state")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", 1)
    .select()
    .single();
  if (error) console.warn("Supabase push pet_state failed:", error);
  return { row: data, error };
}

// onUpdate receives the full new row every time any device changes it
// (including this one, if this device's own write echoes back).
function subscribeToPetState(onUpdate) {
  const client = getSupabaseClient();
  if (!client) return;
  if (petStateChannel) client.removeChannel(petStateChannel);
  petStateChannel = client
    .channel(`pet-state-changes-${Date.now()}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "pet_state" },
      (payload) => onUpdate(payload.new)
    )
    .subscribe();
}

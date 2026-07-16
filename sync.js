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
// The project URL + publishable key are baked in below rather than entered
// per-device. This is safe for the publishable key specifically: it's
// designed to be exposed client-side and still respects the RLS policies
// above (it cannot bypass them, unlike the secret key, which must NEVER
// appear here or anywhere client-side).

const DEFAULT_SUPABASE_URL = "https://vbudvmpibficaqhhnnqh.supabase.co";
const DEFAULT_SUPABASE_KEY = "sb_publishable_35kRQlGpPg6vtvIXr_JkCQ_jPtx2vgd";

const SUPABASE_URL_STORAGE = "anchovy-supabase-url";
const SUPABASE_KEY_STORAGE = "anchovy-supabase-key";
const IDENTITY_STORAGE = "anchovy-identity"; // "thomas" | "behazin"

let supabaseClient = null;
let realtimeChannel = null;

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
  realtimeChannel = null;
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
  const { data, error } = await client
    .from("messages")
    .select("*")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) console.warn("Supabase fetch history failed:", error);
  return { rows: data || [], error };
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
  realtimeChannel = client
    .channel("messages-changes")
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

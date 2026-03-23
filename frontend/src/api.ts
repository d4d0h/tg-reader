// API client — wraps all Worker endpoints

export interface AuthConfig {
  workerUrl: string;
  token: string;
  accountId: string;
}

let _cfg: AuthConfig | null = null;

export function setAuth(cfg: AuthConfig) {
  _cfg = cfg;
  // sessionStorage: gone on tab close, not persisted to disk
  sessionStorage.setItem('tgr_auth', JSON.stringify(cfg));
}

export function getAuth(): AuthConfig | null {
  if (_cfg) return _cfg;
  const stored = sessionStorage.getItem('tgr_auth');
  if (stored) { _cfg = JSON.parse(stored); return _cfg; }
  return null;
}

export function clearAuth() {
  _cfg = null;
  sessionStorage.removeItem('tgr_auth');
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const cfg = getAuth();
  if (!cfg) throw new Error('not authenticated');
  const url = `${cfg.workerUrl.replace(/\/$/, '')}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Ingest-Token': cfg.token,
      'X-Account-ID': cfg.accountId,
      ...opts.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── Stats ──────────────────────────────────────────────────────────────────
export interface Stats {
  total_messages: number;
  total_chats: number;
  total_contacts: number;
  earliest_message_at: number | null;  // unix epoch seconds
  latest_message_at: number | null;    // unix epoch seconds
}

export const fetchStats = () => req<Stats>('/stats');

// ── History ────────────────────────────────────────────────────────────────
export interface HistoryResult {
  messages: Message[];
  next_after_id: number | null;
  next_after_sent_at: number | null;
}

export function fetchHistory(params: {
  chat_id: string;
  limit?: number;
  after_id?: number;
  after_sent_at?: number;
}) {
  const p = new URLSearchParams();
  p.set('chat_id', params.chat_id);
  p.set('limit', String(params.limit ?? 50));
  if (params.after_id) p.set('after_id', String(params.after_id));
  if (params.after_sent_at) p.set('after_sent_at', String(params.after_sent_at));
  return req<HistoryResult>(`/history?${p}`);
}

// ── Audit Log ───────────────────────────────────────────────────────────────
export interface AuditEntry {
  id: string;
  action: 'send' | 'edit' | 'delete' | 'forward';
  target_chat_id: string | null;
  detail: string | null;
  token_label: string | null;
  created_at: number;
}

export function fetchAuditLog(params: { limit?: number; offset?: number } = {}) {
  const p = new URLSearchParams();
  p.set('limit', String(params.limit ?? 50));
  if (params.offset) p.set('offset', String(params.offset));
  return req<AuditEntry[]>(`/audit-log?${p}`);
}

// ── Search ─────────────────────────────────────────────────────────────────
export interface Message {
  id: number;
  tg_message_id: string;
  tg_chat_id: string;
  chat_name: string;
  chat_type: string;
  sender_id: string;
  sender_username: string | null;
  sender_first_name: string | null;
  sender_last_name: string | null;
  text: string;
  sent_at: number;
}

export interface SearchResult {
  results: Message[];
  total: number;
  next_before_id: number | null;
  next_before_sent_at: number | null;
}

export function fetchMessages(params: {
  q?: string;
  chat_id?: string;
  chat_type?: string;
  sender_id?: string;
  media_type?: string;
  date_from?: number;
  date_to?: number;
  limit?: number;
  next_before_id?: number;
  next_before_sent_at?: number;
}) {
  const p = new URLSearchParams();
  if (params.q) p.set('q', params.q);
  if (params.chat_id) p.set('chat_id', params.chat_id);
  if (params.chat_type) p.set('chat_type', params.chat_type);
  if (params.sender_id) p.set('sender_id', params.sender_id);
  if (params.media_type) p.set('media_type', params.media_type);
  if (params.date_from) p.set('date_from', String(params.date_from));
  if (params.date_to) p.set('date_to', String(params.date_to));
  p.set('limit', String(params.limit ?? 50));
  if (params.next_before_id) p.set('next_before_id', String(params.next_before_id));
  if (params.next_before_sent_at) p.set('next_before_sent_at', String(params.next_before_sent_at));
  return req<SearchResult>(`/search?${p}`);
}

// ── Saved Searches ──────────────────────────────────────────────────────────
export interface SavedSearch {
  id: string;
  name: string;
  query: string | null;
  sender_id: string | null;
  chat_type: string | null;
  media_type: string | null;
  date_from: number | null;
  date_to: number | null;
  created_at: number;
}

export const fetchSavedSearches = () => req<SavedSearch[]>('/saved-searches');

export function createSavedSearch(data: {
  name: string;
  query?: string | null;
  sender_id?: string | null;
  chat_type?: string | null;
  media_type?: string | null;
  date_from?: number | null;
  date_to?: number | null;
}) {
  return req<{ ok: boolean; id: string }>('/saved-searches', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function deleteSavedSearch(id: string) {
  return req<{ ok: boolean }>(`/saved-searches/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ── Chats ──────────────────────────────────────────────────────────────────
export interface Chat {
  tg_chat_id: string;
  chat_name: string;
  chat_type: string;
  message_count: number;
  last_message_at: number | null;
}

export const PAGE_SIZE = 50;

export function fetchChats(params: { limit?: number; offset?: number; name?: string } = {}) {
  const p = new URLSearchParams();
  p.set('limit', String(params.limit ?? PAGE_SIZE));
  if (params.offset) p.set('offset', String(params.offset));
  if (params.name) p.set('name', params.name);
  return req<Chat[]>(`/chats?${p}`);
}

// ── Contacts ───────────────────────────────────────────────────────────────
export interface Contact {
  tg_user_id: string;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  phone: string | null;
  is_bot: number;  // SMALLINT 0|1
}

export function fetchContacts(params: { limit?: number; offset?: number; search?: string } = {}) {
  const p = new URLSearchParams();
  p.set('limit', String(params.limit ?? PAGE_SIZE));
  if (params.offset) p.set('offset', String(params.offset));
  if (params.search) p.set('search', params.search);
  return req<Contact[]>(`/contacts?${p}`);
}

// ── Backfill ───────────────────────────────────────────────────────────────
export interface BackfillJob {
  tg_chat_id: string;
  chat_name: string;
  total_messages: number;
  fetched_messages: number;
  status: 'pending' | 'in_progress' | 'complete' | 'failed';
}

export const fetchBackfill = () =>
  req<BackfillJob[]>('/backfill/pending?all=1');

// ── Jobs ───────────────────────────────────────────────────────────────────
export interface Job {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string | null;
  trigger_type: string | null;
  last_run_at: number | null;  // unix epoch seconds
  cooldown_secs: number;
  token_label: string | null;
}

export const fetchJobs = () => req<Job[]>('/jobs');

export function toggleJob(name: string, enabled: boolean) {
  return req<{ ok: boolean; enabled: boolean }>(`/jobs/${encodeURIComponent(name)}/toggle`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  });
}

export interface CreateJobPayload {
  name: string;
  task_prompt: string;
  model_config: { provider: string; model: string; api_key_ref: string };
  schedule?: string | null;
  trigger_type?: string | null;
  cooldown_secs?: number;
}

export function createJob(data: CreateJobPayload) {
  return req<{ ok: boolean; job_id: string; token: string; token_note: string }>('/jobs', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ── Chat Config ─────────────────────────────────────────────────────────────
export interface ChatConfig {
  tg_chat_id: string;
  chat_name: string | null;
  sync: 'include' | 'exclude' | null;
  label: string | null;
  updated_at: number;
}

export const fetchChatsConfig = () => req<ChatConfig[]>('/chats/config');

// ── Global Config ───────────────────────────────────────────────────────────
export interface GlobalConfig {
  sync_mode: 'all' | 'whitelist' | 'blacklist' | 'none';
  mass_send_max_recipients: number;
  mass_send_contacts_only: boolean;
}

export const fetchGlobalConfig = () => req<GlobalConfig>('/config');

export function setGlobalConfig(data: Partial<GlobalConfig>) {
  return req<{ ok: boolean }>('/config', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateChatConfig(data: {
  tg_chat_id: string;
  chat_name?: string | null;
  sync?: 'include' | 'exclude' | null;
  label?: string | null;
}) {
  return req<{ ok: boolean }>('/chats/config', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function deleteChatConfig(tgChatId: string) {
  return req<{ ok: boolean }>(`/chats/config/${encodeURIComponent(tgChatId)}`, {
    method: 'DELETE',
  });
}

// ── Tokens ─────────────────────────────────────────────────────────────────
export interface TokenAccount {
  account_id: string;
  role: string;
  read_mode: string;
  can_send: boolean;
  can_edit: boolean;
  can_delete: boolean;
  can_forward: boolean;
}

export interface AgentToken {
  id: string;
  label: string | null;
  expires_at: number | null;
  last_used_at: number | null;
  created_at: number;
  accounts: TokenAccount[];
}

export const fetchTokens = () => req<AgentToken[]>('/tokens');

export function revokeToken(id: string) {
  return req<{ ok: boolean }>(`/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface CreateTokenPayload {
  role_name: string;
  label?: string;
  expires_at?: number;
}

export function createToken(data: CreateTokenPayload) {
  return req<{ ok: boolean; token: string; token_id: string; label: string | null; role: string; note: string }>('/tokens', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ── Roles ───────────────────────────────────────────────────────────────────
export interface Role {
  id: string;
  name: string;
  read_mode: string;
  can_send: boolean;
  can_edit: boolean;
  can_delete: boolean;
  can_forward: boolean;
  read_labels: string | null;
  read_chat_ids: string | null;
  write_labels: string | null;
  write_chat_ids: string | null;
  write_chat_types: string | null;
}

export const fetchRoles = () => req<Role[]>('/roles');

// ── Insights ────────────────────────────────────────────────────────────────
export interface InsightData {
  tone: 'warm' | 'neutral' | 'professional' | 'tense';
  tone_trend?: 'improving' | 'stable' | 'declining';
  topics: string[];
  relationship_arc?: string;
  initiated_by?: 'me' | 'them' | 'balanced';
  avg_response_time_hrs?: number;
  unresolved_threads?: string[];
  last_active_days_ago?: number;
  summary: string;
  follow_up?: string | null;
}

export interface ChatInsight {
  tg_chat_id: string;
  generated_at: number;
  last_message_at: number;
  model: string;
  insight_type: string;
  data: InsightData;
}

export function fetchInsight(chatId: string) {
  return req<{ insight: ChatInsight | null }>(`/insights/${encodeURIComponent(chatId)}`);
}

// ── Follow-ups ──────────────────────────────────────────────────────────────
export interface FollowUp {
  id: string;
  tg_chat_id: string;
  chat_name: string | null;
  message_id: string | null;
  remind_at: number;      // Unix epoch seconds
  note: string | null;
  is_overdue: boolean;
  created_at: number;
}

export interface OverdueChat {
  tg_chat_id: string;
  chat_name: string | null;
  last_message_at: number;
  sender_display_name: string | null;
  snippet: string | null;
}

export function fetchFollowUps(params: { limit?: number } = {}) {
  const p = new URLSearchParams();
  if (params.limit) p.set('limit', String(params.limit));
  return req<FollowUp[]>(`/follow-ups?${p}`);
}

export function fetchOverdueChats() {
  return req<OverdueChat[]>('/follow-ups/overdue');
}

export function createFollowUp(data: {
  tg_chat_id: string;
  message_id?: number | null;
  remind_at: number;
  note?: string | null;
}) {
  return req<{ ok: boolean; id: string }>('/follow-ups', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function dismissFollowUp(id: string) {
  return req<{ ok: boolean }>(`/follow-ups/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ── Contact Intelligence ────────────────────────────────────────────────────

export interface ContactNote {
  id: string;
  note: string;
  created_at: number;
}

export type ContactStatusValue = 'warm' | 'neutral' | 'dormant' | 'needs-follow-up';

export interface ContactProfile {
  sender_id: string;
  display_name: string;
  total_messages: number;
  chats_count: number;
  first_message_at: number | null;
  last_message_at: number | null;
  avg_response_time_hrs: number | null;
  notes: ContactNote[];
  tags: string[];
  status: ContactStatusValue | null;
}

export interface ContactMessagesResult {
  messages: Message[];
  next_before_id: number | null;
}

export function fetchContactProfile(senderId: string) {
  return req<ContactProfile>(`/contacts/${encodeURIComponent(senderId)}`);
}

export function fetchContactMessages(senderId: string, params: { limit?: number; before_id?: number } = {}) {
  const p = new URLSearchParams();
  p.set('limit', String(params.limit ?? 50));
  if (params.before_id) p.set('before_id', String(params.before_id));
  return req<ContactMessagesResult>(`/contacts/${encodeURIComponent(senderId)}/messages?${p}`);
}

export function addContactNote(senderId: string, note: string) {
  return req<{ ok: boolean; id: string; created_at: number }>(`/contacts/${encodeURIComponent(senderId)}/notes`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  });
}

export function deleteContactNote(senderId: string, noteId: string) {
  return req<{ ok: boolean }>(`/contacts/${encodeURIComponent(senderId)}/notes/${encodeURIComponent(noteId)}`, {
    method: 'DELETE',
  });
}

export function setContactTags(senderId: string, tags: string[]) {
  return req<{ ok: boolean; tags: string[] }>(`/contacts/${encodeURIComponent(senderId)}/tags`, {
    method: 'PUT',
    body: JSON.stringify({ tags }),
  });
}

export function setContactStatus(senderId: string, status: ContactStatusValue) {
  return req<{ ok: boolean; status: string }>(`/contacts/${encodeURIComponent(senderId)}/status`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  });
}

// ── Contact Briefings ────────────────────────────────────────────────────────

export interface ContactBriefingData {
  summary: string;
  topics: string[];
  tone: 'warm' | 'neutral' | 'professional' | 'tense';
  open_threads: string[];
  agreed_items: string[];
  last_sentiment: string;
  relationship_arc: string;
}

export interface ContactBriefing {
  sender_id: string;
  generated_at: number;
  model: string;
  data: ContactBriefingData;
}

export function fetchContactBriefing(senderId: string) {
  return req<{ briefing: ContactBriefing | null }>(`/contacts/${encodeURIComponent(senderId)}/briefing`);
}

export function generateContactBriefing(
  senderId: string,
  modelConfig: { provider: string; model: string; api_key_ref: string },
) {
  return req<{ ok: boolean; briefing: ContactBriefing }>(`/contacts/${encodeURIComponent(senderId)}/briefing/generate`, {
    method: 'POST',
    body: JSON.stringify({ model_config: modelConfig }),
  });
}

// ── Links ───────────────────────────────────────────────────────────────────
export interface LinkItem {
  id: string;
  tg_chat_id: string;
  message_id: string | null;
  sender_id: string;
  url: string;
  domain: string;
  sent_at: number;
  bookmarked: boolean;
  tag: string | null;
  chat_name: string | null;
  sender_display_name: string;
}

export function fetchLinks(params: {
  domain?: string;
  sender_id?: string;
  tg_chat_id?: string;
  bookmarked?: boolean;
  limit?: number;
  before_id?: string;
  q?: string;
} = {}) {
  const p = new URLSearchParams();
  p.set('limit', String(params.limit ?? 50));
  if (params.domain) p.set('domain', params.domain);
  if (params.sender_id) p.set('sender_id', params.sender_id);
  if (params.tg_chat_id) p.set('tg_chat_id', params.tg_chat_id);
  if (params.bookmarked) p.set('bookmarked', 'true');
  if (params.before_id) p.set('before_id', params.before_id);
  if (params.q) p.set('q', params.q);
  return req<LinkItem[]>(`/links?${p}`);
}

export function bookmarkLink(id: string, bookmarked: boolean) {
  return req<{ ok: boolean; bookmarked: boolean }>(`/links/${encodeURIComponent(id)}/bookmark`, {
    method: 'PUT',
    body: JSON.stringify({ bookmarked }),
  });
}

export function tagLink(id: string, tag: string | null) {
  return req<{ ok: boolean; tag: string | null }>(`/links/${encodeURIComponent(id)}/tag`, {
    method: 'PUT',
    body: JSON.stringify({ tag }),
  });
}

// ── Auth probe ─────────────────────────────────────────────────────────────
export async function probeAuth(cfg: AuthConfig): Promise<void> {
  const url = `${cfg.workerUrl.replace(/\/$/, '')}/stats`;
  const res = await fetch(url, {
    headers: {
      'X-Ingest-Token': cfg.token,
      'X-Account-ID': cfg.accountId,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error ?? `HTTP ${res.status}`);
  }
}

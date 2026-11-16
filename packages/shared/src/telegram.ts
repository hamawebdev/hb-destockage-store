/**
 * Telegram order messages (TGS-1): the settings the admin stores, the order view the jobs Worker
 * loads, and the one formatter both use (the admin for the preview and the test message, jobs for
 * the real thing). Pure: no fetch, no D1. The HTTP client is `telegram-api.ts`.
 *
 * The owner ticks which details a message carries; exactly the ticked ones appear (D-022).
 */
import { formatPrice } from './format.ts';
import { formatPhoneDisplay } from './phone.ts';

export const TELEGRAM_FIELDS = ['ref', 'name', 'phone', 'place', 'address', 'items', 'fee', 'total', 'note'] as const;
export type TelegramField = (typeof TELEGRAM_FIELDS)[number];
/** Before the owner chooses: everything. */
export const TELEGRAM_DEFAULT_FIELDS: readonly TelegramField[] = TELEGRAM_FIELDS;
export const TELEGRAM_TOKEN_RE = /^\d{5,12}:[A-Za-z0-9_-]{30,64}$/;
export const TELEGRAM_MAX_CHATS = 10;
export const TELEGRAM_CHAT_TITLE_MAX = 80;
/** Telegram's limit for one text message, in UTF-16 code units. */
export const TELEGRAM_MESSAGE_MAX = 4096;
/** A Telegram chat id as a decimal string (groups and channels are negative). */
export const TELEGRAM_CHAT_ID_RE = /^-?\d{1,20}$/;

export const TELEGRAM_CHAT_TYPES = ['private', 'group', 'supergroup', 'channel'] as const;
export type TelegramChatType = (typeof TELEGRAM_CHAT_TYPES)[number];
export interface TelegramChat {
  /** Telegram chat id as a decimal string (may be negative). */
  id: string;
  /** Group title, or first+last name / @username for a private chat; max 80 chars. */
  title: string;
  type: TelegramChatType;
  status: 'pending' | 'confirmed';
  /** Epoch ms, when the admin first found it. */
  seenAt: number;
  confirmedAt: number | null;
}
export interface TelegramSettings {
  enabled: boolean;
  /** Set when `enabled` goes false→true; orders created before it are never sent. */
  enabledAt: number | null;
  lang: 'fr' | 'ar';
  /** Order = TELEGRAM_FIELDS order, deduped. */
  fields: TelegramField[];
  chats: TelegramChat[];
  bot: { id: number; username: string; name: string } | null;
  tokenLast4: string | null;
  /** Next getUpdates offset (last update_id + 1). */
  updateOffset: number | null;
}

export const TELEGRAM_SETTINGS_DEFAULT: TelegramSettings = {
  enabled: false,
  enabledAt: null,
  lang: 'fr',
  fields: [...TELEGRAM_DEFAULT_FIELDS],
  chats: [],
  bot: null,
  tokenLast4: null,
  updateOffset: null,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const epoch = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** Strips control and bidi-format characters and collapses whitespace, so one value is one line. */
export function telegramOneLine(value: string, max: number): string {
  const clean = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** The fields of `value` that are known, in TELEGRAM_FIELDS order, deduped. Not an array ⇒ null. */
export function normalizeTelegramFields(value: unknown): TelegramField[] | null {
  if (!Array.isArray(value)) return null;
  return TELEGRAM_FIELDS.filter((f) => value.includes(f));
}

function parseChat(v: unknown): TelegramChat | null {
  if (!isRecord(v)) return null;
  const { id, title, type, status } = v;
  if (typeof id !== 'string' || !TELEGRAM_CHAT_ID_RE.test(id)) return null;
  if (!(TELEGRAM_CHAT_TYPES as readonly unknown[]).includes(type)) return null;
  if (status !== 'pending' && status !== 'confirmed') return null;
  const confirmedAt = epoch(v['confirmedAt']);
  // A confirmed chat without its date would have no cut-off: treat it as not yet confirmed.
  const ok = status === 'confirmed' && confirmedAt !== null;
  return {
    id,
    title: telegramOneLine(typeof title === 'string' ? title : '', TELEGRAM_CHAT_TITLE_MAX) || id,
    type: type as TelegramChatType,
    status: ok ? 'confirmed' : 'pending',
    seenAt: epoch(v['seenAt']) ?? 0,
    confirmedAt: ok ? confirmedAt : null,
  };
}

/** A fresh copy of the default (callers may mutate what they get). */
function defaults(): TelegramSettings {
  return { ...TELEGRAM_SETTINGS_DEFAULT, fields: [...TELEGRAM_DEFAULT_FIELDS], chats: [] };
}

/** Tolerant: any garbage gives the default; unknown fields dropped. Never throws. */
export function parseTelegramSettings(value: unknown): TelegramSettings {
  const out = defaults();
  try {
    let v = value;
    // D1 hands JSON columns back as text unless the reader parsed them.
    if (typeof v === 'string') v = JSON.parse(v) as unknown;
    if (!isRecord(v)) return out;
    out.enabled = v['enabled'] === true;
    out.enabledAt = epoch(v['enabledAt']);
    out.lang = v['lang'] === 'ar' ? 'ar' : 'fr';
    out.fields = normalizeTelegramFields(v['fields']) ?? out.fields;
    if (Array.isArray(v['chats'])) {
      const seen = new Set<string>();
      for (const raw of v['chats']) {
        const chat = parseChat(raw);
        if (chat === null || seen.has(chat.id)) continue;
        seen.add(chat.id);
        out.chats.push(chat);
      }
    }
    const bot = v['bot'];
    if (isRecord(bot) && typeof bot['id'] === 'number' && Number.isSafeInteger(bot['id']) && typeof bot['username'] === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(bot['username'])) {
      out.bot = { id: bot['id'], username: bot['username'], name: telegramOneLine(typeof bot['name'] === 'string' ? bot['name'] : '', 80) };
    }
    const last4 = v['tokenLast4'];
    out.tokenLast4 = typeof last4 === 'string' && /^[A-Za-z0-9_-]{4}$/.test(last4) ? last4 : null;
    out.updateOffset = epoch(v['updateOffset']);
    return out;
  } catch {
    return defaults();
  }
}

/** Confirmed chats only: the ones that receive orders. */
export function confirmedTelegramChats(s: TelegramSettings): TelegramChat[] {
  return s.chats.filter((c) => c.status === 'confirmed' && c.confirmedAt !== null);
}

// ---------------------------------------------------------------------------------------------
// `jobs.telegram_status` (written only by the jobs Worker, read by the admin)
// ---------------------------------------------------------------------------------------------

export const TELEGRAM_STATUS_CODES = ['token_rejected', 'unreachable', 'rate_limited', 'key_missing', 'chat_rejected'] as const;
export type TelegramStatusCode = (typeof TELEGRAM_STATUS_CODES)[number];
export interface TelegramStatus {
  lastOkAt: number | null;
  lastErrorCode: TelegramStatusCode | null;
  lastErrorAt: number | null;
}

/** Tolerant like `parseTelegramSettings`. */
export function parseTelegramStatus(value: unknown): TelegramStatus {
  const none: TelegramStatus = { lastOkAt: null, lastErrorCode: null, lastErrorAt: null };
  try {
    let v = value;
    if (typeof v === 'string') v = JSON.parse(v) as unknown;
    if (!isRecord(v)) return none;
    const code = v['lastErrorCode'];
    const known = (TELEGRAM_STATUS_CODES as readonly unknown[]).includes(code);
    return { lastOkAt: epoch(v['lastOkAt']), lastErrorCode: known ? (code as TelegramStatusCode) : null, lastErrorAt: known ? epoch(v['lastErrorAt']) : null };
  } catch {
    return none;
  }
}

// ---------------------------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------------------------

export interface TelegramOrderView {
  ref: string;
  name: string;
  phoneE164: string;
  wilayaCode: number;
  wilaya: { fr: string; ar: string };
  commune: { fr: string; ar: string } | null;
  address: string | null;
  items: { name: { fr: string; ar: string }; variant: { fr: string; ar: string } | null; qty: number; lineTotalDzd: number }[];
  feeDzd: number;
  totalDzd: number;
  note: string | null;
}

/** Obviously fictional; used by the admin preview and the test message. */
export const TELEGRAM_SAMPLE_ORDER: TelegramOrderView = {
  ref: 'HB-TEST1',
  name: 'Client Exemple',
  phoneE164: '+213550000000',
  wilayaCode: 16,
  wilaya: { fr: 'Alger', ar: 'الجزائر' },
  commune: { fr: 'Bab Ezzouar', ar: 'باب الزوار' },
  address: 'Cité Exemple, bâtiment 1',
  items: [
    { name: { fr: 'Produit exemple', ar: 'منتج تجريبي' }, variant: { fr: 'Noir / L', ar: 'أسود / L' }, qty: 2, lineTotalDzd: 5000 },
    { name: { fr: 'Autre produit', ar: 'منتج آخر' }, variant: null, qty: 1, lineTotalDzd: 1900 },
  ],
  feeDzd: 600,
  totalDzd: 7500,
  note: 'Appeler après 17 h',
};

const LABELS = {
  fr: {
    head: 'Nouvelle commande',
    name: 'Client : ',
    phone: 'Téléphone : ',
    place: 'Wilaya : ',
    address: 'Adresse : ',
    items: 'Produits :',
    fee: 'Livraison : ',
    total: 'Total : ',
    note: 'Note : ',
  },
  ar: {
    head: 'طلب جديد',
    name: 'الاسم: ',
    phone: 'الهاتف: ',
    place: 'الولاية: ',
    address: 'العنوان: ',
    items: 'المنتجات:',
    fee: 'التوصيل: ',
    total: 'المجموع: ',
    note: 'ملاحظة: ',
  },
} as const;

const LRI = '\u2066';
const FSI = '\u2068';
const PDI = '\u2069';
/** Room kept under the hard limit for the lines that follow a truncated item list. */
const ITEM_BUDGET_MARGIN = 16;

/**
 * Plain text (no parse_mode). First line "Nouvelle commande" / "طلب جديد" (+ the ref when 'ref' is
 * ticked). One labelled line per ticked field, in TELEGRAM_FIELDS order; 'items' = one line per item
 * "2 × Name (variant)". A ticked field with no value (no address, no note) is left out.
 * In Arabic, the ref and the phone sit in left-to-right isolates and free text (name, address,
 * product names, note) in first-strong isolates, so a Latin run never reorders the line.
 * Always under Telegram's 4096 characters: the item list is cut with "…" when it would not fit.
 */
export function formatTelegramOrder(order: TelegramOrderView, fields: readonly TelegramField[], lang: 'fr' | 'ar'): string {
  const on = new Set<TelegramField>(fields);
  const L = LABELS[lang];
  const ar = lang === 'ar';
  const ltr = (s: string): string => (ar ? `${LRI}${s}${PDI}` : s);
  const free = (s: string): string => (ar ? `${FSI}${s}${PDI}` : s);

  const before: string[] = [];
  const itemLines: string[] = [];
  const after: string[] = [];

  before.push(on.has('ref') ? `${L.head} ${ltr(telegramOneLine(order.ref, 40))}` : L.head);
  if (on.has('name')) {
    const name = telegramOneLine(order.name, 120);
    if (name) before.push(L.name + free(name));
  }
  if (on.has('phone')) {
    const phone = telegramOneLine(formatPhoneDisplay(order.phoneE164).replace(/ /g, ''), 40);
    if (phone) before.push(L.phone + ltr(phone));
  }
  if (on.has('place')) {
    const wilaya = telegramOneLine(order.wilaya[lang], 80);
    const commune = order.commune ? telegramOneLine(order.commune[lang], 80) : '';
    const code = ltr(String(order.wilayaCode).padStart(2, '0'));
    before.push(`${L.place}${code} ${wilaya}${commune ? `${ar ? '،' : ','} ${commune}` : ''}`);
  }
  if (on.has('address') && order.address !== null) {
    const address = telegramOneLine(order.address, 300);
    if (address) before.push(L.address + free(address));
  }
  if (on.has('items')) {
    for (const item of order.items) {
      const name = telegramOneLine(item.name[lang], 120);
      const variant = item.variant ? telegramOneLine(item.variant[lang], 80) : '';
      itemLines.push(`${ltr(String(item.qty))} × ${free(variant ? `${name} (${variant})` : name)}`);
    }
  }
  if (on.has('fee')) after.push(L.fee + formatPrice(order.feeDzd, lang));
  if (on.has('total')) after.push(L.total + formatPrice(order.totalDzd, lang));
  if (on.has('note') && order.note !== null) {
    const note = telegramOneLine(order.note, 500);
    if (note) after.push(L.note + free(note));
  }

  const lines = [...before];
  if (itemLines.length > 0) {
    lines.push(L.items);
    const fixed = [...lines, ...after].join('\n').length;
    let room = TELEGRAM_MESSAGE_MAX - ITEM_BUDGET_MARGIN - fixed;
    let shown = 0;
    for (const line of itemLines) {
      if (line.length + 1 > room) break;
      lines.push(line);
      room -= line.length + 1;
      shown += 1;
    }
    if (shown < itemLines.length) lines.push('…');
  }
  lines.push(...after);
  // Every part above is bounded, so this slice is a guard, not the mechanism.
  return lines.join('\n').slice(0, TELEGRAM_MESSAGE_MAX);
}

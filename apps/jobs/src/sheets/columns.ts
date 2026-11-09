// The sheet's columns (SHEET-0 §3): fixed per sheet, in the language chosen at connect.
export type SheetLang = 'fr' | 'ar';
export type CellValue = string | number;

export const HEADERS: Readonly<Record<SheetLang, readonly string[]>> = {
  fr: ['Référence', 'Date', 'Client', 'Téléphone', 'Code wilaya', 'Wilaya', 'Commune', 'Adresse', 'Produits', 'Quantité', 'Sous-total (DZD)', 'Livraison (DZD)', 'Total (DZD)', 'Statut', 'Appels', 'Transporteur', 'Suivi', 'État du colis', 'Mis à jour'],
  ar: ['المرجع', 'التاريخ', 'الزبون', 'الهاتف', 'رمز الولاية', 'الولاية', 'البلدية', 'العنوان', 'المنتجات', 'الكمية', 'المجموع الفرعي (دج)', 'التوصيل (دج)', 'المجموع (دج)', 'الحالة', 'المكالمات', 'شركة التوصيل', 'رقم التتبع', 'حالة الطرد', 'آخر تحديث'],
};

export const TAB_TITLE: Readonly<Record<SheetLang, string>> = { fr: 'Commandes', ar: 'الطلبات' };
export const FILE_NAME: Readonly<Record<SheetLang, string>> = { fr: 'HB Destockage - Commandes', ar: 'HB Destockage - الطلبات' };

const ORDER_STATUS: Readonly<Record<SheetLang, Readonly<Record<string, string>>>> = {
  fr: { new: 'Nouvelle', called: 'Appelée', confirmed: 'Confirmée', unreachable: 'Injoignable', cancelled: 'Annulée', shipped: 'Expédiée', delivered: 'Livrée', returned: 'Retournée' },
  ar: { new: 'جديدة', called: 'تم الاتصال', confirmed: 'مؤكدة', unreachable: 'تعذر الوصول', cancelled: 'ملغاة', shipped: 'مشحونة', delivered: 'مسلّمة', returned: 'مرتجعة' },
};

const PARCEL_STATUS: Readonly<Record<SheetLang, Readonly<Record<string, string>>>> = {
  fr: { pending: 'En attente', in_transit: 'En transit', delivered: 'Livré', returning: 'En retour', returned: 'Retourné', exception: 'Incident', unknown: 'Inconnu' },
  ar: { pending: 'قيد الانتظار', in_transit: 'في الطريق', delivered: 'تم التسليم', returning: 'في طريق الإرجاع', returned: 'مرتجع', exception: 'مشكلة', unknown: 'غير معروف' },
};

const MAX_CELL = 1000;
const cap = (s: string): string => (s.length > MAX_CELL ? s.slice(0, MAX_CELL) : s);

/** Algeria is UTC+1 all year, with no daylight saving. */
export function algiersTime(ms: number): string {
  return new Date(ms + 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
}

const nationalPhone = (e164: string): string => (e164.startsWith('+213') ? `0${e164.slice(4)}` : e164);

export interface OrderItemRow {
  name_fr: string;
  name_ar: string;
  variant_label_fr: string | null;
  variant_label_ar: string | null;
  qty: number;
}

export interface OrderRowSource {
  ref: string;
  name: string;
  phone_e164: string;
  wilaya_code: number;
  wilaya_fr: string;
  wilaya_ar: string;
  commune_fr: string;
  commune_ar: string;
  address: string | null;
  subtotal_dzd: number;
  fee_dzd: number;
  total_dzd: number;
  status: string;
  call_attempts: number;
  courier_name: string | null;
  courier_tracking: string | null;
  created_at: number;
  updated_at: number;
  courier_status: string | null;
  shipment_stamp: number | null;
}

/** One value per column of `HEADERS`, in order. */
export function buildRow(o: OrderRowSource, items: readonly OrderItemRow[], lang: SheetLang): CellValue[] {
  const products = items
    .map((i) => {
      const name = lang === 'ar' ? i.name_ar : i.name_fr;
      const variant = lang === 'ar' ? i.variant_label_ar : i.variant_label_fr;
      return `${name}${variant ? ` (${variant})` : ''} × ${i.qty}`;
    })
    .join(' ; ');
  return [
    cap(o.ref),
    algiersTime(o.created_at),
    cap(o.name),
    nationalPhone(o.phone_e164),
    o.wilaya_code,
    cap(lang === 'ar' ? o.wilaya_ar : o.wilaya_fr),
    cap(lang === 'ar' ? o.commune_ar : o.commune_fr),
    cap(o.address ?? ''),
    cap(products),
    items.reduce((n, i) => n + i.qty, 0),
    o.subtotal_dzd,
    o.fee_dzd,
    o.total_dzd,
    ORDER_STATUS[lang][o.status] ?? o.status,
    o.call_attempts,
    cap(o.courier_name ?? ''),
    cap(o.courier_tracking ?? ''),
    o.courier_status === null ? '' : (PARCEL_STATUS[lang][o.courier_status] ?? o.courier_status),
    algiersTime(Math.max(o.updated_at, o.shipment_stamp ?? 0)),
  ];
}

export async function hashRow(row: readonly CellValue[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(row)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function colLetters(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export const quoteTitle = (title: string): string => `'${title.replace(/'/g, "''")}'`;

export type Layout = { ok: true; refColumn: number; columns: (number | null)[]; missing: string[] } | { ok: false };

/** Finds our columns by exact header. The ref header must appear exactly once. */
export function locateColumns(header: readonly string[], lang: SheetLang): Layout {
  const names = HEADERS[lang];
  const refName = names[0]!;
  const refHits = header.reduce<number[]>((hits, cell, i) => (cell === refName ? [...hits, i] : hits), []);
  if (refHits.length !== 1) return { ok: false };
  const missing: string[] = [];
  const columns = names.map((name, i) => {
    if (i === 0) return refHits[0]!;
    const at = header.indexOf(name);
    if (at >= 0) return at;
    missing.push(name);
    return null;
  });
  return { ok: true, refColumn: refHits[0]!, columns, missing };
}

/** Values laid out by column position; `null` leaves a column that isn't ours untouched. */
export function layoutRow(columns: readonly (number | null)[], row: readonly CellValue[]): (CellValue | null)[] {
  const width = Math.max(...columns.map((c) => (c === null ? -1 : c))) + 1;
  const out = new Array<CellValue | null>(width).fill(null);
  columns.forEach((c, i) => {
    if (c !== null) out[c] = row[i]!;
  });
  return out;
}

/** First title not used by another tab: `Commandes`, `Commandes 2`, … */
export function freeTitle(lang: SheetLang, takenTitles: readonly string[]): string {
  const base = TAB_TITLE[lang];
  const taken = new Set(takenTitles);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

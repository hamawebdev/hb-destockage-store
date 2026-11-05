// Order fixtures for admin-orders tests (AORD-1..5): geo, a small catalogue, customers, orders.
// Rows go through Drizzle so the DB-1 CHECK constraints are exercised as in production.
import { eq } from 'drizzle-orm';
import { categories, communes, createDb, customers, orderEvents, orderItems, orders, products, variants, wilayas, type Db } from '@hb/db';
import type { OrderFlag, OrderStatus } from '@hb/shared';
import { form, type Harness } from '../helpers.ts';

export const GEO = {
  alger: { code: 16, nameFr: 'Alger', nameAr: 'الجزائر' },
  oran: { code: 31, nameFr: 'Oran', nameAr: 'وهران' },
  communes: {
    babEzzouar: { id: 1601, wilayaCode: 16, nameFr: 'Bab Ezzouar', nameAr: 'باب الزوار' },
    birElDjir: { id: 3101, wilayaCode: 31, nameFr: 'Bir El Djir', nameAr: 'بئر الجير' },
  },
} as const;

export interface CatalogFixture {
  productId: number;
  variantA: number;
  variantB: number;
}

export async function seedGeoAndCatalog(db: Db): Promise<CatalogFixture> {
  await db.insert(wilayas).values([GEO.alger, GEO.oran]);
  await db.insert(communes).values([GEO.communes.babEzzouar, GEO.communes.birElDjir]);
  const [cat] = await db
    .insert(categories)
    .values({ slugFr: 'cuisine', slugAr: 'matbakh', nameFr: 'Cuisine', nameAr: 'مطبخ' })
    .returning({ id: categories.id });
  const [prod] = await db
    .insert(products)
    .values({ categoryId: cat!.id, kind: 'variable', slugFr: 'pack-cuisine', slugAr: 'pack-matbakh', nameFr: 'Pack cuisine', nameAr: 'باك المطبخ' })
    .returning({ id: products.id });
  const [a, b] = await db
    .insert(variants)
    .values([
      { productId: prod!.id, sku: 'PK-CUI-01', priceDzd: 14_600, stock: 10, isDefault: true },
      { productId: prod!.id, sku: 'PK-CUI-02', priceDzd: 16_500, stock: null },
    ])
    .returning({ id: variants.id });
  return { productId: prod!.id, variantA: a!.id, variantB: b!.id };
}

export interface OrderSpec {
  ref: string;
  createdAt: number;
  status?: OrderStatus;
  name?: string;
  phone?: string;
  wilaya?: 'alger' | 'oran';
  flags?: string[];
  callAttempts?: number;
  feeDzd?: number;
  /** Lines: [variant key, qty]. Default one line of variant A. */
  items?: readonly (readonly ['A' | 'B', number])[];
  blockedCustomer?: boolean;
}

/** Inserts an order (and its customer, found or created by phone). Returns the order id. */
export async function insertOrder(db: Db, cat: CatalogFixture, s: OrderSpec): Promise<number> {
  const phone = s.phone ?? '+213560417403';
  const name = s.name ?? 'Amina Benali';
  let [cust] = await db.select({ id: customers.id }).from(customers).where(eq(customers.phoneE164, phone));
  if (!cust) {
    [cust] = await db.insert(customers).values({ phoneE164: phone, name, blocked: s.blockedCustomer ?? false }).returning({ id: customers.id });
  } else if (s.blockedCustomer !== undefined) {
    await db.update(customers).set({ blocked: s.blockedCustomer }).where(eq(customers.id, cust.id));
  }
  const lines = (s.items ?? [['A', 1]]).map(([k, qty]) => {
    const price = k === 'A' ? 14_600 : 16_500;
    return {
      variantId: k === 'A' ? cat.variantA : cat.variantB,
      productId: cat.productId,
      nameFr: k === 'A' ? 'Pack cuisine — Rouge' : 'Pack cuisine — Bleu',
      nameAr: k === 'A' ? 'باك المطبخ — أحمر' : 'باك المطبخ — أزرق',
      sku: k === 'A' ? 'PK-CUI-01' : 'PK-CUI-02',
      unitPriceDzd: price,
      qty,
      lineTotalDzd: price * qty,
    };
  });
  const subtotal = lines.reduce((t, l) => t + l.lineTotalDzd, 0);
  const fee = s.feeDzd ?? 600;
  const geo = s.wilaya === 'oran' ? { w: GEO.oran.code, c: GEO.communes.birElDjir.id } : { w: GEO.alger.code, c: GEO.communes.babEzzouar.id };
  const [o] = await db
    .insert(orders)
    .values({
      ref: s.ref,
      idempotencyKey: crypto.randomUUID(),
      customerId: cust!.id,
      name,
      phoneE164: phone,
      wilayaCode: geo.w,
      communeId: geo.c,
      lang: 'ar',
      status: s.status ?? 'new',
      callAttempts: s.callAttempts ?? 0,
      subtotalDzd: subtotal,
      feeDzd: fee,
      totalDzd: subtotal + fee,
      feeSource: 'table',
      // Unknown flags on purpose in some tests (shown raw): the column is typed OrderFlag[].
      flags: (s.flags ?? []) as OrderFlag[],
      createdAt: s.createdAt,
      updatedAt: s.createdAt,
    })
    .returning({ id: orders.id });
  await db.insert(orderItems).values(lines.map((l) => ({ ...l, orderId: o!.id })));
  return o!.id;
}

export function dbOf(d1: D1Database): Db {
  return createDb(d1);
}

/** Order refs use the Crockford-like alphabet (no I, L, O, U): this makes valid refs from a number. */
export function refOf(n: number): string {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let s = '';
  let x = n;
  for (let i = 0; i < 5; i++) {
    s = A[x % 32]! + s;
    x = Math.floor(x / 32);
  }
  return `HB-${s}`;
}

/** Appends an order event (the table is append-only; inserts are allowed). */
export async function insertEvent(
  db: Db,
  orderId: number,
  e: { type: 'created' | 'status_change' | 'call_attempt' | 'note'; at: number; outcome?: string; note?: string; from?: OrderStatus; to?: OrderStatus; actorUserId?: number },
): Promise<void> {
  await db.insert(orderEvents).values({
    orderId,
    type: e.type,
    at: e.at,
    outcome: e.outcome ?? null,
    note: e.note ?? null,
    fromStatus: e.from ?? null,
    toStatus: e.to ?? null,
    actorType: e.actorUserId === undefined ? 'customer' : 'admin',
    actorUserId: e.actorUserId ?? null,
  });
}

/**
 * POST a same-origin form as `email`. Same signature as admin-core's `postAs` (ADMIN-3, adds the
 * CSRF token); switch to a re-export of it once ADMIN-3 is merged here: every orders test POSTs
 * through this one function.
 */
export async function postAs(h: Harness, email: string | null, path: string, data: Record<string, string> = {}): Promise<Response> {
  return h.as(email, path, form(data));
}

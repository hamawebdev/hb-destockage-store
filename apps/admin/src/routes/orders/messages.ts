// Orders strings (admin-orders). French is the source; Arabic must have the same keys (compile
// error otherwise). Arabic strings are [PLACEHOLDER] until `brand` reviews the admin tone.
//
// `orderStatusLabel` / `orderStatusTone` are imported by admin-core's dashboard (ADMIN-5).

import type { OrderFlag, OrderStatus } from '@hb/shared';
import { defineMessages, type Lang } from '../../i18n/index.ts';
import type { Tone } from '../../ui/badge.tsx';

export const m = defineMessages({
  fr: {
    'status.new': 'Nouvelle',
    'status.called': 'Appelée',
    'status.confirmed': 'Confirmée',
    'status.unreachable': 'Injoignable',
    'status.cancelled': 'Annulée',
    'status.shipped': 'Expédiée',
    'status.delivered': 'Livrée',
    'status.returned': 'Retournée',
    'status.attempt': 'tentative {n}',

    'flag.honeypot': 'Piège anti-robot rempli',
    'flag.fast_fill': 'Remplie trop vite',
    'flag.fill_time_missing': 'Durée de saisie absente',
    'flag.turnstile_missing': 'Vérification anti-robot absente',
    'flag.turnstile_invalid': 'Vérification anti-robot invalide',
    'flag.duplicate': 'Doublon',
    'flag.rate_limited': 'Trop de commandes',
    'flag.blocked_customer': 'Client bloqué',

    'list.title': 'Commandes',
    'list.caption': 'Commandes, de la plus récente à la plus ancienne',
    'list.col.ref': 'Réf.',
    'list.col.date': 'Date',
    'list.col.customer': 'Client',
    'list.col.place': 'Wilaya / commune',
    'list.col.items': 'Articles',
    'list.col.fee': 'Livraison',
    'list.col.total': 'Total',
    'list.col.status': 'Statut',
    'list.col.flags': 'Alertes',
    'list.items.more': '{first} + {count, plural, one {# autre} other {# autres}}',
    'list.qty': '× {qty}',
    'list.blocked': 'Client bloqué',
    'list.empty': 'Aucune commande ne correspond à ces critères.',
    'list.more': 'Au moins {count} commandes : affinez les filtres ou passez à la page suivante.',

    'filter.legend': 'Filtrer les commandes',
    'filter.q': 'Recherche',
    'filter.q.hint': 'Téléphone, référence (HB-…) ou nom',
    'filter.status': 'Statut',
    'filter.status.any': 'Tous les statuts',
    'filter.wilaya': 'Wilaya',
    'filter.wilaya.any': 'Toutes les wilayas',
    'filter.from': 'Du',
    'filter.to': 'Au',
    'filter.flagged': 'Avec alerte',
    'filter.duplicate': 'Doublons',
    'filter.blocked': 'Clients bloqués',
    'filter.submit': 'Appliquer',
    'filter.reset': 'Réinitialiser',
    'filter.defaulted': 'Affichage par défaut pour votre rôle : {statuses}.',
    'filter.search.phone': 'Recherche par téléphone :',
    'filter.search.ref': 'Recherche par référence :',
    'filter.search.name': 'Recherche par nom « {term} ».',
    'filter.invalid': 'Certains filtres étaient invalides et ont été ignorés : {fields}.',
    'filter.invalid.status': 'statut',
    'filter.invalid.wilaya': 'wilaya',
    'filter.invalid.from': 'date de début',
    'filter.invalid.to': 'date de fin',
    'filter.invalid.range': 'période (début après la fin)',
    'filter.invalid.after': 'page',
  },
  // [PLACEHOLDER] Arabic admin strings — pending `brand` review.
  ar: {
    'status.new': 'جديد',
    'status.called': 'تم الاتصال',
    'status.confirmed': 'مؤكَّد',
    'status.unreachable': 'تعذّر الوصول',
    'status.cancelled': 'ملغى',
    'status.shipped': 'تم الشحن',
    'status.delivered': 'تم التسليم',
    'status.returned': 'مُرتجَع',
    'status.attempt': 'المحاولة {n}',

    'flag.honeypot': 'حقل المصيدة مملوء',
    'flag.fast_fill': 'مُلئ بسرعة كبيرة',
    'flag.fill_time_missing': 'مدة الملء غير متوفرة',
    'flag.turnstile_missing': 'التحقق من الروبوت غائب',
    'flag.turnstile_invalid': 'التحقق من الروبوت غير صالح',
    'flag.duplicate': 'طلب مكرَّر',
    'flag.rate_limited': 'طلبات كثيرة جدًا',
    'flag.blocked_customer': 'زبون محظور',

    'list.title': 'الطلبات',
    'list.caption': 'الطلبات من الأحدث إلى الأقدم',
    'list.col.ref': 'المرجع',
    'list.col.date': 'التاريخ',
    'list.col.customer': 'الزبون',
    'list.col.place': 'الولاية / البلدية',
    'list.col.items': 'المنتجات',
    'list.col.fee': 'التوصيل',
    'list.col.total': 'المجموع',
    'list.col.status': 'الحالة',
    'list.col.flags': 'تنبيهات',
    'list.items.more': '{first} + {count, plural, zero {# آخر} one {# آخر} two {# آخران} few {# أخرى} many {# آخر} other {# آخر}}',
    'list.qty': '× {qty}',
    'list.blocked': 'زبون محظور',
    'list.empty': 'لا توجد طلبات مطابقة لهذه المعايير.',
    'list.more': '{count} طلبًا على الأقل: ضيّق التصفية أو انتقل إلى الصفحة التالية.',

    'filter.legend': 'تصفية الطلبات',
    'filter.q': 'بحث',
    'filter.q.hint': 'الهاتف أو المرجع (HB-…) أو الاسم',
    'filter.status': 'الحالة',
    'filter.status.any': 'كل الحالات',
    'filter.wilaya': 'الولاية',
    'filter.wilaya.any': 'كل الولايات',
    'filter.from': 'من',
    'filter.to': 'إلى',
    'filter.flagged': 'مع تنبيه',
    'filter.duplicate': 'المكرَّرة',
    'filter.blocked': 'زبائن محظورون',
    'filter.submit': 'تطبيق',
    'filter.reset': 'إعادة الضبط',
    'filter.defaulted': 'العرض الافتراضي لدورك: {statuses}.',
    'filter.search.phone': 'بحث بالهاتف:',
    'filter.search.ref': 'بحث بالمرجع:',
    'filter.search.name': 'بحث بالاسم «{term}».',
    'filter.invalid': 'بعض عوامل التصفية غير صالحة وتم تجاهلها: {fields}.',
    'filter.invalid.status': 'الحالة',
    'filter.invalid.wilaya': 'الولاية',
    'filter.invalid.from': 'تاريخ البداية',
    'filter.invalid.to': 'تاريخ النهاية',
    'filter.invalid.range': 'الفترة (البداية بعد النهاية)',
    'filter.invalid.after': 'الصفحة',
  },
});

export type OrdersMessages = ReturnType<typeof m>;

/** Order status label in the UI language (dashboard and orders screens). */
export function orderStatusLabel(lang: Lang, status: OrderStatus): string {
  return m(lang)(`status.${status}`);
}

/** Badge tone per status: colour reinforces the text, never replaces it. */
export function orderStatusTone(status: OrderStatus): Tone {
  switch (status) {
    case 'new':
      return 'info';
    case 'called':
    case 'unreachable':
      return 'warning';
    case 'confirmed':
    case 'delivered':
      return 'success';
    case 'shipped':
      return 'info';
    case 'returned':
      return 'danger';
    case 'cancelled':
      return 'neutral';
  }
}

/** Flags that mean "do not ship without a careful look". */
const DANGER_FLAGS: ReadonlySet<string> = new Set<OrderFlag>(['honeypot', 'blocked_customer']);

export function orderFlagTone(flag: string): Tone {
  return DANGER_FLAGS.has(flag) ? 'danger' : 'warning';
}

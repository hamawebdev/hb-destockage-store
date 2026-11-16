import { formatPrice } from '../shared.ts';
import type { OrderCreatedMessage } from './message.ts';
import type { StaffNotification } from './provider.ts';

export type StaffLang = 'fr' | 'ar';

// Staff-facing EMAIL text. Deliberately minimal: ref, total, wilaya, flags. Staff open the admin
// for the customer's name, phone and items; none of those ever reach email.
// Telegram is different since D-022: the owner ticks which details a message carries
// (@hb/shared formatTelegramOrder, ./telegram.ts).
// Wilaya names: TODO when data/geo lands (GEO); the code alone is unambiguous for staff.
export function formatOrderCreated(m: OrderCreatedMessage, lang: StaffLang = 'fr'): StaffNotification {
  const total = formatPrice(m.totalDzd, lang);
  const wilaya = String(m.wilayaCode).padStart(2, '0');
  if (lang === 'ar') {
    const lines = [`طلب جديد ${m.ref}`, `المجموع: ${total}`, `الولاية: ${wilaya}`];
    if (m.flags.length) lines.push(`تنبيهات: ${m.flags.join(', ')}`);
    return { id: `order-${m.orderId}`, subject: `طلب جديد ${m.ref}`, text: lines.join('\n') };
  }
  const lines = [`Nouvelle commande ${m.ref}`, `Total : ${total}`, `Wilaya : ${wilaya}`];
  if (m.flags.length) lines.push(`Signalements : ${m.flags.join(', ')}`);
  return { id: `order-${m.orderId}`, subject: `Nouvelle commande ${m.ref}`, text: lines.join('\n') };
}

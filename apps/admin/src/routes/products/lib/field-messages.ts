// Field-error and shared catalogue strings used by every admin-catalog router (ACAT-0 plan §11).
// Arabic strings: [PLACEHOLDER] until `brand` reviews the admin tone.
import { defineMessages } from '../../../i18n/index.ts';
import type { SlugError } from './slug.ts';
import type { TextError } from './text.ts';

export const fieldMessages = defineMessages({
  fr: {
    'err.unsafe_char': 'Caractère interdit (caractère de contrôle ou d’inversion de sens).',
    'err.slug_required': 'Slug obligatoire.',
    'err.slug_too_long': 'Slug trop long (80 caractères maximum).',
    'err.slug_format': 'Lettres minuscules non accentuées, chiffres et tirets uniquement (ex. « poele-28-cm »).',
    'err.slug_reserved': 'Ce slug est réservé par le site.',
    'err.slug_taken': 'Ce slug est déjà utilisé.',
    'err.stale': 'Cet élément a été modifié entre-temps par quelqu’un d’autre. Rechargez la page.',
    'common.placeholder': 'Provisoire',
    'common.translationPlaceholderFr': 'Traduction française provisoire',
    'common.translationPlaceholderAr': 'Traduction arabe provisoire',
    'common.placeholderHint': 'Contenu d’exemple à remplacer avant la mise en ligne.',
    'common.slugHint': 'Laisser vide pour générer à partir du nom.',
  },
  ar: {
    'err.unsafe_char': 'حرف غير مسموح (حرف تحكم أو قلب اتجاه).',
    'err.slug_required': 'المعرّف (slug) إلزامي.',
    'err.slug_too_long': 'المعرّف طويل جدًا (80 حرفًا كحد أقصى).',
    'err.slug_format': 'حروف لاتينية صغيرة وأرقام وشرطات فقط (مثال: «poele-28-cm»).',
    'err.slug_reserved': 'هذا المعرّف محجوز للموقع.',
    'err.slug_taken': 'هذا المعرّف مستخدم من قبل.',
    'err.stale': 'عدّل شخص آخر هذا العنصر في الأثناء. أعد تحميل الصفحة.',
    'common.placeholder': 'مؤقت',
    'common.translationPlaceholderFr': 'الترجمة الفرنسية مؤقتة',
    'common.translationPlaceholderAr': 'الترجمة العربية مؤقتة',
    'common.placeholderHint': 'محتوى تجريبي يجب استبداله قبل النشر.',
    'common.slugHint': 'اتركه فارغًا لتوليده من الاسم.',
  },
});

export type FieldMessageKey = Parameters<ReturnType<typeof fieldMessages>>[0];

export const slugErrorKey = (e: SlugError): FieldMessageKey => `err.slug_${e}`;
export const textErrorKey = (e: TextError): FieldMessageKey => `err.${e}`;

/** Test fixtures for the order components (until CAT-3 ships generated props fixtures). Owner: orderform. */
import type { ContactProps, Lang, OrderFormProps, StringTable, VariantProps } from '@hb/catalog';
import ar from '../../../../../../brand/copy/strings.ar.json' with { type: 'json' };
import fr from '../../../../../../brand/copy/strings.fr.json' with { type: 'json' };

export const strings: Record<Lang, StringTable> = { ar: ar as StringTable, fr: fr as StringTable };

export const contact: ContactProps = {
  phoneDisplay: '0560417403',
  phoneHref: 'tel:+213560417403',
  whatsappDisplay: '+213 779 942 022',
  whatsappHref: 'https://wa.me/213779942022',
  email: null,
};

const fmt = (n: number, lang: Lang) =>
  new Intl.NumberFormat(lang === 'ar' ? 'ar-DZ' : 'fr-DZ', { style: 'currency', currency: 'DZD', maximumFractionDigits: 0 }).format(n);

function variant(id: number, price: number, maxQty: number, lang: Lang, extra: Partial<VariantProps> = {}): VariantProps {
  return {
    id,
    sku: `SKU-${id}`,
    optionValueIds: [],
    key: '',
    label: '',
    price: { amountDzd: price, label: fmt(price, lang), compareAtDzd: null, compareAtLabel: null, discountPercent: null, from: false },
    stock: { state: maxQty === 0 ? 'out_of_stock' : 'in_stock', qty: maxQty === 10 ? null : maxQty },
    imageIndex: null,
    imageIndexes: [],
    isDefault: false,
    available: maxQty > 0,
    maxQty,
    ...extra,
  };
}

const wilayas = (lang: Lang) =>
  Array.from({ length: 69 }, (_, i) => ({ code: i + 1, label: `${i + 1} - ${lang === 'ar' ? 'ولاية' : 'Wilaya'} ${i + 1}` }));

export function singleForm(lang: Lang, over: Partial<OrderFormProps> = {}): OrderFormProps {
  return {
    productId: 7,
    kind: 'pack',
    singleVariant: true,
    defaultVariantId: 12,
    variants: [variant(12, 14600, 10, lang, { isDefault: true })],
    options: [],
    wilayas: wilayas(lang),
    communesUrlTemplate: `/geo/communes/${lang}/{code}.json`,
    quoteEndpoint: '/api/quote',
    orderEndpoint: '/api/order',
    confirmationHref: `/${lang}/order/confirmation/`,
    turnstileSiteKey: null,
    qty: { min: 1, max: 10 },
    orderable: true,
    ...over,
  };
}

export function variableForm(lang: Lang): OrderFormProps {
  return singleForm(lang, {
    productId: 9,
    kind: 'variable',
    singleVariant: false,
    defaultVariantId: 21,
    variants: [
      variant(21, 3200, 3, lang, { isDefault: true, label: lang === 'ar' ? 'أحمر / L' : 'Rouge / L', optionValueIds: [1, 3], key: '1-3' }),
      variant(22, 3400, 0, lang, { label: lang === 'ar' ? 'أزرق / L' : 'Bleu / L', optionValueIds: [2, 3], key: '2-3' }),
    ],
    options: [
      { id: 1, type: 'colour', name: lang === 'ar' ? 'اللون' : 'Couleur', values: [] },
      { id: 2, type: 'size', name: lang === 'ar' ? 'المقاس' : 'Taille', values: [] },
    ],
    turnstileSiteKey: '0x4AAAAAAA-test',
  });
}

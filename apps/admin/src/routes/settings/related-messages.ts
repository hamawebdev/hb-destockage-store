// Strings for the "you may also like" switch on /settings (BOOT-45, D-030). Same keys as cart-messages.ts: both cards
// are drawn by StorefrontSwitch. The section's own titles are quoted as shoppers see them on the product page.
import { defineMessages } from '../../i18n/index.ts';

export const rm = defineMessages({
  fr: {
    'title': '« Vous aimerez aussi » sur les pages produit',
    'intro': 'Sous chaque produit, la section « Vous aimerez aussi » (« قد يعجبك أيضاً » en arabe) montre d’autres produits de la boutique : photo, marque, nom, prix et bouton « Commander ». Le réglage vaut pour les deux langues.',
    'legend': 'Section « Vous aimerez aussi »',
    'on': 'Affichée',
    'on.hint': 'La section apparaît sous chaque produit, en français et en arabe.',
    'off': 'Masquée',
    'off.hint': 'Aucune page produit n’affiche la section, en français comme en arabe.',
    'current.on': 'Réglage enregistré : section affichée.',
    'current.off': 'Réglage enregistré : section masquée.',
    'note.lead': 'Prend effet à la prochaine publication.',
    'note': 'Après avoir enregistré, publiez le site pour que les clients voient le changement : Publier → « Publier la boutique » (environ 10 minutes). Jusque-là, le site reste comme avant.',
    'note.link': 'Publier le site',
    'save': 'Enregistrer',
    'invalid': 'Choisissez « Affichée » ou « Masquée ».',
  },
  ar: {
    'title': 'قسم «قد يعجبك أيضاً» في صفحات المنتجات',
    'intro': 'تحت كل منتج، يعرض قسم «قد يعجبك أيضاً» («Vous aimerez aussi» بالفرنسية) منتجات أخرى من المتجر: الصورة والعلامة والاسم والسعر وزر «اطلب الآن». الإعداد يسري على اللغتين.',
    'legend': 'قسم «قد يعجبك أيضاً»',
    'on': 'ظاهر',
    'on.hint': 'يظهر القسم تحت كل منتج، بالعربية والفرنسية.',
    'off': 'مخفي',
    'off.hint': 'لا يظهر القسم في أي صفحة منتج، بالعربية ولا بالفرنسية.',
    'current.on': 'الإعداد المحفوظ: القسم ظاهر.',
    'current.off': 'الإعداد المحفوظ: القسم مخفي.',
    'note.lead': 'يسري التغيير عند النشر القادم.',
    'note': 'بعد الحفظ، انشر الموقع حتى يرى الزبائن التغيير: «النشر» ← «نشر المتجر» (نحو 10 دقائق). إلى ذلك الحين يبقى الموقع كما كان.',
    'note.link': 'نشر الموقع',
    'save': 'حفظ',
    'invalid': 'اختر «ظاهر» أو «مخفي».',
  },
});

// Strings for the storefront cart switch on /settings (CART-2). Arabic: [PLACEHOLDER] until `brand` reviews the admin tone.
import { defineMessages } from '../../i18n/index.ts';

export const cm = defineMessages({
  fr: {
    'title': 'Panier de la boutique',
    'intro': 'Avec le panier, le client peut commander plusieurs produits en une fois. Sans panier, chaque produit a un bouton « Commander » qui ouvre directement son bon de commande.',
    'legend': 'Panier',
    'on': 'Activé',
    'on.hint': 'Bouton panier dans l’en-tête, « Ajouter au panier » sur les produits, page de commande du panier.',
    'off': 'Désactivé',
    'off.hint': 'Aucun panier sur le site. Un bouton « Commander » sous chaque produit mène à son bon de commande.',
    'current.on': 'Réglage enregistré : panier activé.',
    'current.off': 'Réglage enregistré : panier désactivé.',
    'note.lead': 'Prend effet à la prochaine publication.',
    'note': 'Le site ne change qu’après la prochaine publication. Les commandes passées entre-temps, panier ou produit seul, sont toutes acceptées.',
    'note.link': 'Publier le site',
    'save': 'Enregistrer le panier',
    'invalid': 'Choisissez « Activé » ou « Désactivé ».',
  },
  ar: {
    'title': 'سلة المتجر',
    'intro': 'مع السلة يطلب الزبون عدة منتجات دفعة واحدة. بدون سلة يكون لكل منتج زر «اطلب» يفتح استمارة طلبه مباشرة.',
    'legend': 'السلة',
    'on': 'مفعّلة',
    'on.hint': 'زر السلة في أعلى الصفحة، و«أضف إلى السلة» على المنتجات، وصفحة طلب السلة.',
    'off': 'معطّلة',
    'off.hint': 'لا سلة في الموقع. زر «اطلب» تحت كل منتج يؤدي إلى استمارة طلبه.',
    'current.on': 'الإعداد المحفوظ: السلة مفعّلة.',
    'current.off': 'الإعداد المحفوظ: السلة معطّلة.',
    'note.lead': 'يسري التغيير عند النشر القادم.',
    'note': 'لا يتغير الموقع إلا بعد النشر القادم. الطلبات المرسلة في الأثناء، من السلة أو لمنتج واحد، تُقبل كلها.',
    'note.link': 'نشر الموقع',
    'save': 'حفظ إعداد السلة',
    'invalid': 'اختر «مفعّلة» أو «معطّلة».',
  },
});

export type CartMessage = Parameters<ReturnType<typeof cm>>[0];

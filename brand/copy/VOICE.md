# Tone of voice — HB Destockage

HB Destockage sells good products at clearance prices to customers all over Algeria, who pay cash on
delivery after a confirmation call. The voice does what the visual design does: **calm, clear, sure of
itself**. It sounds like a helpful shop assistant who knows the products and respects your time —
never a market crier.

## Four principles (both languages)

1. **Clear before clever.** Short sentences, one idea each. The customer must understand price, fee,
   total and next step without rereading.
2. **Reassure with facts, not adjectives.** "Payez à la réception", "69 wilayas", "nous vous appelons
   avant l'envoi" build trust. "Meilleure qualité garantie !!!" does not.
3. **Calm.** No exclamation marks, no capitals for shouting, no countdowns, no fake urgency, no emoji.
   Low stock is stated once, plainly ("Plus que 3 en stock").
4. **Respectful and warm.** Address the customer directly; thank them once, at the end. Errors explain
   what happened and what to do, and never blame ("Ce numéro n'est pas valide", not "Vous avez fait une erreur").

## Arabic (primary)

- **Modern Standard Arabic**, plain and warm — not classical, not dialect. Understood from Tlemcen to
  Tamanrasset. Address the customer in the masculine singular imperative (اطلب، اختر، ادفع), which is the
  neutral convention in Arabic UI.
- **Use the commerce words Algerians already use:** «الدفع عند الاستلام», «سعر التوصيل», «الولاية»,
  «البلدية», «طلب» / «تأكيد الطلب», «عامل التوصيل», «الطرد», «طقم» (pack/set), «تخفيض», «نفدت الكمية».
  Write «واتساب».
- **Algerian month names** when a date is written out: جانفي، فيفري، مارس، أفريل، ماي، جوان، جويلية، أوت،
  سبتمبر، أكتوبر، نوفمبر، ديسمبر. `Intl.DateTimeFormat('ar-DZ')` produces them — never hand-write dates.
- **Western digits** (0–9), as in Algeria (`Intl` `ar-DZ`). Prices: `Intl.NumberFormat('ar-DZ', {style:'currency', currency:'DZD', maximumFractionDigits:0})`.
- **Bidi:** phone numbers, order refs, SKUs, Latin brand and product names go inside `<bdi>` (`dir="ltr"`
  for numbers). In copy files, example numbers inside Arabic sentences are written **without spaces**
  (0550123456): spaced digit groups reorder in RTL.
- **Plurals:** Arabic has six forms. Every count string has `.zero .one .two .few .many .other`; one and
  two spell the number out (منتج واحد، منتجان). Don't write "{count} منتج(ات)".
- **Punctuation:** Arabic comma «،», question mark «؟», guillemets «…» for quotes. No letter-spacing, no
  bold webfont: emphasis comes from size and colour.
- **The brand name stays Latin:** HB Destockage (in `<bdi lang="fr">` inside Arabic text). Never transliterate it.

| Do | Don't |
|---|---|
| اطلب الآن، وادفع عند الاستلام. | !!! اطلب بسرعة قبل نفاد الكمية |
| رقم الهاتف غير صحيح. اكتب رقم هاتف محمول جزائري من 10 أرقام، مثل 0550123456. | خطأ في الإدخال |
| بقيت قطعتان فقط | آخر فرصة!!! |
| نتصل بك لتأكيد الطلب قبل الإرسال. | سيتم التواصل معكم في أقرب الآجال إن شاء الله |
| التوصيل إلى 69 ولاية | توصيل لجميع ولايات الوطن 58 (outdated count) |

## French

- **Vouvoiement** always. Short, active sentences. Imperative for actions ("Choisissez votre wilaya"),
  present tense for promises ("Nous vous appelons").
- Algerian commerce vocabulary: « paiement à la livraison », « frais de livraison », « wilaya »,
  « commune », « livreur », « colis », « pack ». "Wilaya" is a French word here (no italics, plural « wilayas »).
- French typography: non-breaking space before « : ; ? » and inside « guillemets », « 9 h », « −20 % ».
  Prices via `Intl.NumberFormat('fr-DZ', …)` → « 14 600 DA ».
- No anglicisms when a common French word exists (« Commander », not « Checkout »; « Promo », not « Sale »).

| Do | Don't |
|---|---|
| Payez à la réception. Livraison dans les 69 wilayas. | PAIEMENT À LA LIVRAISON !!! |
| Ce numéro n'est pas valide. Saisissez un mobile algérien à 10 chiffres. | Numéro incorrect !! |
| Plus que 3 en stock | Dépêchez-vous, il n'en reste presque plus ! |
| Confirmer la commande | Valider ! / Go |
| Tu peux commander… (tutoiement) | — never |

## Microcopy patterns

- **Buttons** are verbs: Commander / اطلب الآن · Confirmer la commande / تأكيد الطلب · Voir les produits / تصفّح المنتجات.
- **Errors**: what is wrong + how to fix it, one sentence each, next to the field. Server failures say
  the order was **not** recorded and give the phone number.
- **Empty states**: say what's missing and offer one way forward.
- **Hints** (`order.*.hint`) say why we ask: the phone is for the confirmation call.
- **Prices** are always integers in DZD, formatted by `Intl`; the total is labelled "à payer à la
  livraison / المستحق عند الاستلام" so nobody expects online payment.

## Placeholders

Anything not yet confirmed by the client carries **[PLACEHOLDER]** in the string or `placeholder: true`
in data. A production build with `HB_STRICT_COPY=1`
refuses such strings, except the `dev.*` keys, which exist to label placeholders in development builds.

## Files

- `strings.ar.json`, `strings.fr.json`: flat dotted keys, identical sets (tested by `brand/test/strings.test.mjs`).
- Content pages (about, delivery, returns, contact, privacy, terms): `data/content/<key>.json`.

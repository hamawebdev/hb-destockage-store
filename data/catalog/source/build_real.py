# Generator for the real (client) part of the seed catalogue, written from data/catalog/source/
# (SEED-1 scrape). Usage: python3 -I data/catalog/source/build_real.py data/catalog
# Writes categories.json, settings.json, provenance.json and products/<fr-slug>.json for ids 1–199.
# The JSON files are the source of truth; this script documents how they were derived. If you edit
# the JSON by hand, edit this script too or stop using it.
import json, os, sys
OUT = sys.argv[1]
FETCH = '2026-11-04'
SRC = 'https://hbdestockagedz.com/produit/'

def L(ar, fr): return {'ar': ar, 'fr': fr}

categories = [
    dict(id=1, parentId=None, slug=L('al-hammam', 'salle-de-bain'), name=L('الحمّام', 'Salle de bain'),
         description=L('كل ما يلزم لحمّام عصري: أطقم الاستحمام والخلّاطات والحنفيات.',
                       'Tout pour une salle de bain moderne : packs de douche, mitigeurs et robinetterie.'),
         sort=10, active=True, placeholder=False, translationPlaceholder=['ar', 'fr']),
    dict(id=11, parentId=1, slug=L('atqum-al-hammam', 'packs-salle-de-bain'), name=L('أطقم الحمّام', 'Packs salle de bain'),
         description=L('أطقم كاملة: عمود استحمام وخلّاط مغسلة وحنفية مرحاض بسعر واحد.',
                       'Packs complets : colonne de douche, mitigeur de lavabo et robinet de toilette à prix unique.'),
         sort=10, active=True, placeholder=False, translationPlaceholder=['ar', 'fr']),
    dict(id=12, parentId=1, slug=L('al-hanafiyat', 'robinetterie'), name=L('الحنفيات والخلّاطات', 'Robinetterie'),
         description=L('القطع الموجودة في الأطقم. غير معروضة للبيع منفردة حاليًا.',
                       'Les pièces contenues dans les packs. Pas encore vendues à l’unité.'),
         sort=20, active=False, placeholder=False, translationPlaceholder=['ar', 'fr']),
]

def variant(pid, n, sku, price, compare=None, stock=None, default=True, opts=()):
    return dict(id=pid * 100 + n, sku=sku, priceDzd=price, compareAtDzd=compare, stock=stock, weightG=None,
                active=True, isDefault=default, optionValueIds=list(opts))

def product(**kw):
    base = dict(brandLatin=None, options=[], packItems=[], images=[], placeholder=False, translationPlaceholder=['ar'], source=None)
    base.update(kw)
    order = ['id', 'kind', 'categoryId', 'status', 'sort', 'slug', 'name', 'brandLatin', 'summary', 'description',
             'placeholder', 'translationPlaceholder', 'options', 'variants', 'packItems', 'images']
    PROV[base['id']] = base['source']
    return {k: base[k] for k in order}

def src(slugs, note):
    return dict(urls=[SRC + s + '/' for s in slugs], fetchedAt=FETCH, note=note)

P = []
PROV = {}
# --- components (not sold alone on the client site: draft, placeholder prices) ---
P.append(product(
    id=111, kind='variable', categoryId=12, status='draft', sort=10, placeholder=True,
    slug=L('amoud-istihmam-piano', 'colonne-de-douche-piano'),
    name=L('عمود الاستحمام «بيانو»', 'Colonne de douche Piano'),
    summary=L('عمود استحمام «بيانو» بلوحة تحكّم، متوفّر بحجمين.', 'Colonne de douche Piano à panneau de commande, en deux modèles.'),
    description=L('الحجم الكبير: شاشة رقمية لدرجة حرارة الماء وإضاءة LED، هيكل من الألومنيوم.\n\nالحجم الصغير: النسخة الأبسط من نفس العمود.\n\n[PLACEHOLDER] السعر المنفرد غير محدّد: القطعة تُباع حاليًا ضمن الأطقم فقط.',
                  'Grand modèle : afficheur digital de température et éclairage LED, en aluminium.\n\nPetit modèle : la version simple de la même colonne.\n\n[PLACEHOLDER] Prix à l’unité non fixé : la pièce est vendue aujourd’hui uniquement dans les packs.'),
    options=[dict(id=1111, type='other', name=L('الطراز', 'Modèle'), position=1, values=[
        dict(id=111101, value=L('كبير – شاشة وإضاءة LED', 'Grand modèle – afficheur et LED'), swatchHex=None, position=1),
        dict(id=111102, value=L('صغير', 'Petit modèle'), swatchHex=None, position=2)])],
    variants=[variant(111, 1, 'HB-COL-PIANO-GM', 9000, opts=[111101]),
              variant(111, 2, 'HB-COL-PIANO-PM', 7500, default=False, opts=[111102])],
    source=src(['pack-a-et-b', 'nouvelle-pack-luxury-4en1-douche-prix-16500-da-livraison-60-alf'],
               'Component named in the pack descriptions ("grand modele avec led et afficheur" / "petit modele"). Prices are placeholders.'),
))
P.append(product(
    id=112, kind='simple', categoryId=12, status='draft', sort=20, placeholder=True,
    slug=L('khallat-al-maghsala', 'mitigeur-lavabo'), name=L('خلّاط المغسلة', 'Mitigeur de lavabo'),
    summary=L('خلّاط مغسلة أسود بتصميم عصري، مع الخرطوم المرن وقطع التثبيت.', 'Mitigeur de lavabo noir au design moderne, flexible et fixations inclus.'),
    description=L('تصميم راقٍ وعصري.\n\nالخرطوم المرن وقطع التثبيت مرفقة.\n\n[PLACEHOLDER] السعر المنفرد غير محدّد.',
                  'Design raffiné et moderne.\n\nFlexible et fixations inclus.\n\n[PLACEHOLDER] Prix à l’unité non fixé.'),
    variants=[variant(112, 1, 'HB-MIT-LAV', 3000)],
    source=src(['pack-3-en-1'], 'Component of the packs ("Mitigeur de lavabo haut de gamme"). Price is a placeholder.'),
))
P.append(product(
    id=113, kind='simple', categoryId=12, status='draft', sort=30, placeholder=True,
    slug=L('hanafiyat-al-mirhad-maa-shattaf', 'robinet-toilette-douchette'), name=L('حنفية المرحاض مع شطّاف', 'Robinet de toilette avec douchette'),
    summary=L('حنفية للمرحاض مع شطّاف يدوي بخرطوم قابل للتمديد.', 'Robinet pour toilette avec douchette à flexible extensible.'),
    description=L('شطّاف يدوي بخرطوم قابل للتمديد، عملي ومريح.\n\nلراحة ونظافة أفضل.\n\n[PLACEHOLDER] السعر المنفرد غير محدّد.',
                  'Douchette extensible et pratique.\n\nIdéal pour plus de confort et d’hygiène.\n\n[PLACEHOLDER] Prix à l’unité non fixé.'),
    variants=[variant(113, 1, 'HB-ROB-WC', 2500)],
    source=src(['pack-3-en-1'], 'Component of the packs ("Robinet pour toilette"). Price is a placeholder.'),
))
P.append(product(
    id=114, kind='simple', categoryId=12, status='draft', sort=40, placeholder=True,
    slug=L('khallat-al-matbakh', 'mitigeur-cuisine'), name=L('خلّاط المطبخ', 'Mitigeur de cuisine'),
    summary=L('خلّاط مطبخ أسود بعنق مرتفع.', 'Mitigeur de cuisine noir à bec haut.'),
    description=L('خلّاط للمطبخ ضمن الطقم الفاخر 4 في 1.\n\n[PLACEHOLDER] السعر المنفرد غير محدّد.',
                  'Mitigeur de cuisine du pack luxe 4 en 1.\n\n[PLACEHOLDER] Prix à l’unité non fixé.'),
    variants=[variant(114, 1, 'HB-MIT-CUIS', 3500)],
    source=src(['nouvelle-pack-luxury-4en1-douche-prix-16500-da-livraison-60-alf'], 'Component of the 4-in-1 pack ("mitigeur cuisine"). Price is a placeholder.'),
))
# --- the three packs actually on sale ---
P.append(product(
    id=101, kind='pack', categoryId=11, status='active', sort=10,
    slug=L('taqm-al-hammam-a-3-fi-1-piano-led', 'pack-a-3-en-1-colonne-piano-led'),
    name=L('طقم الحمّام A 3 في 1 – عمود «بيانو» بإضاءة LED', 'Pack A 3 en 1 – colonne de douche Piano LED'),
    summary=L('عمود استحمام «بيانو» كبير بشاشة رقمية وإضاءة LED، وخلّاط للمغسلة، وحنفية للمرحاض مع شطّاف.',
              'Colonne de douche Piano grand modèle avec afficheur digital et LED, mitigeur de lavabo et robinet de toilette avec douchette.'),
    description=L('طقم 3 في 1 – أناقة وراحة لحمّامك.\n\nعمود الاستحمام «بيانو» (الحجم الكبير): شاشة رقمية لدرجة حرارة الماء، إضاءة LED، وتصميم عصري وأنيق.\n\nخلّاط مغسلة عالي الجودة: تصميم راقٍ وعصري، مع الخرطوم المرن وقطع التثبيت.\n\nحنفية المرحاض: شطّاف يدوي بخرطوم قابل للتمديد، عملي ومريح لنظافة أفضل.',
                  'Pack 3 en 1 – élégance et confort pour votre salle de bain.\n\nColonne de douche Piano (grand modèle) : afficheur digital de température, éclairage LED d’ambiance, design moderne et élégant.\n\nMitigeur de lavabo haut de gamme : design raffiné et moderne, flexible et fixations inclus.\n\nRobinet pour toilette : douchette extensible et pratique, idéal pour plus de confort et d’hygiène.'),
    variants=[variant(101, 1, 'HB-PACK-A', 14600, 17900)],
    packItems=[dict(variantId=11101, qty=1), dict(variantId=11201, qty=1), dict(variantId=11301, qty=1)],
    source=dict(urls=[SRC + s + '/' for s in ['pack-3-en-1', 'sans-titre', 'pack-a-et-b', 'pack']], fetchedAt=FETCH,
                note='Merges WC 4271 "Pack 3 en 1" (French description used), 4435 "Promotion", 4440 "Pack A et B" (pack A) and 4465 "Pack" (pack A): same three pieces, all 14 600 DA. Compare-at 17 900 (4271/4435/4440; 4465 says 18 900). Delivery text dropped: fees now come from /api/quote.'),
))
P.append(product(
    id=102, kind='pack', categoryId=11, status='active', sort=20,
    slug=L('taqm-al-hammam-b-3-fi-1-piano', 'pack-b-3-en-1-colonne-piano'),
    name=L('طقم الحمّام B 3 في 1 – عمود «بيانو» صغير', 'Pack B 3 en 1 – colonne de douche Piano petit modèle'),
    summary=L('عمود استحمام «بيانو» بالحجم الصغير، وخلّاط للمغسلة، وحنفية للمرحاض مع شطّاف.',
              'Colonne de douche Piano petit modèle, mitigeur de lavabo et robinet de toilette avec douchette.'),
    description=L('طقم 3 قطع بسعر أقل.\n\nعمود الاستحمام «بيانو» (الحجم الصغير).\n\nخلّاط المغسلة.\n\nحنفية المرحاض مع شطّاف.',
                  'Pack 3 pièces à petit prix.\n\nColonne de douche Piano (petit modèle).\n\nMitigeur de lavabo.\n\nRobinet de toilette avec douchette.'),
    variants=[variant(102, 1, 'HB-PACK-B', 13600)],
    packItems=[dict(variantId=11102, qty=1), dict(variantId=11201, qty=1), dict(variantId=11301, qty=1)],
    source=dict(urls=[SRC + 'pack-a-et-b/', SRC + 'pack/'], fetchedAt=FETCH,
                note='Pack B exists only in the description text of WC 4440 and 4465 ("pack B : prix 13600 DA, colonne de douche piano petit modele + lavabo + toilette"); it could not be ordered separately on the old site. No compare-at price was published for it.'),
))
P.append(product(
    id=103, kind='pack', categoryId=11, status='active', sort=30,
    slug=L('al-taqm-al-fakhir-4-fi-1', 'pack-luxe-4-en-1'),
    name=L('الطقم الفاخر 4 في 1 – الاستحمام والمغسلة والمطبخ والمرحاض', 'Pack luxe 4 en 1 – douche, lavabo, cuisine et toilette'),
    summary=L('عمود استحمام «بيانو» من الألومنيوم بشاشة وإضاءة LED، وخلّاط للمغسلة، وخلّاط للمطبخ، وحنفية للمرحاض.',
              'Colonne de douche Piano en aluminium avec afficheur et LED, mitigeur de lavabo, mitigeur de cuisine et robinet de toilette.'),
    description=L('الطقم الفاخر 4 في 1.\n\nعمود الاستحمام «بيانو» من الألومنيوم، بشاشة وإضاءة LED.\n\nخلّاط المغسلة.\n\nخلّاط المطبخ.\n\nحنفية المرحاض مع شطّاف.',
                  'Pack luxe 4 en 1.\n\nColonne de douche Piano en aluminium avec afficheur et LED.\n\nMitigeur de lavabo.\n\nMitigeur de cuisine.\n\nRobinet pour toilette.'),
    variants=[variant(103, 1, 'HB-PACK-LUXE-4EN1', 16500, 19900)],
    packItems=[dict(variantId=11101, qty=1), dict(variantId=11201, qty=1), dict(variantId=11401, qty=1), dict(variantId=11301, qty=1)],
    source=dict(urls=[SRC + 'nouvelle-pack-luxury-4en1-douche-prix-16500-da-livraison-60-alf/'], fetchedAt=FETCH,
                note='WC 20. Title "nouvelle pack luxury 4en1 douche — prix 16500 DA — livraison 60 alf" shortened; "60 alf" = 600 DA delivery, dropped (fees come from /api/quote).'),
))

# --- images (SEED-3). Files in data/photos/, EXIF stripped losslessly (jpegtran -copy icc), Display P3 ICC kept.
UP = 'https://hbdestockagedz.com/wp-content/uploads/'
IMG = {}   # product id -> list of (key, w, h, alt_ar, alt_fr, provenance)
def img(pid, key, w, h, ar, fr, wp, url, kind, price):
    IMG.setdefault(pid, []).append(dict(key=key, w=w, h=h, ar=ar, fr=fr, prov=dict(
        wpMediaId=wp, sourceUrl=url, source=kind, needsClientConfirmation=(kind == 'supplier_render'), burnedInPrice=price)))
A, B, C, LX = 'pack-a-3-en-1-colonne-piano-led/', 'pack-b-3-en-1-colonne-piano/', 'colonne-de-douche-piano/', 'pack-luxe-4-en-1/'
BOTH_AR = 'طقمان من عمود استحمام وخلّاط مغسلة وحنفية مرحاض باللون الأسود، موضوعان على صناديق، مع لافتتين مكتوب عليهما «13600 DA» و«14600 DA».'
BOTH_FR = 'Deux packs noirs posés sur des cartons, chacun avec colonne de douche, mitigeur de lavabo et robinet de toilette, avec deux pancartes « 13600 DA » et « 14600 DA ».'
PANELS_AR = 'لوحتا تحكّم لعمود الاستحمام على طاولة: لوحة سوداء مستديرة بأزرار جانبية، ولوحة رمادية مصقولة بأربعة أزرار وشاشة.'
PANELS_FR = 'Deux panneaux de commande de colonne de douche sur une table : un panneau noir arrondi à boutons latéraux et un panneau gris brossé à quatre touches et afficheur.'
img(101, A + '1.jpg', 3190, 3511, BOTH_AR, BOTH_FR, 497, UP + '2026/08/IMG_7696.jpeg', 'client_own', '13600 / 14600 (paper signs)')
img(101, A + '2.jpg', 1320, 1620,
    'عمود استحمام «بيانو» أسود بشريط إضاءة LED أزرق وشاشة، وتحته حنفية المرحاض مع الشطّاف وخلّاط المغسلة، مع ملصق «14600 Da».',
    'Colonne de douche Piano noire à bandeau LED bleu et afficheur, avec le robinet de toilette à douchette et le mitigeur de lavabo ; étiquette « 14600 Da ».',
    4272, UP + '2026/10/C6A7EC96-5A13-4AA8-97C6-CFE39D163F4B-2.jpeg', 'supplier_render', '14600')
img(101, A + '3.jpg', 1320, 1293,
    'عمود استحمام «بيانو» كامل في حمّام رمادي، مع خلّاط المغسلة وحنفية المرحاض، ونص «14600 da».',
    'Colonne de douche Piano complète dans une salle de bain grise, avec le mitigeur de lavabo et le robinet de toilette ; texte « 14600 da ».',
    4436, UP + '2026/10/2F699BF1-1D14-48EC-BE43-89E3D6D608A9.jpeg', 'supplier_render', '14600')
img(101, A + '4.jpg', 1237, 1624,
    'لوحة عمود الاستحمام بإضاءة LED وشاشة، مع خلّاط المغسلة وحنفية المرحاض، ونص «14600 da».',
    'Panneau de la colonne de douche avec LED et afficheur, le mitigeur de lavabo et le robinet de toilette ; texte « 14600 da ».',
    4441, UP + '2026/10/D08C7705-0DBA-48A8-A5C9-3B5751653090.jpeg', 'supplier_render', '14600')
img(101, A + '5.jpg', 1243, 1980,
    'لوحة عمود الاستحمام السوداء بحافة مضيئة زرقاء، وتحتها خلّاط المغسلة وحنفية المرحاض، مع ملصق «14600 da».',
    'Panneau noir de la colonne de douche à bord lumineux bleu, au-dessous le mitigeur de lavabo et le robinet de toilette ; étiquette « 14600 da ».',
    4466, UP + '2026/11/8944D590-457D-4B4D-B703-1B942A809EEF.jpeg', 'supplier_render', '14600')
img(102, B + '1.jpg', 1320, 1701,
    'يد تمسك لوحة التحكّم السوداء لعمود الاستحمام برأس دش مربّع، وبجانبه خلّاط المغسلة وحنفية المرحاض، مع ملصق «13600 Da».',
    'Une main tient le panneau de commande noir de la colonne de douche à pommeau carré, à côté le mitigeur de lavabo et le robinet de toilette ; étiquette « 13600 Da ».',
    150, UP + '2026/08/0A57AC22-93A3-40EF-BAE4-CB9D03CD520E.jpeg', 'client_own', '13600')
img(102, A + '1.jpg', 3190, 3511, BOTH_AR, BOTH_FR, 497, UP + '2026/08/IMG_7696.jpeg', 'client_own', '13600 / 14600 (paper signs)')
img(102, C + '1.jpg', 3716, 2287, PANELS_AR, PANELS_FR, 498, UP + '2026/08/IMG_7689.jpeg', 'client_own', None)
img(111, C + '1.jpg', 3716, 2287, PANELS_AR, PANELS_FR, 498, UP + '2026/08/IMG_7689.jpeg', 'client_own', None)
img(103, LX + '1.jpg', 1284, 1533,
    'لوحة عمود الاستحمام السوداء بإضاءة LED، وتحتها حنفية المرحاض وخلّاط المغسلة وخلّاط المطبخ، مع ملصق «16500 Da».',
    'Panneau noir de la colonne de douche avec LED, au-dessous le robinet de toilette, le mitigeur de lavabo et le mitigeur de cuisine ; étiquette « 16500 Da ».',
    147, UP + '2026/07/47FCD068-3A54-4913-B2D3-A6E8C623B27A.jpeg', 'supplier_render', '16500')
IMG_PROV = []
for p in P:
    rows = []
    for n, i in enumerate(IMG.get(p['id'], []), start=1):
        iid = p['id'] * 10 + n
        rows.append(dict(id=iid, variantId=None, key=i['key'], width=i['w'], height=i['h'], alt=L(i['ar'], i['fr']), position=n, placeholder=False))
        IMG_PROV.append(dict(imageId=iid, productId=p['id'], key=i['key'], **i['prov']))
    p['images'] = rows

os.makedirs(os.path.join(OUT, 'products'), exist_ok=True)
def dump(path, obj):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2); f.write('\n')
dump(os.path.join(OUT, 'categories.json'), categories)
for p in P:
    dump(os.path.join(OUT, 'products', p['slug']['fr'] + '.json'), p)
dump(os.path.join(OUT, 'settings.json'), dict(
    storeName=L('HB Destockage', 'HB Destockage'), contactPhone='0560417403', whatsapp='213779942022', contactEmail=None,
    homeFeaturedProductIds=[101, 103, 102], homeHeroProductId=101, turnstileSiteKey=None))
WC = [
  dict(wcId=4465, url=SRC + 'pack/', name='Pack', priceDzd=14600, compareAtDzd=18900, seedProductIds=[101, 102],
       mapping='Ordered at 14 600 = Pack A (101). Its description also lists Pack B 13 600 (102). Photo kept on 101.'),
  dict(wcId=4440, url=SRC + 'pack-a-et-b/', name='Pack A et B', priceDzd=14600, compareAtDzd=17900, seedProductIds=[101, 102],
       mapping='Ordered at 14 600 = Pack A (101); description lists Pack B 13 600 (102). Photo kept on 101.'),
  dict(wcId=4435, url=SRC + 'sans-titre/', name='Promotion', priceDzd=14600, compareAtDzd=17900, seedProductIds=[101],
       mapping='Same three pieces as Pack A. Photo kept on 101.'),
  dict(wcId=4271, url=SRC + 'pack-3-en-1/', name='Pack 3 en 1', priceDzd=14600, compareAtDzd=17900, seedProductIds=[101],
       mapping='Same three pieces as Pack A; its French description is the one used for 101.'),
  dict(wcId=20, url=SRC + 'nouvelle-pack-luxury-4en1-douche-prix-16500-da-livraison-60-alf/', name='nouvelle pack luxury 4en1 douche — prix 16500 DA — livraison 60 alf',
       priceDzd=16500, compareAtDzd=19900, seedProductIds=[103], mapping='1:1.'),
]
prov = dict(
  about='Where each real seed product comes from. Not part of CatalogSnapshot; read by people and by the seed validator only. Reverting the de-duplication = one seed product per wcProducts row, using its name/price/compareAt and photo.',
  source='https://hbdestockagedz.com/', fetchedAt=FETCH, rawDump='data/catalog/source/',
  decision='De-duplicated 5 WooCommerce products into 3 packs (lead, 2026-11-04); pending client confirmation.',
  wcProducts=WC,
  products=[dict(productId=k, needsClientConfirmation=(k == 102), **v) for k, v in sorted(PROV.items())],
  imagesNote='source: client_own = the client\'s own photograph (iPhone EXIF); supplier_render = Instagram screenshot of a collage of product renders, rights to be confirmed by the client. burnedInPrice = price printed in the image (stale if the price changes). Unreferenced files: data/photos/_unreferenced/ (see data/photos/README.md).',
  images=IMG_PROV)
dump(os.path.join(OUT, 'provenance.json'), prov)
print(len(categories), len(P))

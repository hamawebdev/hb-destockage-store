# SEED-4 generator: placeholder categories + products (ids 2–9 / 201+) and the SVG sources of their
# placeholder photos. Everything it writes is `placeholder: true`.
#
#   python3 -I data/catalog/placeholders/build.py <repo root> <svg out dir>
#   node data/catalog/placeholders/render.mjs <svg out dir> <repo root>/data/photos   # SVG -> JPEG
#
# Writes data/catalog/products/<fr-slug>.json for each placeholder product and merges the
# placeholder categories into data/catalog/categories.json (build_real.py's categories 1/11/12 are kept).
import json, os, sys, html

ROOT, SVG_OUT = sys.argv[1], sys.argv[2]
CAT = os.path.join(ROOT, 'data', 'catalog')
TP = ['ar', 'fr']  # we wrote both languages
def L(ar, fr): return {'ar': ar, 'fr': fr}

NOTE = L('[PLACEHOLDER] منتج تجريبي وهمي: النص والسعر والمخزون والصور للاستبدال.',
         '[PLACEHOLDER] Produit fictif de démonstration : texte, prix, stock et photos à remplacer.')

# ---------------------------------------------------------------- categories
def cat(id, parent, slug_ar, slug_fr, ar, fr, sort, d_ar=None, d_fr=None):
    if not d_ar:  # sub-categories: a generic tagged description
        d_ar, d_fr = f'[PLACEHOLDER] قسم فرعي تجريبي: {ar}.', f'[PLACEHOLDER] Sous-rayon de démonstration : {fr}.'
    return dict(id=id, parentId=parent, slug=L(slug_ar, slug_fr), name=L(ar, fr),
                description=L(d_ar, d_fr), sort=sort, active=True, placeholder=True,
                translationPlaceholder=TP)

CATS = [
    cat(2, None, 'al-iliktruniyat', 'electronique-accessoires', 'الإلكترونيات والإكسسوارات', 'Électronique & accessoires', 20,
        '[PLACEHOLDER] قسم تجريبي: هواتف وملحقاتها وصوتيات.', '[PLACEHOLDER] Rayon de démonstration : téléphonie et audio.'),
    cat(21, 2, 'al-hawatif', 'telephonie', 'الهواتف وملحقاتها', 'Téléphonie', 10),
    cat(211, 21, 'al-shawahin-wal-kawabil', 'chargeurs-cables', 'الشواحن والكوابل', 'Chargeurs & câbles', 10),
    cat(212, 21, 'al-aghtiya-wal-himaya', 'coques-protections', 'الأغطية والحماية', 'Coques & protections', 20),
    cat(22, 2, 'al-sawtiyat', 'audio', 'الصوتيات', 'Audio', 20),
    cat(3, None, 'al-moda', 'mode', 'الموضة', 'Mode', 30,
        '[PLACEHOLDER] قسم تجريبي: ملابس رجالية ونسائية وأحذية.', '[PLACEHOLDER] Rayon de démonstration : homme, femme et chaussures.'),
    cat(31, 3, 'rijal', 'homme', 'رجال', 'Homme', 10),
    cat(32, 3, 'nisaa', 'femme', 'نساء', 'Femme', 20),
    cat(33, 3, 'ahdhiya', 'chaussures', 'أحذية', 'Chaussures', 30),
    cat(4, None, 'al-jamal-wal-inaya', 'beaute-soins', 'الجمال والعناية', 'Beauté & soins', 40,
        '[PLACEHOLDER] قسم تجريبي: العناية بالوجه والشعر وعلب الهدايا.', '[PLACEHOLDER] Rayon de démonstration : visage, cheveux et coffrets.'),
    cat(41, 4, 'al-inaya-bil-wajh', 'soins-visage', 'العناية بالوجه', 'Soins du visage', 10),
    cat(42, 4, 'al-inaya-bil-shaar', 'soins-cheveux', 'العناية بالشعر', 'Soins des cheveux', 20),
    cat(43, 4, 'al-ulab', 'coffrets', 'العلب والأطقم', 'Coffrets', 30),
    cat(5, None, 'al-alab-wal-atfal', 'jouets-enfants', 'الألعاب والأطفال', 'Jouets & enfants', 50,
        '[PLACEHOLDER] قسم تجريبي: ألعاب التركيب والدمى والمركبات.', '[PLACEHOLDER] Rayon de démonstration : construction, peluches et véhicules.'),
    cat(51, 5, 'alab-al-tarkib', 'jeux-construction', 'ألعاب التركيب', 'Jeux de construction', 10),
    cat(52, 5, 'al-duma-al-mahshuwwa', 'peluches', 'الدمى المحشوّة', 'Peluches', 20),
    cat(53, 5, 'al-markabat', 'vehicules', 'المركبات', 'Véhicules', 30),
]

# ---------------------------------------------------------------- option helpers
COLOURS = {
    'noir': ('أسود', 'Noir', '#1f1f1f'), 'blanc': ('أبيض', 'Blanc', '#f4f4f2'),
    'bleu-nuit': ('أزرق ليلي', 'Bleu nuit', '#1e3a5f'), 'rouge': ('أحمر', 'Rouge', '#b3261e'),
    'vert-sauge': ('أخضر مريمي', 'Vert sauge', '#7d9a7e'), 'rose': ('وردي فاتح', 'Rose poudré', '#e8b4b8'),
    'bleu-ciel': ('أزرق سماوي', 'Bleu ciel', '#9cc3e4'), 'marine': ('كحلي', 'Bleu marine', '#1f2a44'),
    'gris': ('رمادي مُبرقش', 'Gris chiné', '#9e9e9e'), 'terracotta': ('طوبي', 'Terracotta', '#c0643f'),
    'moutarde': ('خردلي', 'Moutarde', '#d4a72c'), 'bleu': ('أزرق', 'Bleu', '#2f5fb3'), 'jaune': ('أصفر', 'Jaune', '#f2c230'),
}

class P:
    """Builds one placeholder product."""
    def __init__(self, id, kind, cat, slug_ar, slug_fr, ar, fr, sum_ar, sum_fr, desc_ar, desc_fr, shape, brand=None, sort=10):
        self.d = dict(id=id, kind=kind, categoryId=cat, status='active', sort=sort, slug=L(slug_ar, slug_fr), name=L(ar, fr),
                      brandLatin=brand, summary=L(sum_ar, sum_fr),
                      description=L(desc_ar + '\n\n' + NOTE['ar'], desc_fr + '\n\n' + NOTE['fr']),
                      placeholder=True, translationPlaceholder=TP, options=[], variants=[], packItems=[], images=[])
        self.shape, self.nopt, self.images = shape, 0, []
    def option(self, type, ar, fr, values):  # values: list of (key, ar, fr, hex|None)
        self.nopt += 1
        oid = self.d['id'] * 10 + self.nopt
        vals = [dict(id=oid * 100 + i, value=L(a, f), swatchHex=h, position=i) for i, (k, a, f, h) in enumerate(values, start=1)]
        self.d['options'].append(dict(id=oid, type=type, name=L(ar, fr), position=self.nopt, values=vals))
        return {k: vals[i]['id'] for i, (k, *_r) in enumerate(values)}
    def variant(self, sku, price, stock, compare=None, opts=(), default=False, weight=None):
        n = len(self.d['variants']) + 1
        self.d['variants'].append(dict(id=self.d['id'] * 100 + n, sku=sku, priceDzd=price, compareAtDzd=compare, stock=stock,
                                       weightG=weight, active=True, isDefault=default, optionValueIds=list(opts)))
        return self.d['id'] * 100 + n
    def photo(self, view, colour, alt_ar, alt_fr, variant=None):
        self.images.append((view, colour, alt_ar, alt_fr, variant))

def colour_values(*keys):
    return [(k, COLOURS[k][0], COLOURS[k][1], COLOURS[k][2]) for k in keys]

PRODUCTS = []
def add(p): PRODUCTS.append(p); return p
TMP_AR, TMP_FR = 'صورة مؤقتة: ', 'Image provisoire : '

# ---------------------------------------------------------------- Électronique & accessoires
p = add(P(201, 'variable', 22, 'sammaat-udhun-lasilkiya', 'ecouteurs-sans-fil', 'سماعات أذن لاسلكية بلوتوث', 'Écouteurs sans fil Bluetooth',
          'سماعات صغيرة مع علبة شحن، حتى 20 ساعة استماع.', 'Écouteurs compacts avec boîtier de charge, jusqu’à 20 h d’écoute.',
          'بلوتوث 5.3 وعلبة شحن USB-C.\n\nثلاثة أحجام من الأطراف السيليكونية في العلبة.',
          'Bluetooth 5.3 et boîtier de charge USB-C.\n\nTrois tailles d’embouts en silicone fournies.', 'earbuds', brand='DemoSound', sort=10))
c = p.option('colour', 'اللون', 'Couleur', colour_values('noir', 'blanc', 'bleu-nuit'))
v1 = p.variant('PH-EAR-NOIR', 3900, 25, 4900, [c['noir']], default=True, weight=60)
v2 = p.variant('PH-EAR-BLANC', 3900, 12, 4900, [c['blanc']], weight=60)
v3 = p.variant('PH-EAR-BLEU', 3900, 0, 4900, [c['bleu-nuit']], weight=60)   # out of stock
p.photo('front', '#1f1f1f', TMP_AR + 'سماعات أذن لاسلكية مع علبة الشحن', TMP_FR + 'écouteurs sans fil et leur boîtier de charge')
p.photo('front', '#f4f4f2', TMP_AR + 'سماعات أذن لاسلكية، اللون الأبيض', TMP_FR + 'écouteurs sans fil, coloris blanc', v2)
p.photo('front', '#1e3a5f', TMP_AR + 'سماعات أذن لاسلكية، اللون الأزرق الليلي', TMP_FR + 'écouteurs sans fil, coloris bleu nuit', v3)
p.photo('box', '#1f1f1f', TMP_AR + 'علبة السماعات', TMP_FR + 'emballage des écouteurs')

p = add(P(202, 'variable', 22, 'mukabbir-sawt-bluetooth', 'enceinte-bluetooth-portable', 'مكبّر صوت بلوتوث محمول', 'Enceinte Bluetooth portable',
          'مكبّر صوت مقاوم للرذاذ بصوت قوي.', 'Enceinte résistante aux éclaboussures, son puissant.',
          'قوة 10 واط وبطارية تدوم 12 ساعة.\n\nحزام للحمل.', 'Puissance 10 W, autonomie 12 h.\n\nDragonne de transport.', 'speaker', brand='DemoSound', sort=20))
c = p.option('colour', 'اللون', 'Couleur', colour_values('noir', 'rouge', 'vert-sauge'))
p.variant('PH-SPK-NOIR', 5500, 8, None, [c['noir']], default=True)
v = p.variant('PH-SPK-ROUGE', 5500, 3, None, [c['rouge']])
p.variant('PH-SPK-VERT', 5500, 10, None, [c['vert-sauge']])
p.photo('front', '#1f1f1f', TMP_AR + 'مكبّر صوت بلوتوث أسطواني', TMP_FR + 'enceinte Bluetooth cylindrique')
p.photo('front', '#b3261e', TMP_AR + 'مكبّر الصوت، اللون الأحمر', TMP_FR + 'enceinte, coloris rouge', v)
p.photo('detail', '#1f1f1f', TMP_AR + 'مكبّر الصوت عن قرب', TMP_FR + 'vue rapprochée de l’enceinte')

p = add(P(203, 'simple', 211, 'shahin-sari-20-watt', 'chargeur-rapide-usb-c-20w', 'شاحن سريع USB-C بقوة 20 واط', 'Chargeur rapide USB-C 20 W',
          'شاحن حائطي صغير بمنفذ USB-C.', 'Chargeur secteur compact avec port USB-C.',
          'شحن سريع PD بقوة 20 واط.\n\nقابس أوروبي.', 'Charge rapide PD 20 W.\n\nPrise européenne.', 'charger', sort=10))
p.variant('PH-CHG-20W', 1800, 40, 2400, default=True, weight=45)
p.photo('front', '#f4f4f2', TMP_AR + 'شاحن حائطي أبيض', TMP_FR + 'chargeur secteur blanc')
p.photo('box', '#f4f4f2', TMP_AR + 'علبة الشاحن', TMP_FR + 'emballage du chargeur')

p = add(P(204, 'variable', 211, 'kabil-usb-c', 'cable-usb-c-usb-c', 'كابل USB-C إلى USB-C', 'Câble USB-C vers USB-C',
          'كابل مضفور متين للشحن ونقل البيانات.', 'Câble tressé résistant, charge et données.',
          'يدعم الشحن حتى 60 واط.\n\nمتوفّر بطولين.', 'Jusqu’à 60 W.\n\nDisponible en deux longueurs.', 'cable', sort=20))
c = p.option('other', 'الطول', 'Longueur', [('1m', '1 متر', '1 m', None), ('2m', '2 متر', '2 m', None)])
p.variant('PH-CBL-1M', 600, None, None, [c['1m']], default=True)   # untracked stock
p.variant('PH-CBL-2M', 800, None, None, [c['2m']])
p.photo('front', '#3a3a3a', TMP_AR + 'كابل USB-C ملفوف', TMP_FR + 'câble USB-C enroulé')
p.photo('detail', '#3a3a3a', TMP_AR + 'الكابل عن قرب', TMP_FR + 'vue rapprochée du câble')

p = add(P(205, 'variable', 212, 'ghitaa-silikon', 'coque-silicone-smartphone', 'غطاء سيليكون للهاتف', 'Coque silicone pour smartphone',
          'غطاء ناعم يحمي من الصدمات والخدوش.', 'Coque douce qui protège des chocs et des rayures.',
          'سيليكون مرن مع بطانة من الألياف الدقيقة.', 'Silicone souple, doublure microfibre.', 'case', sort=10))
c = p.option('colour', 'اللون', 'Couleur', colour_values('noir', 'rose', 'bleu-ciel'))
p.variant('PH-CASE-NOIR', 900, 30, None, [c['noir']], default=True)
v = p.variant('PH-CASE-ROSE', 900, 18, None, [c['rose']])
w = p.variant('PH-CASE-CIEL', 900, 9, None, [c['bleu-ciel']])
p.photo('front', '#1f1f1f', TMP_AR + 'غطاء هاتف أسود', TMP_FR + 'coque de téléphone noire')
p.photo('front', '#e8b4b8', TMP_AR + 'غطاء الهاتف، اللون الوردي', TMP_FR + 'coque, coloris rose poudré', v)
p.photo('front', '#9cc3e4', TMP_AR + 'غطاء الهاتف، اللون الأزرق السماوي', TMP_FR + 'coque, coloris bleu ciel', w)

# ---------------------------------------------------------------- Mode
p = add(P(206, 'variable', 31, 'qamis-qutni-rijali', 't-shirt-coton-homme', 'تيشيرت قطني رجالي', 'T-shirt coton homme',
          'تيشيرت بياقة دائرية من القطن 100%.', 'T-shirt col rond 100 % coton.',
          'قطن ممشّط 180 غ/م².\n\nقصّة عادية.', 'Coton peigné 180 g/m².\n\nCoupe droite.', 'tshirt', sort=10))
s = p.option('size', 'المقاس', 'Taille', [(k, k, k, None) for k in ['S', 'M', 'L', 'XL']])
c = p.option('colour', 'اللون', 'Couleur', colour_values('blanc', 'noir', 'marine'))
stock = {('S', 'blanc'): 10, ('M', 'blanc'): 14, ('L', 'blanc'): 12, ('XL', 'blanc'): 6,
         ('S', 'noir'): 8, ('M', 'noir'): 2, ('L', 'noir'): 9, ('XL', 'noir'): 5,       # M noir = low stock
         ('S', 'marine'): 7, ('M', 'marine'): 11, ('L', 'marine'): 10, ('XL', 'marine'): 4}
vid = {}
for col in ['blanc', 'noir', 'marine']:
    for sz in ['S', 'M', 'L', 'XL']:
        vid[(sz, col)] = p.variant(f'PH-TSH-{sz}-{col.upper()}', 1500, stock[(sz, col)], None, [s[sz], c[col]],
                                   default=(sz, col) == ('M', 'blanc'), weight=180)
p.photo('front', '#f4f4f2', TMP_AR + 'تيشيرت رجالي', TMP_FR + 't-shirt homme')
p.photo('front', '#1f1f1f', TMP_AR + 'التيشيرت، اللون الأسود', TMP_FR + 't-shirt, coloris noir', vid[('M', 'noir')])
p.photo('front', '#1f2a44', TMP_AR + 'التيشيرت، اللون الكحلي', TMP_FR + 't-shirt, coloris bleu marine', vid[('M', 'marine')])
p.photo('detail', '#f4f4f2', TMP_AR + 'التيشيرت عن قرب', TMP_FR + 'vue rapprochée du t-shirt')

p = add(P(207, 'variable', 31, 'sutra-bi-qubba', 'sweat-a-capuche', 'سترة بقبعة', 'Sweat à capuche',
          'سترة دافئة من القطن المبطّن بجيب أمامي.', 'Sweat chaud en molleton avec poche kangourou.',
          'قطن 80% وبوليستر 20%.\n\nالمقاس XL بسعر مختلف.', '80 % coton, 20 % polyester.\n\nLa taille XL a un prix différent.', 'hoodie', sort=20))
s = p.option('size', 'المقاس', 'Taille', [(k, k, k, None) for k in ['M', 'L', 'XL']])
c = p.option('colour', 'اللون', 'Couleur', colour_values('gris', 'noir'))
for col in ['gris', 'noir']:
    for sz in ['M', 'L', 'XL']:
        vv = p.variant(f'PH-HOOD-{sz}-{col.upper()}', 3400 if sz == 'XL' else 3200, 6, None, [s[sz], c[col]], default=(sz, col) == ('M', 'gris'))
        if (sz, col) == ('M', 'noir'): hood_noir = vv
p.photo('front', '#9e9e9e', TMP_AR + 'سترة بقبعة رمادية', TMP_FR + 'sweat à capuche gris')
p.photo('front', '#1f1f1f', TMP_AR + 'السترة، اللون الأسود', TMP_FR + 'sweat, coloris noir', hood_noir)

p = add(P(208, 'variable', 32, 'fustan-sayfi', 'robe-ete-fleurie', 'فستان صيفي مزهر', 'Robe d’été fleurie',
          'فستان خفيف بطبعة زهور.', 'Robe légère à imprimé fleuri.',
          'فسكوز 100%.\n\nطول متوسّط.', '100 % viscose.\n\nLongueur midi.', 'dress', sort=10))
s = p.option('size', 'المقاس', 'Taille', [(k, k, k, None) for k in ['S', 'M', 'L']])
for sz, st in [('S', 5), ('M', 8), ('L', 3)]:
    p.variant(f'PH-DRS-{sz}', 2800, st, 3500, [s[sz]], default=sz == 'M')
p.photo('front', '#c0643f', TMP_AR + 'فستان صيفي', TMP_FR + 'robe d’été')
p.photo('detail', '#c0643f', TMP_AR + 'الفستان عن قرب', TMP_FR + 'vue rapprochée de la robe')

p = add(P(209, 'variable', 32, 'wishah-muslin', 'foulard-mousseline', 'وشاح من الموسلين', 'Foulard en mousseline',
          'وشاح خفيف وناعم بعدة ألوان.', 'Foulard léger et fluide, plusieurs couleurs.',
          'المقاس 180 × 70 سم.', 'Dimensions 180 × 70 cm.', 'scarf', sort=20))
c = p.option('colour', 'اللون', 'Couleur', colour_values('terracotta', 'moutarde', 'vert-sauge'))
p.variant('PH-SCF-TERRA', 1200, 15, None, [c['terracotta']], default=True)
v = p.variant('PH-SCF-MOUT', 1200, 15, None, [c['moutarde']])
w = p.variant('PH-SCF-SAUGE', 1200, 15, None, [c['vert-sauge']])
p.photo('front', '#c0643f', TMP_AR + 'وشاح مطوي', TMP_FR + 'foulard plié')
p.photo('front', '#d4a72c', TMP_AR + 'الوشاح، اللون الخردلي', TMP_FR + 'foulard, coloris moutarde', v)
p.photo('front', '#7d9a7e', TMP_AR + 'الوشاح، اللون الأخضر', TMP_FR + 'foulard, coloris vert sauge', w)

p = add(P(210, 'variable', 33, 'hidhaa-riyadi-qumash', 'baskets-toile', 'حذاء رياضي من القماش', 'Baskets en toile',
          'حذاء خفيف من القماش بنعل مطاطي.', 'Baskets légères en toile, semelle caoutchouc.',
          'قماش قطني ونعل مطاطي.\n\nالمقاسات من 38 إلى 44.', 'Toile de coton, semelle caoutchouc.\n\nPointures 38 à 44.', 'sneaker', sort=10))
sizes = [str(n) for n in range(38, 45)]
s = p.option('size', 'المقاس', 'Pointure', [(k, k, k, None) for k in sizes])
c = p.option('colour', 'اللون', 'Couleur', colour_values('blanc', 'noir'))
for col in ['blanc', 'noir']:
    for sz in sizes:
        vv = p.variant(f'PH-SNK-{sz}-{col.upper()}', 4500, 4 if sz in ('38', '44') else 9, None, [s[sz], c[col]],
                       default=(sz, col) == ('41', 'blanc'))
        if (sz, col) == ('41', 'noir'): snk_noir = vv
p.photo('side', '#f4f4f2', TMP_AR + 'حذاء رياضي أبيض من الجانب', TMP_FR + 'basket blanche de profil')
p.photo('side', '#1f1f1f', TMP_AR + 'الحذاء، اللون الأسود', TMP_FR + 'basket, coloris noir', snk_noir)
p.photo('box', '#f4f4f2', TMP_AR + 'علبة الحذاء', TMP_FR + 'boîte à chaussures')

# ---------------------------------------------------------------- Beauté & soins
p = add(P(211, 'simple', 41, 'krim-murattib', 'creme-hydratante-visage', 'كريم مرطّب للوجه 50 مل', 'Crème hydratante visage 50 ml',
          'كريم خفيف للترطيب اليومي.', 'Crème légère pour l’hydratation quotidienne.',
          'لجميع أنواع البشرة.\n\nيُستعمل صباحًا ومساءً.', 'Tous types de peau.\n\nMatin et soir.', 'jar', brand='DemoCare', sort=10))
cream = p.variant('PH-CRM-50', 1600, 30, None, default=True, weight=90)
p.photo('front', '#f2e6d8', TMP_AR + 'علبة كريم مرطّب', TMP_FR + 'pot de crème hydratante')
p.photo('box', '#f2e6d8', TMP_AR + 'علبة الكريم الكرتونية', TMP_FR + 'étui de la crème')

p = add(P(212, 'simple', 41, 'sirum-vitamin-c', 'serum-vitamine-c', 'سيروم فيتامين C ‏30 مل', 'Sérum vitamine C 30 ml',
          'سيروم مضيء بفيتامين C.', 'Sérum éclat à la vitamine C.',
          'بضع قطرات على بشرة نظيفة.', 'Quelques gouttes sur peau propre.', 'dropper', brand='DemoCare', sort=20))
serum = p.variant('PH-SER-30', 2200, 15, None, default=True, weight=70)
p.photo('front', '#e3a54a', TMP_AR + 'قارورة سيروم بقطّارة', TMP_FR + 'flacon de sérum compte-gouttes')
p.photo('detail', '#e3a54a', TMP_AR + 'قارورة السيروم عن قرب', TMP_FR + 'vue rapprochée du flacon de sérum')

p = add(P(213, 'simple', 41, 'jil-munazzif', 'gel-nettoyant-visage', 'جل منظّف للوجه 150 مل', 'Gel nettoyant visage 150 ml',
          'جل لطيف لتنظيف البشرة يوميًا.', 'Gel doux pour le nettoyage quotidien.',
          'يُشطف بالماء.', 'Se rince à l’eau.', 'tube', brand='DemoCare', sort=30))
gel = p.variant('PH-GEL-150', 1100, 20, None, default=True, weight=170)
p.photo('front', '#8fc1b5', TMP_AR + 'أنبوب جل منظّف', TMP_FR + 'tube de gel nettoyant')
p.photo('side', '#8fc1b5', TMP_AR + 'الأنبوب من الجانب', TMP_FR + 'tube de profil')

p = add(P(214, 'variable', 42, 'shampu-muslih', 'shampooing-reparateur', 'شامبو مُصلِح', 'Shampooing réparateur',
          'شامبو للشعر الجاف والمتضرّر.', 'Shampooing pour cheveux secs et abîmés.',
          'متوفّر بحجمين.', 'Disponible en deux contenances.', 'bottle', brand='DemoCare', sort=10))
c = p.option('size', 'الحجم', 'Contenance', [('250', '250 مل', '250 ml', None), ('500', '500 مل', '500 ml', None)])
p.variant('PH-SHP-250', 900, 22, None, [c['250']], default=True)
p.variant('PH-SHP-500', 1500, 14, 1800, [c['500']])
p.photo('front', '#6d4c9c', TMP_AR + 'قارورة شامبو', TMP_FR + 'flacon de shampooing')
p.photo('detail', '#6d4c9c', TMP_AR + 'قارورة الشامبو عن قرب', TMP_FR + 'vue rapprochée du flacon de shampooing')

p = add(P(215, 'simple', 42, 'zayt-al-argan', 'huile-argan', 'زيت الأرغان 100 مل', 'Huile d’argan 100 ml',
          'زيت أرغان نقي للشعر والبشرة.', 'Huile d’argan pure pour cheveux et peau.',
          'معصور على البارد.', 'Pressée à froid.', 'oil', sort=20))
p.variant('PH-ARG-100', 2500, 4, None, default=True, weight=150)   # low stock
p.photo('front', '#c99a3b', TMP_AR + 'قارورة زيت الأرغان', TMP_FR + 'flacon d’huile d’argan')
p.photo('box', '#c99a3b', TMP_AR + 'علبة زيت الأرغان', TMP_FR + 'étui de l’huile d’argan')

p = add(P(216, 'pack', 43, 'ulbat-al-inaya-bil-wajh', 'coffret-soin-visage', 'علبة العناية بالوجه', 'Coffret soin visage',
          'الكريم والسيروم والجل المنظّف في علبة واحدة.', 'La crème, le sérum et le gel nettoyant réunis en coffret.',
          'روتين كامل من 3 منتجات.', 'Une routine complète en 3 produits.', 'giftbox', brand='DemoCare', sort=10))
p.variant('PH-BOX-VISAGE', 4400, 6, 4900, default=True)
p.d['packItems'] = [dict(variantId=cream, qty=1), dict(variantId=serum, qty=1), dict(variantId=gel, qty=1)]
p.photo('front', '#b5838d', TMP_AR + 'علبة هدية العناية بالوجه', TMP_FR + 'coffret cadeau soin visage')
p.photo('open', '#b5838d', TMP_AR + 'العلبة وأمامها منتجاتها الثلاثة', TMP_FR + 'le coffret et, devant, ses trois produits')

# ---------------------------------------------------------------- Jouets & enfants
p = add(P(217, 'simple', 51, 'mukaabat-tarkib-120', 'blocs-construction-120', 'مكعّبات تركيب 120 قطعة', 'Blocs de construction 120 pièces',
          'مكعّبات ملوّنة لتنمية الإبداع، من 3 سنوات.', 'Blocs colorés pour la créativité, dès 3 ans.',
          '120 قطعة في علبة تخزين.', '120 pièces avec boîte de rangement.', 'blocks', sort=10))
p.variant('PH-BLK-120', 2900, None, 3400, default=True)   # untracked stock
p.photo('front', '#e05a47', TMP_AR + 'مكعّبات تركيب ملوّنة', TMP_FR + 'blocs de construction colorés')
p.photo('box', '#e05a47', TMP_AR + 'علبة المكعّبات', TMP_FR + 'boîte des blocs')

p = add(P(218, 'simple', 51, 'uhjiya-500', 'puzzle-500-pieces', 'أحجية 500 قطعة', 'Puzzle 500 pièces',
          'أحجية بمنظر طبيعي، من 10 سنوات.', 'Puzzle paysage, dès 10 ans.',
          'المقاس بعد التركيب 49 × 36 سم.', 'Format assemblé 49 × 36 cm.', 'puzzle', sort=20))
p.variant('PH-PZL-500', 1300, 12, None, default=True)
p.photo('front', '#4f8a8b', TMP_AR + 'قطعة أحجية', TMP_FR + 'pièce de puzzle')
p.photo('box', '#4f8a8b', TMP_AR + 'علبة الأحجية', TMP_FR + 'boîte du puzzle')

p = add(P(219, 'variable', 52, 'dabdub-mahshu', 'peluche-ourson', 'دبدوب محشو', 'Peluche ourson',
          'دبدوب ناعم جدًا، متوفّر بثلاثة أحجام.', 'Ourson tout doux, en trois tailles.',
          'قابل للغسل في الغسالة على 30°.', 'Lavable en machine à 30 °C.', 'teddy', sort=10))
c = p.option('size', 'الحجم', 'Taille', [('30', '30 سم', '30 cm', None), ('50', '50 سم', '50 cm', None), ('80', '80 سم', '80 cm', None)])
p.variant('PH-TED-30', 1500, 20, None, [c['30']], default=True)
p.variant('PH-TED-50', 2600, 10, None, [c['50']])
p.variant('PH-TED-80', 4200, 3, None, [c['80']])
p.photo('front', '#a9744f', TMP_AR + 'دبدوب بنّي', TMP_FR + 'ourson brun')
p.photo('detail', '#a9744f', TMP_AR + 'الدبدوب عن قرب', TMP_FR + 'vue rapprochée de l’ourson')

p = add(P(220, 'variable', 53, 'sayyara-bi-tahakkum', 'voiture-telecommandee', 'سيارة بجهاز تحكّم', 'Voiture télécommandée',
          'سيارة سريعة بجهاز تحكّم لاسلكي.', 'Voiture rapide avec télécommande sans fil.',
          'بطارية قابلة للشحن.\n\nمن 6 سنوات.', 'Batterie rechargeable.\n\nDès 6 ans.', 'car', sort=10))
c = p.option('colour', 'اللون', 'Couleur', colour_values('rouge', 'bleu', 'jaune'))
p.variant('PH-RC-ROUGE', 3800, 7, 4500, [c['rouge']], default=True)
v = p.variant('PH-RC-BLEU', 3800, 7, 4500, [c['bleu']])
w = p.variant('PH-RC-JAUNE', 3800, 7, 4500, [c['jaune']])
p.photo('side', '#b3261e', TMP_AR + 'سيارة لعبة حمراء', TMP_FR + 'voiture rouge')
p.photo('side', '#2f5fb3', TMP_AR + 'السيارة، اللون الأزرق', TMP_FR + 'voiture, coloris bleu', v)
p.photo('side', '#f2c230', TMP_AR + 'السيارة، اللون الأصفر', TMP_FR + 'voiture, coloris jaune', w)
p.photo('box', '#b3261e', TMP_AR + 'علبة السيارة', TMP_FR + 'boîte de la voiture')

# ---------------------------------------------------------------- SVG placeholder photos
W = 1200
def shape_svg(shape, col, view):
    """Very simple flat product silhouettes, centred around (600, 560)."""
    dark = '#00000022'
    s = {
        'earbuds': f'<rect x="430" y="470" width="340" height="230" rx="110" fill="{col}"/><rect x="430" y="470" width="340" height="40" rx="20" fill="{dark}"/>'
                   f'<circle cx="480" cy="360" r="70" fill="{col}"/><rect x="465" y="380" width="30" height="120" rx="15" fill="{col}"/>'
                   f'<circle cx="720" cy="360" r="70" fill="{col}"/><rect x="705" y="380" width="30" height="120" rx="15" fill="{col}"/>',
        'speaker': f'<rect x="440" y="300" width="320" height="440" rx="70" fill="{col}"/><circle cx="600" cy="470" r="110" fill="{dark}"/><circle cx="600" cy="470" r="60" fill="{dark}"/><rect x="520" y="640" width="160" height="30" rx="15" fill="{dark}"/>',
        'charger': f'<rect x="460" y="380" width="280" height="300" rx="40" fill="{col}" stroke="#00000033" stroke-width="4"/><rect x="530" y="290" width="22" height="100" fill="#8a8a8a"/><rect x="648" y="290" width="22" height="100" fill="#8a8a8a"/><rect x="560" y="580" width="80" height="26" rx="13" fill="#00000055"/>',
        'cable': f'<g fill="none" stroke="{col}" stroke-width="22" stroke-linecap="round"><circle cx="600" cy="520" r="170"/><circle cx="600" cy="520" r="120"/><path d="M770 520 Q 860 520 860 380"/></g><rect x="835" y="300" width="50" height="90" rx="12" fill="#8a8a8a"/>',
        'case': f'<rect x="470" y="240" width="260" height="520" rx="50" fill="{col}" stroke="#00000033" stroke-width="4"/><rect x="500" y="270" width="110" height="130" rx="30" fill="#00000033"/><circle cx="530" cy="305" r="18" fill="#00000055"/><circle cx="580" cy="365" r="18" fill="#00000055"/>',
        'tshirt': f'<path d="M470 280 L380 330 L330 470 L430 500 L440 760 L760 760 L770 500 L870 470 L820 330 L730 280 Q600 360 470 280 Z" fill="{col}" stroke="#00000033" stroke-width="4"/>',
        'hoodie': f'<path d="M470 300 L380 350 L320 640 L420 660 L440 780 L760 780 L780 660 L880 640 L820 350 L730 300 Q600 360 470 300 Z" fill="{col}" stroke="#00000033" stroke-width="4"/><path d="M500 310 Q600 180 700 310 Q600 380 500 310 Z" fill="{col}" stroke="#00000044" stroke-width="4"/><rect x="510" y="600" width="180" height="90" rx="20" fill="{dark}"/>',
        'dress': f'<path d="M530 260 L670 260 L690 420 L820 780 L380 780 L510 420 Z" fill="{col}" stroke="#00000033" stroke-width="4"/><g fill="#ffffff66"><circle cx="560" cy="560" r="22"/><circle cx="660" cy="640" r="22"/><circle cx="520" cy="700" r="22"/><circle cx="700" cy="500" r="18"/></g>',
        'scarf': f'<path d="M360 420 Q600 300 840 420 L800 520 Q600 420 400 520 Z" fill="{col}"/><path d="M420 500 L380 780 L470 760 L520 520 Z" fill="{col}"/><path d="M780 500 L820 780 L730 760 L680 520 Z" fill="{col}" opacity="0.85"/>',
        'sneaker': f'<path d="M330 560 Q340 420 470 430 L600 470 Q760 520 860 560 L880 640 L320 640 Z" fill="{col}" stroke="#00000044" stroke-width="5"/><rect x="310" y="630" width="590" height="50" rx="20" fill="#d9d4cc" stroke="#00000033" stroke-width="4"/><g stroke="#00000055" stroke-width="8"><line x1="520" y1="470" x2="560" y2="520"/><line x1="560" y1="465" x2="600" y2="515"/></g>',
        'jar': f'<rect x="440" y="420" width="320" height="260" rx="40" fill="{col}" stroke="#00000033" stroke-width="4"/><rect x="430" y="350" width="340" height="90" rx="20" fill="#ffffff" stroke="#00000033" stroke-width="4"/>',
        'dropper': f'<rect x="500" y="400" width="200" height="340" rx="40" fill="{col}" stroke="#00000033" stroke-width="4"/><rect x="545" y="330" width="110" height="80" fill="#2b2b2b"/><rect x="570" y="230" width="60" height="110" rx="30" fill="#2b2b2b"/>',
        'tube': f'<path d="M500 280 L700 280 L740 700 L460 700 Z" fill="{col}" stroke="#00000033" stroke-width="4"/><rect x="540" y="700" width="120" height="70" rx="12" fill="#ffffff" stroke="#00000033" stroke-width="4"/>',
        'bottle': f'<rect x="480" y="360" width="240" height="400" rx="60" fill="{col}"/><rect x="550" y="280" width="100" height="90" rx="14" fill="#2b2b2b"/><rect x="510" y="470" width="180" height="140" rx="10" fill="#ffffff55"/>',
        'oil': f'<rect x="500" y="400" width="200" height="360" rx="30" fill="{col}" opacity="0.9"/><rect x="560" y="300" width="80" height="110" fill="{col}"/><rect x="550" y="250" width="100" height="60" rx="10" fill="#2b2b2b"/>',
        'giftbox': f'<rect x="380" y="420" width="440" height="320" fill="{col}"/><rect x="360" y="360" width="480" height="80" fill="{col}" stroke="#00000033" stroke-width="4"/><rect x="580" y="360" width="40" height="380" fill="#ffffffaa"/><path d="M600 360 Q520 260 480 330 Q520 370 600 360 Q680 370 720 330 Q680 260 600 360 Z" fill="#ffffffaa"/>',
        'blocks': f'<rect x="400" y="560" width="160" height="160" fill="{col}"/><rect x="570" y="560" width="160" height="160" fill="#2f5fb3"/><rect x="485" y="390" width="160" height="160" fill="#f2c230"/><rect x="740" y="620" width="100" height="100" fill="#4f8a8b"/>',
        'puzzle': f'<path d="M440 360 L560 360 Q560 300 600 300 Q640 300 640 360 L760 360 L760 480 Q820 480 820 520 Q820 560 760 560 L760 680 L440 680 L440 560 Q500 560 500 520 Q500 480 440 480 Z" fill="{col}" stroke="#00000033" stroke-width="4"/>',
        'teddy': f'<circle cx="490" cy="300" r="60" fill="{col}"/><circle cx="710" cy="300" r="60" fill="{col}"/><circle cx="600" cy="390" r="140" fill="{col}"/><ellipse cx="600" cy="620" rx="170" ry="160" fill="{col}"/><ellipse cx="600" cy="430" rx="55" ry="40" fill="#ffffff55"/><circle cx="555" cy="360" r="14" fill="#2b2b2b"/><circle cx="645" cy="360" r="14" fill="#2b2b2b"/>',
        'car': f'<path d="M330 600 L360 500 Q380 470 430 470 L500 400 L720 400 L800 470 L860 480 Q890 490 890 530 L890 600 Z" fill="{col}" stroke="#00000044" stroke-width="5"/><rect x="520" y="420" width="90" height="55" fill="#ffffffaa"/><rect x="625" y="420" width="90" height="55" fill="#ffffffaa"/><circle cx="450" cy="610" r="60" fill="#2b2b2b"/><circle cx="770" cy="610" r="60" fill="#2b2b2b"/>',
    }[shape]
    if view == 'detail':
        return f'<g transform="translate(600 560) scale(1.45) translate(-600 -530)">{s}</g>'
    if view == 'side':
        return f'<g transform="translate(600 560) scale(1.15 1) translate(-600 -560)">{s}</g>'
    if view == 'box':
        return (f'<rect x="300" y="300" width="380" height="440" fill="#d8cbb8" stroke="#00000022" stroke-width="4"/>'
                f'<rect x="300" y="300" width="380" height="60" fill="#c9b9a2"/>'
                f'<g transform="translate(830 560) scale(0.55) translate(-600 -560)">{s}</g>')
    if view == 'open':
        return (f'<g transform="translate(600 560) scale(0.8) translate(-600 -560)">{s}</g>'
                f'<g transform="translate(330 760) scale(0.3) translate(-600 -560)">{shape_svg("jar", "#f2e6d8", "front")}</g>'
                f'<g transform="translate(600 800) scale(0.3) translate(-600 -560)">{shape_svg("dropper", "#e3a54a", "front")}</g>'
                f'<g transform="translate(870 760) scale(0.3) translate(-600 -560)">{shape_svg("tube", "#8fc1b5", "front")}</g>')
    return s

def svg(prod, n, view, col):
    name_fr = html.escape(prod.d['name']['fr']); name_ar = html.escape(prod.d['name']['ar'])
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{W}" viewBox="0 0 {W} {W}">
<rect width="{W}" height="{W}" fill="#f3f1ee"/>
<ellipse cx="600" cy="800" rx="330" ry="40" fill="#00000014"/>
<g stroke="#00000030" stroke-width="4">{shape_svg(prod.shape, col, view)}</g>
<rect x="0" y="0" width="{W}" height="120" fill="#ffffffcc"/>
<text x="600" y="82" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-weight="700" font-size="64" fill="#8a8178" letter-spacing="12">PLACEHOLDER</text>
<rect x="0" y="960" width="{W}" height="240" fill="#ffffffcc"/>
<text x="600" y="1040" text-anchor="middle" font-family="Noto Sans Arabic, sans-serif" font-size="44" fill="#5b544d" direction="rtl">{name_ar}</text>
<text x="600" y="1110" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="38" fill="#5b544d">{name_fr}</text>
<text x="600" y="1165" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="26" fill="#9a928a">photo {n} · {view} · not a real product</text>
</svg>'''

# ---------------------------------------------------------------- write
os.makedirs(SVG_OUT, exist_ok=True)
def dump(path, obj):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2); f.write('\n')

for prod in PRODUCTS:
    slug = prod.d['slug']['fr']
    rows = []
    for n, (view, col, a_ar, a_fr, variant) in enumerate(prod.images, start=1):
        key = f'{slug}/{n}.jpg'
        rows.append(dict(id=prod.d['id'] * 10 + n, variantId=variant, key=key, width=W, height=W,
                         alt=L(a_ar, a_fr), position=n, placeholder=True))
        os.makedirs(os.path.join(SVG_OUT, slug), exist_ok=True)
        with open(os.path.join(SVG_OUT, slug, f'{n}.svg'), 'w', encoding='utf-8') as f:
            f.write(svg(prod, n, view, col))
    prod.d['images'] = rows
    dump(os.path.join(CAT, 'products', slug + '.json'), prod.d)

cats_path = os.path.join(CAT, 'categories.json')
own = {c['id'] for c in CATS}
existing = [c for c in json.load(open(cats_path, encoding='utf-8')) if c['id'] not in own]  # build_real.py's
dump(cats_path, existing + CATS)
print(f'{len(CATS)} placeholder categories, {len(PRODUCTS)} placeholder products, '
      f'{sum(len(p.images) for p in PRODUCTS)} photos, {sum(len(p.d["variants"]) for p in PRODUCTS)} variants')

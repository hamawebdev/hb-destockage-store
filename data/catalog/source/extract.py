# Usage: python3 -I extract.py <data/catalog/source> <dir holding the downloaded media originals>
# Extract a flat, faithful product list from the raw Store API dump + media manifest.
import json, sys, html, re, hashlib, os
from PIL import Image
src, media_dir = sys.argv[1], sys.argv[2]
raw = json.load(open(os.path.join(src, 'raw/wc-store-products-p1.json'), encoding='utf-8'))
media = json.load(open(os.path.join(src, 'raw/wp-v2-media.json'), encoding='utf-8'))
log = [l.split('\t') for l in open(os.path.join(src, 'fetch-log.tsv'), encoding='utf-8').read().splitlines()[1:]]
fetched = {l[1]: l[0] for l in log}
def text(h):
    h = re.sub(r'<figure.*?</figure>', '', h, flags=re.S)
    h = re.sub(r'<img[^>]*>', '', h)
    h = re.sub(r'</(p|li|h\d)>', '\n', h)
    h = re.sub(r'<[^>]+>', '', h)
    return re.sub(r'\n\s*\n+', '\n', html.unescape(h)).strip()
def dzd(minor, unit): return int(minor) // (10 ** unit) if minor else None
# What each image is (visual check + EXIF); 'collage' = Instagram screenshot of product renders.
MEDIA_NOTES = {
    4466: 'Attached to 4465. Instagram screenshot (EXIF software=Instagram): collage of product renders, price "14600 da" burned in.',
    4441: 'Attached to 4440. Instagram screenshot: collage of product renders, price "14600 da" burned in.',
    4436: 'Attached to 4435. Instagram screenshot: collage of product renders, price "14600 da" burned in.',
    4272: 'Attached to 4271. Instagram screenshot (EXIF description=Screenshot): collage of product renders, price "14600 Da" burned in.',
    147: 'Attached to 20. Instagram screenshot (EXIF description=Screenshot): collage of product renders, price "16500 Da" burned in.',
    498: 'Orphan upload. Client\'s own photograph (iPhone EXIF): the two shower-column control panels.',
    497: 'Orphan upload. Client\'s own photograph (iPhone EXIF): Pack B and Pack A side by side with paper price signs 13600 / 14600 DA.',
    410: 'Orphan upload. Instagram screenshot: collage of product renders, price "14500 Da" burned in (no current product has this price).',
    409: 'Orphan upload, alt "Pack nova 14500 DA". Instagram screenshot: collage of product renders, price "14500 Da" burned in (no current product has this price).',
    150: 'Orphan upload. Client\'s own photograph (iPhone EXIF, shared via Instagram): Pack B with price label "13600 Da".',
}
CATEGORY = 'Non classé (term id 15: id from raw/wp-v2-product.json product_cat, name from raw/wc-store-categories.json; the Store API product list returns no categories)'
out = []
for p in raw:
    pr = p['prices']; u = pr['currency_minor_unit']
    url = p['permalink']
    imgs, seen = [], set()
    for i in p['images']:
        if i['id'] in seen: continue
        seen.add(i['id']); imgs.append({'wp_media_id': i['id'], 'src': i['src'], 'alt': i['alt'], 'name': i['name']})
    out.append({
        'wc_id': p['id'], 'type': p['type'], 'slug': p['slug'], 'url': url,
        'name': html.unescape(p['name']), 'name_lang': 'fr',
        'price_dzd': dzd(pr['price'], u), 'regular_price_dzd': dzd(pr['regular_price'], u), 'sale_price_dzd': dzd(pr['sale_price'], u),
        'short_description_text': text(p['short_description']), 'description_text': text(p['description']), 'description_html': p['description'],
        'categories': [c['name'] for c in p['categories']] or [CATEGORY],
        'variants': [], 'attributes': p['attributes'], 'sku': p['sku'], 'in_stock': p['is_in_stock'], 'stock_remaining': p['low_stock_remaining'],
        'images': imgs, 'images_note': 'Store API lists the same image twice for this product (duplicate removed).' if len(p['images']) != len(imgs) else None,
        'fetched_at_api': fetched.get('https://hbdestockagedz.com/wp-json/wc/store/v1/products?per_page=100&page=1'),
        'fetched_at_html': fetched.get(url),
    })
man = []
for m in media:
    src_url = m['source_url']; orig = m['media_details'].get('original_image')
    full = src_url.rsplit('/', 1)[0] + '/' + orig if orig else src_url
    f = os.path.join(media_dir, os.path.basename(full))
    note = MEDIA_NOTES.get(m['id'])
    man.append({'wp_media_id': m['id'], 'attached_to_wc_id': m['post'], 'uploaded': m['date'], 'title': m['title']['rendered'], 'alt': m['alt_text'],
                'largest_url': full, 'width': Image.open(f).size[0], 'height': Image.open(f).size[1],
                'bytes': os.path.getsize(f), 'md5': hashlib.md5(open(f, 'rb').read()).hexdigest(), 'fetched_at': fetched.get(full), 'note': note})
json.dump({'source': 'https://hbdestockagedz.com/', 'fetched_on': '2026-11-04', 'currency': 'DZD', 'products': out, 'media': man}, open(os.path.join(src, 'products.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print(len(out), len(man))

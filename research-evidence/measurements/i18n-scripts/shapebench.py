import sys,time,uharfbuzz as hb
AR=("هذا المنتج الفاخر مصنوع من مواد عالية الجودة ومضمون لمدة سنتين. التوصيل متوفر إلى جميع الولايات "
    "والدفع عند الاستلام. اطلب الآن وسيتصل بك فريقنا لتأكيد الطلب خلال أربع وعشرين ساعة. السعر 189.000 د.ج ")
FR=("Ce produit haut de gamme est fabriqué avec des matériaux de qualité et garanti deux ans. Livraison "
    "disponible dans toutes les wilayas et paiement à la livraison. Commandez maintenant, notre équipe vous appelle. ")
def bench(path,text,lang,script,direction,n_chars=200000):
    blob=hb.Blob.from_file_path(path); face=hb.Face(blob); font=hb.Font(face)
    reps=n_chars//len(text)
    # paragraph-level shaping
    t=time.perf_counter()
    glyphs=0
    for _ in range(reps):
        b=hb.Buffer(); b.add_str(text); b.direction=direction; b.script=script; b.language=lang
        hb.shape(font,b,{}); glyphs+=len(b.glyph_infos)
    dt=time.perf_counter()-t
    return dt/(reps*len(text))*1e6*1000, glyphs/reps  # microseconds per 1000 chars
for path in sys.argv[1:]:
    for name,txt,lang,sc,d in [("ar",AR,"ar","Arab","rtl"),("fr",FR,"fr","Latn","ltr")]:
        best=min(bench(path,txt,lang,sc,d)[0] for _ in range(3))
        print(f"{path.rsplit('/',1)[-1]:32s} {name}  {best:8.1f} us per 1000 chars")

import sys,uharfbuzz as hb
AR=("هذا المنتج الفاخر مصنوع من مواد عالية الجودة ومضمون لمدة سنتين. التوصيل متوفر إلى جميع الولايات "
    "والدفع عند الاستلام. اطلب الآن وسيتصل بك فريقنا لتأكيد الطلب خلال أربع وعشرين ساعة.")
def width(path,wght=None):
    face=hb.Face(hb.Blob.from_file_path(path)); font=hb.Font(face)
    if wght and 'wght' in [a.tag for a in face.axis_infos]: font.set_variations({'wght':wght})
    b=hb.Buffer(); b.add_str(AR); b.guess_segment_properties(); hb.shape(font,b,{})
    return sum(p.x_advance for p in b.glyph_positions)/face.upem
base=width(sys.argv[1],400)
for p in sys.argv[1:]:
    w=width(p,400); print(f"{p.rsplit('/',1)[-1]:32s} width {w:7.2f} em  vs NotoNaskh {w/base*100:6.1f}%  size-adjust needed {base/w*100:6.1f}%")

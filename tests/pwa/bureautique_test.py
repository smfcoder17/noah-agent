"""Le texte d'un fichier bureautique, tiré de son archive : .docx, .xlsx, .pptx, .odt. Sans LibreOffice ni bibliothèque.

    docker run --rm -v "$PWD/server:/app" python:3.12-slim python /app/../tests/pwa/bureautique_test.py
"""
import io
import sys
import zipfile

sys.path.insert(0, "/app")
from noah import bureautique as b  # noqa: E402


def zip_of(entries: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, body in entries.items():
            z.writestr(name, body)
    return buf.getvalue()


DOCX = zip_of({"word/document.xml":
               '<w:document><w:body><w:p><w:r><w:t>Devis pour relecture</w:t></w:r></w:p>'
               '<w:p><w:r><w:t>Total : </w:t></w:r><w:r><w:t>1 250 $</w:t></w:r></w:p></w:body></w:document>'})
HEADER = zip_of({"word/document.xml": '<w:document><w:body><w:p><w:r><w:t>Corps</w:t></w:r></w:p></w:body></w:document>',
                 "word/header1.xml": '<w:hdr><w:p><w:r><w:t>En-tête confidentiel</w:t></w:r></w:p></w:hdr>'})
XLSX = zip_of({
    "xl/workbook.xml": '<workbook><sheets><sheet name="Ventes"/></sheets></workbook>',
    "xl/sharedStrings.xml": "<sst><si><t>Nom</t></si><si><t>Prix</t></si><si><t>Vis</t></si></sst>",
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>'
                                '<row><c t="s"><v>2</v></c><c><v>12.5</v></c></row></sheetData></worksheet>',
})
PPTX = zip_of({"ppt/slides/slide1.xml": "<p:sld><a:txBody><a:p><a:r><a:t>Titre</a:t></a:r></a:p><a:p><a:r><a:t>Point</a:t></a:r></a:p></a:txBody></p:sld>",
               "ppt/slides/slide2.xml": "<p:sld><a:txBody><a:p><a:r><a:t>Suite</a:t></a:r></a:p></a:txBody></p:sld>"})
ODT = zip_of({"content.xml": '<office><text:h>Chapitre</text:h><text:p>Un <text:s/>mot</text:p></office>'})

assert b.text_of("devis.docx", DOCX) == "Devis pour relecture\n\nTotal : 1 250 $", repr(b.text_of("devis.docx", DOCX))
assert "En-tête confidentiel" in b.text_of("a.docx", HEADER) and "Corps" in b.text_of("a.docx", HEADER), "l'en-tête se lit aussi"
assert b.text_of("t.xlsx", XLSX) == "## Ventes\n\n| Nom | Prix |\n| Vis | 12.5 |", repr(b.text_of("t.xlsx", XLSX))
pptx = b.text_of("d.pptx", PPTX)
assert "## Diapositive 1" in pptx and "Titre" in pptx and "## Diapositive 2" in pptx and "Suite" in pptx, pptx
assert b.text_of("n.odt", ODT) == "Chapitre\n\nUn mot", repr(b.text_of("n.odt", ODT))
# Ce que l'interface doit savoir avant d'essayer.
assert b.readable("Rapport.DOCX") and b.readable("a.xlsm") and b.readable("x.pptx") and b.readable("n.ods")
assert not b.readable("photo.png") and not b.readable("notes.txt") and not b.readable("a.zip")
# Un fichier qui n'est pas ce que son nom annonce : une erreur claire, jamais une trace.
for bad in (b"pas un zip", b""):
    try:
        b.text_of("faux.docx", bad)
    except ValueError as e:
        assert str(e) in ("fichier illisible", "fichier trop volumineux"), e
    else:
        raise AssertionError("un faux docx doit être refusé")
# Une archive qui se décompresse énormément est refusée avant de tenir la mémoire.
bombe = io.BytesIO()
with zipfile.ZipFile(bombe, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("word/document.xml", "<w:p>" + "a" * 4_000_000 + "</w:p>")
try:
    b.text_of("bombe.docx", bombe.getvalue())
except ValueError as e:
    assert "suspecte" in str(e), e
else:
    raise AssertionError("une bombe zip doit être refusée")
print("bureautique : docx, xlsx, pptx et odt se lisent ; inconnu, faux et bombe zip sont refusés")

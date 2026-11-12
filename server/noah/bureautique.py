"""Lire un fichier bureautique sans le convertir : le texte d'un .docx, .xlsx, .pptx ou .odt, tiré de son archive.

Aucune dépendance : ces formats sont des archives ZIP contenant du XML. Le serveur en extrait le texte lisible, que
l'interface montre comme un document. Une conversion en PDF demanderait LibreOffice, absent de l'image, et une
bibliothèque de plus ; ici, le texte suffit à relire un devis, un rapport ou un tableau.
"""
import io
import re
import zipfile

MAX_BYTES = 60 * 1024 * 1024  # au-delà, on ne décompresse pas : un fichier piégé tiendrait la mémoire
MAX_TEXT = 2 * 1024 * 1024  # ce qui est montré ; le reste reste téléchargeable
MAX_ENTRIES = 4000
MAX_RATIO = 400  # une bombe zip a un ratio énorme ; un document réel reste loin en dessous

# Ce qu'on ne veut jamais voir dans le texte rendu.
_XML_TAG = re.compile(r"<[^>]{1,4000}>")
_WS = re.compile(r"[ \t\u00a0]+")


def _read(archive: zipfile.ZipFile, name: str) -> str:
    info = archive.getinfo(name)
    if info.file_size > MAX_BYTES or (info.compress_size and info.file_size / info.compress_size > MAX_RATIO):
        raise ValueError("archive suspecte")
    return archive.read(name).decode("utf-8", "replace")


def _paragraphs(xml: str, tag: str) -> list[str]:
    """Un paragraphe par balise : le texte entre les balises, entités résolues, espaces normalisés."""
    out = []
    for chunk in re.findall(rf"<{tag}(?:\s[^>]*)?>(.*?)</{tag}>", xml, re.S):
        text = _XML_TAG.sub("", chunk)
        text = (text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
                    .replace("&quot;", '"').replace("&apos;", "'").replace("&#10;", "\n"))
        text = _WS.sub(" ", text).strip()
        if text:
            out.append(text)
    return out


def _docx(archive: zipfile.ZipFile) -> str:
    lines: list[str] = []
    names = ["word/document.xml"] + sorted(n for n in archive.namelist() if re.fullmatch(r"word/(header|footer)\d*\.xml", n))
    for name in names:
        if name not in archive.namelist():
            continue
        xml = _read(archive, name)
        # Les sauts de ligne vivent dans les <w:br/> et les tabulations dans <w:tab/>.
        xml = xml.replace("<w:br/>", "\n").replace("<w:br />", "\n").replace("<w:tab/>", "\t").replace("<w:tab />", "\t")
        lines += _paragraphs(xml, "w:p")
    return "\n\n".join(lines)


def _pptx(archive: zipfile.ZipFile) -> str:
    slides = sorted((n for n in archive.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)),
                    key=lambda n: int(re.search(r"(\d+)\.xml$", n).group(1)))
    out = []
    for i, name in enumerate(slides, 1):
        text = "\n".join(_paragraphs(_read(archive, name), "a:p"))
        if text:
            out.append(f"## Diapositive {i}\n\n{text}")
    return "\n\n".join(out)


def _xlsx(archive: zipfile.ZipFile) -> str:
    """Les feuilles en markdown : une ligne par ligne, les colonnes séparées par « | ». Les valeurs mises en cache dans
    la feuille sont suffisantes pour lire ; les formules ne le sont pas."""
    shared: list[str] = []
    if "xl/sharedStrings.xml" in archive.namelist():
        for chunk in re.findall(r"<si(?:\s[^>]*)?>(.*?)</si>", _read(archive, "xl/sharedStrings.xml"), re.S):
            pieces = [_XML_TAG.sub("", t) for t in re.findall(r"<t(?:\s[^>]*)?>(.*?)</t>", chunk, re.S)]
            shared.append(_WS.sub(" ", "".join(pieces)).strip())
    titles: dict[str, str] = {}
    if "xl/workbook.xml" in archive.namelist():
        book = _read(archive, "xl/workbook.xml")
        for i, name in enumerate(re.findall(r"<sheet[^>]*\bname=\"([^\"]*)\"", book), 1):
            titles[f"xl/worksheets/sheet{i}.xml"] = (name.replace("&amp;", "&").replace("&quot;", '"').replace("&apos;", "'"))
    out = []
    for name in sorted(n for n in archive.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)):
        rows: list[list[str]] = []
        for row in re.findall(r"<row(?:\s[^>]*)?>(.*?)</row>", _read(archive, name), re.S):
            cells = []
            for attrs, body in re.findall(r"<c([^>]*)>(.*?)</c>", row, re.S):
                kind = re.search(r"\bt=\"([^\"]+)\"", attrs)
                value = re.search(r"<v>(.*?)</v>", body, re.S)
                inline = re.findall(r"<t(?:\s[^>]*)?>(.*?)</t>", body, re.S)
                if inline:
                    text = "".join(_XML_TAG.sub("", t) for t in inline)
                elif kind and kind.group(1) == "s" and value:
                    try:
                        text = shared[int(value.group(1))]
                    except (ValueError, IndexError):
                        text = ""
                elif value:
                    text = _XML_TAG.sub("", value.group(1))
                else:
                    text = ""
                cells.append(_WS.sub(" ", text).strip().replace("|", "\\|"))
            while cells and not cells[-1]:
                cells.pop()
            if cells:
                rows.append(cells)
        if not rows:
            continue
        width = max(len(r) for r in rows)
        body = ["| " + " | ".join(r + [""] * (width - len(r))) + " |" for r in rows]
        out.append(f"## {titles.get(name, 'Feuille')}\n\n" + "\n".join(body))
    return "\n\n".join(out)


def _odf(archive: zipfile.ZipFile) -> str:
    """OpenDocument (.odt, .ods, .odp) : un content.xml, des paragraphes et des titres."""
    if "content.xml" not in archive.namelist():
        return ""
    xml = _read(archive, "content.xml")
    xml = xml.replace("<text:line-break/>", "\n").replace("<text:tab/>", "\t").replace("<text:s/>", " ")
    lines = []
    for tag in ("text:h", "text:p"):
        lines += _paragraphs(xml, tag)
    return "\n\n".join(lines)


READERS = {
    "docx": _docx, "docm": _docx, "dotx": _docx,
    "pptx": _pptx, "pptm": _pptx,
    "xlsx": _xlsx, "xlsm": _xlsx,
    "odt": _odf, "ods": _odf, "odp": _odf,
}


def extension(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def readable(name: str) -> bool:
    return extension(name) in READERS


def text_of(name: str, data: bytes) -> str:
    """Le texte lisible d'un fichier bureautique. Lève ValueError si le fichier n'est pas ce que son nom annonce."""
    reader = READERS.get(extension(name))
    if not reader:
        raise ValueError("format non pris en charge")
    if len(data) > MAX_BYTES:
        raise ValueError("fichier trop volumineux")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            if len(archive.infolist()) > MAX_ENTRIES:
                raise ValueError("archive suspecte")
            text = reader(archive)
    except zipfile.BadZipFile as e:
        raise ValueError("fichier illisible") from e
    return text[:MAX_TEXT]

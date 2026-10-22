"""从内存中的课程文件提取可检索文本，不写入原始文件。"""

from __future__ import annotations

import io
import json
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter

MAX_INPUT = 100_000_000
MAX_PARTS = 100
MAX_TEXT_PER_PART = 5_000
MAX_TEXT_PER_PAGE = 100_000
MAX_OUTPUT_BYTES = 1_500_000
MAX_ZIP_TOTAL = 80_000_000
MAX_ZIP_ENTRY = 15_000_000


def clean(value: str) -> str:
    return " ".join(value.split())


def part(index: int, text: str) -> dict:
    cleaned = clean(text)
    return {"number": index, "text": cleaned[:MAX_TEXT_PER_PAGE], "truncated": len(cleaned) > MAX_TEXT_PER_PAGE}


def pdf_parts(data: bytes) -> tuple[list[dict], int]:
    import fitz

    document = fitz.open(stream=data, filetype="pdf")
    try:
        total = len(document)
        result = [part(i + 1, document[i].get_text()) for i in range(min(total, MAX_PARTS))]
        empty_indexes = [i for i, item in enumerate(result) if not item['text']]
        if empty_indexes:
            # 空文本不等于空白：扫描图、图表、批注和表单必须继续标为未读取。
            drawings = [page.get_drawings() for page in document.pages(0, len(result))]
            def decoration_signature(page, drawing):
                rect, box = drawing['rect'], page.rect
                if min(rect.width, rect.height) > 2 or (drawing.get('width') or 0) > 2:
                    return None
                if any(item[0] not in {'re', 'l'} for item in drawing.get('items', [])):
                    return None
                edge = (rect.x1 <= box.x0 + box.width * .06 or rect.x0 >= box.x1 - box.width * .06 or
                        rect.y1 <= box.y0 + box.height * .06 or rect.y0 >= box.y1 - box.height * .06)
                header = rect.height <= 2 and rect.y1 <= box.y0 + box.height * .15 and rect.width >= box.width * .5
                if not (edge or header):
                    return None
                return (tuple(round(v, 2) for v in rect), drawing.get('type'), drawing.get('color'),
                        drawing.get('fill'), round(drawing.get('width') or 0, 2))
            frequency = Counter()
            for i, shapes in enumerate(drawings):
                frequency.update({s for shape in shapes if (s := decoration_signature(document[i], shape)) is not None})
            for i in empty_indexes:
                page = document[i]
                if page.get_images(full=True) or list(page.annots() or []) or list(page.widgets() or []):
                    continue
                shapes = drawings[i]
                if not shapes:
                    scale = min(1, 1000 / max(page.rect.width, page.rect.height))
                    pixels = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csGRAY, alpha=False)
                    if pixels.samples and min(pixels.samples) == 255:
                        result[i]['blankKind'] = 'white'
                elif len(shapes) <= 64 and len(result) >= 3:
                    signatures = [decoration_signature(page, shape) for shape in shapes]
                    # 只认正文页反复出现的页边框/页眉细线，不能把正文区域的图形当作空白。
                    threshold = 3
                    if all(signature is not None and frequency[signature] >= threshold for signature in signatures):
                        result[i]['blankKind'] = 'repeated-page-decoration'
        # OCR 是空文本页的补充通道，依赖缺失不能使已有 PDF 正文全部丢失。
        if any(not item['text'] and not item.get('blankKind') for item in result):
            try:
                from pdf_ocr import enrich_empty_pdf_pages
                enrich_empty_pdf_pages(data, result, total_timeout=18.0)
            except (ImportError, OSError, RuntimeError, ValueError):
                for item in result:
                    if not item['text'] and not item.get('blankKind'):
                        item['ocr'] = {'status': 'unavailable'}
        return result, total
    finally:
        document.close()


def safe_zip(data: bytes) -> zipfile.ZipFile:
    archive = zipfile.ZipFile(io.BytesIO(data))
    entries = archive.infolist()
    # 只解析正文 XML，不解压图片/视频；大型课件通常由这些媒体占据体积。
    text_entries = [item for item in entries if item.filename.endswith('.xml')]
    if len(entries) > 2000 or len({item.filename for item in entries}) != len(entries) or sum(item.file_size for item in text_entries) > MAX_ZIP_TOTAL:
        archive.close()
        raise ValueError("Office 文件解压后过大")
    if any(item.file_size > MAX_ZIP_ENTRY for item in text_entries):
        archive.close()
        raise ValueError("Office 文件包含过大的内部文件")
    return archive


def xml_text(raw: bytes, tag: str) -> str:
    root = ET.fromstring(raw)
    return " ".join(node.text or "" for node in root.iter() if node.tag.endswith("}" + tag))


def split_text(text: str) -> tuple[list[dict], int]:
    text = clean(text)
    total = (len(text) + MAX_TEXT_PER_PART - 1) // MAX_TEXT_PER_PART
    return [part(i + 1, text[i * MAX_TEXT_PER_PART:(i + 1) * MAX_TEXT_PER_PART]) for i in range(min(total, MAX_PARTS))], total


def office_parts(data: bytes, kind: str) -> tuple[list[dict], int]:
    with safe_zip(data) as archive:
        names = set(archive.namelist())
        if kind == "docx":
            if "word/document.xml" not in names:
                raise ValueError("Word 文件结构无效")
            return split_text(xml_text(archive.read("word/document.xml"), "t"))
        if kind == "pptx":
            slides = sorted((name for name in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)), key=lambda name: int(re.search(r"slide(\d+)", name).group(1)))
            return [part(i + 1, xml_text(archive.read(name), "t")) for i, name in enumerate(slides[:MAX_PARTS])], len(slides)
        if kind == "xlsx":
            shared = []
            if "xl/sharedStrings.xml" in names:
                root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
                shared = [" ".join(node.text or "" for node in item.iter() if node.tag.endswith("}t")) for item in root if item.tag.endswith("}si")]
            sheets = sorted((name for name in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name)), key=lambda name: int(re.search(r"sheet(\d+)", name).group(1)))
            result = []
            for i, name in enumerate(sheets[:MAX_PARTS]):
                root = ET.fromstring(archive.read(name))
                cells = []
                for cell in root.iter():
                    if not cell.tag.endswith("}c"):
                        continue
                    value = next((node.text or "" for node in cell.iter() if node.tag.endswith("}v")), "")
                    if cell.get("t") == "s" and value.isdigit() and int(value) < len(shared):
                        value = shared[int(value)]
                    elif cell.get("t") == "inlineStr":
                        value = " ".join(node.text or "" for node in cell.iter() if node.tag.endswith("}t"))
                    if value:
                        cells.append(f"{cell.get('r', '')}: {value}")
                result.append(part(i + 1, " ".join(cells)))
            return result, len(sheets)
    raise ValueError("不支持的 Office 格式")


def detect(data: bytes, filename: str, mime: str) -> str:
    lower = filename.lower().split("?", 1)[0]
    if data.startswith(b"%PDF-"):
        return "pdf"
    if data.startswith(b"PK\x03\x04"):
        with safe_zip(data) as archive:
            names = set(archive.namelist())
        if "word/document.xml" in names:
            return "docx"
        if any(name.startswith("ppt/slides/slide") for name in names):
            return "pptx"
        if any(name.startswith("xl/worksheets/sheet") for name in names):
            return "xlsx"
    if lower.endswith((".txt", ".csv")) or mime.startswith("text/"):
        return "text"
    raise ValueError("仅支持可提取文本的 PDF、DOCX、PPTX、XLSX、TXT、CSV")


def extract(data: bytes, filename: str, mime: str) -> dict:
    if not data or len(data) > MAX_INPUT:
        raise ValueError("文件为空或超过 100 MB 上限")
    kind = detect(data, filename, mime)
    if kind == "pdf":
        documents, total = pdf_parts(data)
    elif kind in {"docx", "pptx", "xlsx"}:
        documents, total = office_parts(data, kind)
    else:
        try:
            decoded = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            decoded = data.decode("utf-16") if data[:2] in (b"\xff\xfe", b"\xfe\xff") else data.decode("cp1252", errors="replace")
        documents, total = split_text(decoded)
    nonempty = [item for item in documents if item["text"]]
    if not nonempty:
        raise ValueError("文件中没有可提取的文字，可能是扫描件或图片课件")
    # 长页分段保存，number 始终是原始页码，不能把分段序号当成 PDF 页码。
    chunks = []
    for item in nonempty:
        count = (len(item["text"]) + MAX_TEXT_PER_PART - 1) // MAX_TEXT_PER_PART
        for index in range(count):
            chunk = {"number": item["number"], "text": item["text"][index * MAX_TEXT_PER_PART:(index + 1) * MAX_TEXT_PER_PART],
                     "truncated": item["truncated"] and index == count - 1}
            if item.get('extractionMethod') == 'ocr':
                chunk['extractionMethod'] = 'ocr'
                chunk['ocrConfidence'] = item.get('ocrConfidence', 0)
                if item.get('ocr', {}).get('status') == 'partial':
                    chunk['truncated'] = True
            if count > 1:
                chunk["chunkIndex"] = index + 1
            chunks.append(chunk)
    # 保持后台响应上限；超出预算的分段必须明确记为缺失，不能伪装完整。
    kept = []
    output_bytes = 0
    for chunk in chunks:
        size = len(json.dumps(chunk, ensure_ascii=False).encode("utf-8")) + 2
        if output_bytes + size > MAX_OUTPUT_BYTES:
            break
        output_bytes += size
        kept.append(chunk)
    blank_pages = [item['number'] for item in documents if item.get('blankKind')]
    empty = len(documents) - len(nonempty) - len(blank_pages)
    unscanned = max(0, total - len(documents))
    return {"kind": kind, "documents": kept, "totalParts": len(chunks) + empty + unscanned,
            "skippedParts": unscanned + len(chunks) - len(kept), "emptyParts": empty,
            "truncatedParts": sum(item["truncated"] for item in kept),
            "blankParts": len(blank_pages), "blankPages": blank_pages, "physicalParts": total,
            "emptyPages": [item['number'] for item in documents if not item['text'] and not item.get('blankKind')],
            "ocrParts": sum(item.get('extractionMethod') == 'ocr' for item in documents)}


if __name__ == "__main__":
    try:
        info = json.loads(sys.argv[1])
        data = sys.stdin.buffer.read(MAX_INPUT + 1)
        print(json.dumps(extract(data, info.get("filename", ""), info.get("mime", "")), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        sys.exit(1)

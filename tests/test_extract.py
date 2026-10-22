import io
import sys
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from extract import extract


def archive(files):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as output:
        for name, content in files.items():
            output.writestr(name, content)
    return buffer.getvalue()


class ExtractionTests(unittest.TestCase):
    def test_pdf_page_text_and_page_number(self):
        import fitz

        document = fitz.open()
        page = document.new_page()
        page.insert_text((40, 40), "Newton motion lecture")
        result = extract(document.tobytes(), "lecture.pdf", "application/pdf")
        self.assertEqual(result["kind"], "pdf")
        self.assertEqual(result["documents"][0]["number"], 1)
        self.assertIn("Newton motion lecture", result["documents"][0]["text"])

    def test_docx_text(self):
        data = archive({"word/document.xml": '<w:document xmlns:w="urn:w"><w:body><w:p><w:t>Course concept</w:t></w:p></w:body></w:document>'})
        result = extract(data, "notes.docx", "application/octet-stream")
        self.assertEqual(result["kind"], "docx")
        self.assertIn("Course concept", result["documents"][0]["text"])

    def test_pptx_slide_order(self):
        data = archive({
            "ppt/slides/slide10.xml": '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:t>Last slide</a:t></p:sld>',
            "ppt/slides/slide2.xml": '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:t>First slide</a:t></p:sld>',
        })
        result = extract(data, "lecture.pptx", "application/octet-stream")
        self.assertEqual([item["text"] for item in result["documents"]], ["First slide", "Last slide"])

    def test_xlsx_shared_and_inline_strings(self):
        data = archive({
            "xl/sharedStrings.xml": '<sst xmlns="urn:x"><si><t>Core concept</t></si></sst>',
            "xl/worksheets/sheet1.xml": '<worksheet xmlns="urn:x"><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Result</t></is></c></row></sheetData></worksheet>',
        })
        result = extract(data, "data.xlsx", "application/octet-stream")
        self.assertEqual(result["kind"], "xlsx")
        self.assertIn("A1: Core concept", result["documents"][0]["text"])
        self.assertIn("B1: Result", result["documents"][0]["text"])

    def test_rejects_image_only_pdf(self):
        import fitz

        document = fitz.open()
        document.new_page()
        with self.assertRaisesRegex(ValueError, "没有可提取的文字"):
            extract(document.tobytes(), "scan.pdf", "application/pdf")

    def test_rejects_oversize(self):
        with self.assertRaisesRegex(ValueError, "20 MB"):
            extract(b"x" * 20_000_001, "notes.txt", "text/plain")

    def test_reports_text_parts_skipped_at_cap(self):
        result = extract(b"a" * (101 * 5_000), "notes.txt", "text/plain")
        self.assertEqual(result["totalParts"], 101)
        self.assertEqual(len(result["documents"]), 100)
        self.assertEqual(result["skippedParts"], 1)


if __name__ == "__main__":
    unittest.main()

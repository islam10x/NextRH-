import fitz
from app.parsers.template_parser import TemplateCVParser
import json

def run():
    file_path = r"c:\Users\islam\Projects\NextRH\ai-service\templates\cv_ak_abidi.pdf"
    
    parser = TemplateCVParser()
    text = ""
    parser._layout_lines = []
    
    with fitz.open(file_path) as doc:
        page_offset = 0.0
        for page_index, page in enumerate(doc):
            text += page.get_text("text", sort=True)
            parser._layout_lines.extend(
                parser._build_layout_lines(page, page_index, page_offset)
            )
            page_offset += float(page.rect.height) + 120.0
            
    parser._layout_lines.sort(key=lambda item: (item["page"], item["y0"], item["x0"]))
    for order, item in enumerate(parser._layout_lines):
        item["order"] = order

    text = text.replace("\xa0", " ")
    text = text.replace("\n\n\n", "\n\n")
    
    lines = [line.rstrip() for line in text.splitlines() if line.strip()]

    print("\nEXTRACTING CERTIFICATIONS:")
    certs = parser._extract_certifications(text, lines, file_path)
    print("CERTS:", json.dumps(certs, indent=2, ensure_ascii=False))

    print("\nEXTRACTING EDUCATION:")
    edu = parser._extract_education(text, lines)
    print("EDU:", json.dumps(edu, indent=2, ensure_ascii=False))

if __name__ == "__main__":
    run()

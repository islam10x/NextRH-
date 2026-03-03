import fitz
from app.parsers.template_parser import TemplateCVParser
import json

def run():
    file_path = r"c:\Users\islam\Projects\NextRH\ai-service\templates\cv_ak_abidi.pdf"
    
    parser = TemplateCVParser()
    parser._layout_lines = []
    
    with fitz.open(file_path) as doc:
        page_offset = 0.0
        for page_index, page in enumerate(doc):
            parser._layout_lines.extend(
                parser._build_layout_lines(page, page_index, page_offset)
            )
            page_offset += float(page.rect.height) + 120.0
            
    parser._layout_lines.sort(key=lambda item: (item["page"], item["y0"], item["x0"]))
    for order, item in enumerate(parser._layout_lines):
        item["order"] = order

    layout_text = parser._reconstruct_text_from_layout()
    print("LAYOUT TEXT RECONSTRUCTION:")
    print("----------------------------")
    print(layout_text)
    print("----------------------------")

if __name__ == "__main__":
    run()

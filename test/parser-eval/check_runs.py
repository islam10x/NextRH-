import zipfile
import re

template = r"c:\Users\islam\Projects\NextRH-\test\test-templates\Document 1.docx"

with zipfile.ZipFile(template, 'r') as zf:
    xml = zf.read("word/document.xml").decode("utf-8")
    
# Extract all w:t tags
texts = re.findall(r'<w:t(?:[^>]*)>([^<]*)</w:t>', xml)
for t in texts:
    if "programming" in t.lower() or "skills" in t.lower():
        print(repr(t))

import zipfile
import re

template = r"c:\Users\islam\Projects\NextRH-\test\test-templates\Document 1.docx"

with zipfile.ZipFile(template, 'r') as zf:
    xml = zf.read("word/document.xml").decode("utf-8")
    
# Find <w:p> that contains 'Skills'
paras = re.findall(r'<w:p[ >].*?</w:p>', xml, re.DOTALL)
for p in paras:
    if 'Skills' in p and 'w:t' in p:
        print(p)

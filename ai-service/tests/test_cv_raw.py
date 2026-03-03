from app.parsers.template_parser import TemplateCVParser
import json

def run():
    file_path = r"c:\Users\islam\Projects\NextRH\ai-service\templates\cv_ak_abidi.pdf"
    
    parser = TemplateCVParser()
    result = parser.parse(file_path)
    
    print("RAW TEXT:")
    print(result.get("raw_text"))

if __name__ == "__main__":
    run()

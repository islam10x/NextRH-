from app.parsers.template_parser import TemplateCVParser
import json

def run():
    file_path = r"c:\Users\islam\Projects\NextRH\ai-service\templates\cv_ak_abidi.pdf"
    
    parser = TemplateCVParser()
    result = parser.parse(file_path)
    
    print("EXPERIENCE:")
    print(json.dumps(result.get("experience"), indent=2, ensure_ascii=False))

    print("\nEDUCATION:")
    print(json.dumps(result.get("education"), indent=2, ensure_ascii=False))

    print("\nCERTIFICATIONS:")
    print(json.dumps(result.get("certifications"), indent=2, ensure_ascii=False))

if __name__ == "__main__":
    run()

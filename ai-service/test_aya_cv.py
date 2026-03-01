from app.parsers.template_parser import TemplateCVParser
import json

def run():
    file_path = r"C:\Users\islam\Projects\NextRH\backend\file-storage\CV_Database\Aya_Ben_Jemaa_6b7f3275\CV.pdf"
    
    parser = TemplateCVParser()
    try:
        result = parser.parse(file_path)
        
        print("\nEDUCATION:")
        print(json.dumps(result.get("education"), indent=2, ensure_ascii=False))

        print("\nPROJECTS:")
        print(json.dumps(result.get("projects"), indent=2, ensure_ascii=False))

        print("\nEXPERIENCE:")
        print(json.dumps(result.get("experience"), indent=2, ensure_ascii=False))
        
    except Exception as e:
        print(f"Failed to parse: {e}")

if __name__ == "__main__":
    run()

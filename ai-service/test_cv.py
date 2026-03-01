import os
import json
import requests

def run():
    files = [
        r"c:\Users\islam\Projects\NextRH\ai-service\templates\cv_ak_abidi.pdf",
        r"c:\Users\islam\Projects\NextRH\ai-service\templates\CV & Dip & Certif Anouar ABDALLAH 2021-1-3.pdf",
        r"c:\Users\islam\Projects\NextRH\ai-service\templates\CV + DIP + CERTIF EYA BEN JEMAA-1-2-1.pdf",
        r"c:\Users\islam\Projects\NextRH\ai-service\templates\CV + DIP + CERTIF JAZIL GAFSI-1-3.pdf",
        r"c:\Users\islam\Projects\NextRH\ai-service\templates\CV amal khalfaoui 2024.pdf"
    ]
    
    url = "http://127.0.0.1:8000/api/v1/parsing/cv"
    
    for file_path in files:
        print(f"\n--- Testing extraction via API on {os.path.basename(file_path)} ---")
        try:
            with open(file_path, "rb") as f:
                files_data = {"file": (os.path.basename(file_path), f, "application/pdf")}
                data = {"user_id": "test_user_id"}
                
                response = requests.post(url, files=files_data, data=data)
                
            if response.status_code == 200:
                result = response.json()
                print("EXPERIENCE:")
                if 'structured_data' in result and 'experience' in result['structured_data']:
                    print(json.dumps(result['structured_data']['experience'], indent=2, ensure_ascii=False))
                else: 
                    print(json.dumps(result.get('experience', []), indent=2, ensure_ascii=False))
            else:
                print(f"FAILED with status code {response.status_code}: {response.text}")
                
        except Exception as e:
            print("ERROR:", e)

if __name__ == "__main__":
    run()

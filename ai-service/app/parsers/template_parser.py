import fitz
import re
from typing import Dict, Any, List
from app.utils.logger import logger

class TemplateCVParser:
    def parse(self, file_path: str) -> Dict[str, Any]:
        """
        Parses the specific 'Next Step IT' CV template.
        """
        text = ""
        try:
            with fitz.open(file_path) as doc:
                for page in doc:
                    text += page.get_text()
        except Exception as e:
            logger.error(f"Failed to read PDF: {e}")
            raise ValueError("Could not read file")

        data = {
            "first_name": "",
            "last_name": "",
            "email": "",
            "phone": "",
            "address": "",
            "experience": [],
            "certifications": [],
            "education": []
        }

        # 1. Basic Info (Name is usually at the top)
        lines = [line.strip() for line in text.split('\n') if line.strip()]
        if lines:
            # Assuming "Firstname LASTNAME" format on first line
            name_parts = lines[0].split()
            if len(name_parts) >= 2:
                data["first_name"] = name_parts[0]
                data["last_name"] = " ".join(name_parts[1:])

        # 2. Contact Info using Regex
        email_match = re.search(r"Email\s*:\s*([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)", text)
        if email_match:
            data["email"] = email_match.group(1)

        phone_match = re.search(r"Tél\s*:\s*([\+\d\s]+)", text)
        if phone_match:
            data["phone"] = phone_match.group(1).strip()
            
        # Helper to get lines between two markers (bilingual)
        def get_section_lines(start_keywords: List[str], end_keywords: List[str]):
            try:
                # Find the start marker
                start_idx = -1
                for key in start_keywords:
                    idx = text.lower().find(key.lower())
                    if idx != -1:
                        start_idx = idx
                        break
                
                if start_idx == -1: return []
                
                # Find the end marker after the start marker
                sub_text = text[start_idx:]
                
                end_idx = len(sub_text)
                for key in end_keywords:
                    idx = sub_text.lower().find(key.lower())
                    if idx != -1 and idx < end_idx:
                        end_idx = idx
                
                section_text = sub_text[:end_idx]
                return [l.strip() for l in section_text.split('\n') if l.strip()]
            except:
                return []

        # Keywords Mapping
        keys = {
            "exp": ["Expérience professionnelle", "Professional Experience", "Work Experience"],
            "cert": ["Certification", "Certifications"],
            "edu": ["Formation académique", "Education", "Academic Background"],
            "proj": ["Projets", "Projects", "Key Projects"],
            "skills": ["Compétences", "Skills", "Technical Skills"],
            "addr_stop": ["Expérience", "Professional", "Work"],
            "degree": ["Diplôme", "Licence", "Master", "Baccalauréat", "Ingénieur", "Degree", "Bachelor", "Engineer", "PhD", "Doctorat"],
            "date_months": r"(Depuis|Janvier|Février|Mars|Avril|Mai|Juin|Juillet|Août|Septembre|Octobre|Novembre|Décembre|Since|January|February|March|April|May|June|July|August|September|October|November|December)"
        }

        # Fix: Stop address at "Expérience" or English equivalent
        stop_pattern = "|".join(keys["addr_stop"])
        address_match = re.search(r"Adresse\s*:\s*(.+?)(?=\n\n|\Z|" + stop_pattern + ")", text, re.DOTALL | re.IGNORECASE)
        if address_match:
             data["address"] = address_match.group(1).replace('\n', ' ').strip()

        # 3. Experience Section
        exp_lines = get_section_lines(keys["exp"], keys["cert"])
        
        # Skip headers if present
        # Heuristic: Find line with "Fonction" or "Role"/ "Title"
        try:
            header_idx = -1
            for i, line in enumerate(exp_lines):
                if any(k in line for k in ["Fonction", "Role", "Title", "Position"]):
                    header_idx = i
                    break
            exp_lines = exp_lines[header_idx+1:] if header_idx != -1 else exp_lines
        except: pass

        date_pattern = keys["date_months"] + r"\s*\d{4}"
        
        current_exp = {}
        for line in exp_lines:
            if re.search(date_pattern, line, re.IGNORECASE):
                if current_exp: data["experience"].append(current_exp)
                current_exp = {"start_date": line, "company": "", "title": ""}
            elif current_exp.get("start_date") and not current_exp.get("company"):
                current_exp["company"] = line
            elif current_exp.get("company"):
                if current_exp.get("title"):
                    current_exp["title"] += " " + line
                else:
                     current_exp["title"] = line
        if current_exp: data["experience"].append(current_exp)

        # 4. Certification Section
        cert_lines = get_section_lines(keys["cert"], keys["edu"]) 
        
        # Skip headers
        try:
            start_idx = -1
            for i, line in enumerate(cert_lines):
                if any(k in line for k in ["Date", "Obtained"]):
                        start_idx = i
                        break
            cert_lines = cert_lines[start_idx+1:] if start_idx != -1 else cert_lines
        except: pass
            
        current_cert = {}
        for line in cert_lines:
            if re.search(date_pattern, line, re.IGNORECASE):
                 if current_cert.get("name"):
                     current_cert["date_obtained"] = line
                     data["certifications"].append(current_cert)
                     current_cert = {} 
            else:
                if current_cert.get("name"):
                     current_cert["name"] += " " + line
                else:
                     current_cert["name"] = line
        # Catch last cert if it has no date? Rare in this format but good practice
        if current_cert.get("name") and not current_cert.get("date_obtained"):
             # For now discard or append
             pass

        # 5. Education Section
        edu_lines = get_section_lines(keys["edu"], keys["proj"])
        
        # Skip headers
        try:
            start_idx = -1
            for i, line in enumerate(edu_lines):
                if any(k in line for k in ["Diplôme", "Degree", "Diploma"]):
                        start_idx = i
                        break
            edu_lines = edu_lines[start_idx+1:] if start_idx != -1 else edu_lines
        except: pass
        
        current_edu = {}
        year_pattern = r"^\d{4}$"
        
        for line in edu_lines:
            if re.match(year_pattern, line):
                if current_edu: data["education"].append(current_edu)
                current_edu = {"end_date": line, "institution": "", "degree": ""}
            elif current_edu.get("end_date") and not current_edu.get("institution"):
                if current_edu["institution"]:
                        current_edu["institution"] += " " + line
                else:
                        current_edu["institution"] = line
                        
                # Check for Degree start
                degree_keywords = keys["degree"]
                if any(keyword.lower() in line.lower() for keyword in degree_keywords) and len(current_edu["institution"]) > len(line):
                        pass
                        
            elif current_edu.get("institution"):
                    degree_keywords = keys["degree"]
                    is_degree_start = any(line.strip().lower().startswith(k.lower()) for k in degree_keywords)
                    
                    if not current_edu["degree"] and not is_degree_start:
                        current_edu["institution"] += " " + line
                    else:
                        if current_edu["degree"]:
                            current_edu["degree"] += " " + line
                        else:
                            current_edu["degree"] = line
                            
        if current_edu: data["education"].append(current_edu)

        # 6. Projects Section
        proj_lines = get_section_lines(keys["proj"], keys["skills"]) 
        
        # Skip headers
        try:
            start_idx = -1
            for i, line in enumerate(proj_lines):
                if any(k in line for k in ["Projet", "Project"]):
                        start_idx = i
                        break
            proj_lines = proj_lines[start_idx+1:] if start_idx != -1 else proj_lines
        except: pass
        
        data["projects"] = []
        current_proj = {}

        for line in proj_lines:
            if re.match(year_pattern, line):
                if current_proj: data["projects"].append(current_proj)
                current_proj = {"date": line, "client": "", "description": ""}
            elif current_proj.get("date") and not current_proj.get("client"):
                current_proj["client"] = line
            elif current_proj.get("client"):
                    if current_proj.get("description"):
                        current_proj["description"] += " " + line
                    else:
                        current_proj["description"] = line
        if current_proj: data["projects"].append(current_proj)

        return data

        return data

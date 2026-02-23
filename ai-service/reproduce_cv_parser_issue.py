
import os
import sys

# Add ai-service root so "app" imports resolve regardless of cwd
PROJECT_ROOT = os.path.abspath(os.path.dirname(__file__))
if PROJECT_ROOT not in sys.path:
    sys.path.append(PROJECT_ROOT)

from app.parsers.template_parser import TemplateCVParser

def run_reproduction():
    parser = TemplateCVParser()
    
    print("--- Experience Parsing Reproduction ---")
    # Case 1: Company and Title merged (single space or no double space)
    experience_text = """
    Expérience professionnelle
    Janvier 2015 – Mai 2016 Groupe El Kateb Ingénieur Réseaux et Sécurité
    """
    lines = [line.strip() for line in experience_text.split('\n') if line.strip()]
    
    exp_results = parser._extract_experience(experience_text, lines)
    print("Experience Results:")
    for exp in exp_results:
        print(exp)
        
    print("\n--- Education Parsing Reproduction ---")
    # Case 2: Education blob
    education_text = """
    Education
    2011
    - 2014 Institut National des Sciences Diplôme National d’Ingénieur en Appliquées et de Technologie « Sciences Appliquées et en Technologie INSAT », Tunis Spécialité : Réseaux informatiques et télécommunications 2009 – 2011 Institut National des Sciences Classes préparatoires au concours Appliquées et de Technologie « d’ingénieur INSAT », Tunis Spécialité : Maths, physiques, informatique
    """
    lines = [line.strip() for line in education_text.split('\n') if line.strip()]
    
    edu_results = parser._extract_education(education_text, lines)
    print("Education Results:")
    for edu in edu_results:
        print(edu)

if __name__ == "__main__":
    run_reproduction()

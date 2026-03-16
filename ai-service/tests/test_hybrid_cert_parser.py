import os
import sys
import logging

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

# Add ai-service root so "app" imports resolve regardless of cwd
PROJECT_ROOT = os.path.abspath(os.path.dirname(__file__))
if PROJECT_ROOT not in sys.path:
    sys.path.append(PROJECT_ROOT)

from app.ocr.certification_ocr import CertificationOCR

def test_hybrid_parser():
    ocr_service = CertificationOCR()

    print("\n" + "="*50)
    print("TEST 1: Standard Certificate (Should be handled by Regex)")
    print("="*50)
    standard_cert_text = """
    Certificate of Completion
    This is to certify that John Doe has successfully completed the course.
    AWS Certified Solutions Architect - Associate
    Issued by: Amazon Web Services
    Issue Date: 2023-01-15
    Expiration Date: 2026-01-15
    Validation Number: AWS123456789
    """
    
    # We mock _extract_text_from_image and _extract_text_from_pdf to return our test string
    ocr_service._extract_text_from_image = lambda x: standard_cert_text
    ocr_service._extract_text_from_pdf = lambda x, use_easyocr=False: (standard_cert_text, 0)
    
    result1 = ocr_service.parse_certification("dummy.jpg", "dummy.jpg")
    print(f"Result: {result1}")


    print("\n" + "="*50)
    print("TEST 2: Messy Certificate (Regex fails, LLM should extract)")
    print("="*50)
    messy_cert_text = """
    Congratulations to Jane Smith!
    We are proud to award you this credential for passing the rigorous exam.
    Google Cloud Professional Data Engineer
    You showed great skill in GCP data pipelines.
    Valid until November 2025.
    Certified by Google Cloud Platform.
    Credential ID: GC-998877
    """
    ocr_service._extract_text_from_image = lambda x: messy_cert_text
    ocr_service._extract_text_from_pdf = lambda x, use_easyocr=False: (messy_cert_text, 0)
    
    result2 = ocr_service.parse_certification("dummy.pdf", "dummy.pdf")
    print(f"Result: {result2}")


    print("\n" + "="*50)
    print("TEST 3: Irrelevant Document (Gatekeeper should reject, NO LLM call)")
    print("="*50)
    restaurant_menu_text = """
    Joe's Pizza & Spaghetti House
    Appetizers:
    - Garlic Bread ... $4.99
    - Mozzarella Sticks ... $6.99
    
    Main Courses:
    - Spaghetti Carbonara ... $14.99
    - Large Pepperoni Pizza ... $18.99
    
    Desserts:
    - Tiramisu ... $5.99
    Thank you for dining with us!
    """
    ocr_service._extract_text_from_image = lambda x: restaurant_menu_text
    ocr_service._extract_text_from_pdf = lambda x, use_easyocr=False: (restaurant_menu_text, 0)
    
    result3 = ocr_service.parse_certification("dummy.jpg", "dummy.jpg")
    print(f"Result: {result3}")


    print("\n==================================================")
    print("TEST 4: Dell Compellent Certificate (Known failing edge case)")
    print("==================================================")
    messy_dell_text = """
          Dell Partner Course
       Completion Certificate




                         Dell Worldwide Partner Learning and Development 
Team certifies that

                  on this date Jun 30, 2011


 JAZIL GAFSI



            has successfully completed the certification course

                     CSSAT0211WBTT - Compellent Storage Architect Technical


       Valid for one year from 
    """
    
    ocr_service._extract_text_from_image = lambda x: messy_dell_text
    ocr_service._extract_text_from_pdf = lambda x, use_easyocr=False: (messy_dell_text, 0)
    
    result4 = ocr_service.parse_certification("dummy.pdf", "dummy.pdf")
    print(f"Result: {result4}")

    # 5. Failed Regex (Cisco edge case)
    messy_cisco_text = """
ID Certified Through
2021-05-23
Cisco



                                                                                 600354244 0613
                           """
    
    print("\n==================================================")
    print("TEST 5: Cisco 'ID Certified Through' Edge Case")
    print("==================================================")
    
    ocr_service._extract_text_from_image = lambda x: messy_cisco_text
    ocr_service._extract_text_from_pdf = lambda x, use_easyocr=False: (messy_cisco_text, 0)
    
    result5 = ocr_service.parse_certification("dummy.pdf", "dummy.pdf")
    print(f"Result: {result5}")

if __name__ == "__main__":
    test_hybrid_parser()

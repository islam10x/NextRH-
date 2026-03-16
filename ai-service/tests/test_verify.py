import asyncio
from app.ocr.certification_ocr import CertificationOCR

def test_verify():
    ocr = CertificationOCR()
    # Test 1: Aya Ben Jemaa (missing 'a')
    res1 = ocr._verify_user_name("text with aya ben jema inside", "Aya", "Ben Jemaa")
    print("Test 1 (missing letter):", res1)
    
    # Test 2: Standard match
    res2 = ocr._verify_user_name("has successfully completed john doe", "John", "Doe")
    print("Test 2 (perfect match):", res2)
    
    # Test 3: Totally wrong
    res3 = ocr._verify_user_name("has successfully completed jane smith", "John", "Doe")
    print("Test 3 (wrong name):", res3)
    
    # Test 4: Reversed
    res4 = ocr._verify_user_name("certifies that doe john passed", "John", "Doe")
    print("Test 4 (reversed):", res4)

if __name__ == "__main__":
    test_verify()

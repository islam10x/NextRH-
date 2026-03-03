import re

text = """CISCO
‘hasisuces
Fiatfiietes.
--- Alternative OCR ---
ALOE |
CISCO. |
| Cisco Certifications ;
Eya Ben Jema
has successfully compieted the Cisco certification exam requirements and is recognized as a :
| - Cisco Certified Network Associate Routing and Switching |
D CISCO
| "” CERTIFIED
(cr & )
SWITCHING
Date Certified May 30, 2015
: Valid Through May 30, 2018
Cisco ID No. CSCO12789054
Validate this certificate's authenticity at John Chambers
www.cisco.com/go/verifycertificate Chairman and CEO
Certificate Verification No. 421624 169038CSUH Cisco Systems, Inc.
, 7078792697
© 2015 Cisco and/or its affiliates 0611
--- Embedded Text ---"""

pattern4 = r'recognized\s+as\s+(?:a|an)?\s*[:\-]*\s*\n*(?:[|\-]+\s*)*([A-Z][^\n]{10,80}?)(?:\s*\||\n|$)'
match4 = re.search(pattern4, text, re.IGNORECASE)
if match4:
    print("MATCH 4:", repr(match4.group(1).strip()))
else:
   print("NO MATCH 4")

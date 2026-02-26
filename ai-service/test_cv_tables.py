import fitz

def run():
    file_path = r"c:\Users\islam\Projects\NextRH\ai-service\templates\cv_ak_abidi.pdf"
    print(f"--- Raw Tables from {file_path} ---")
    
    with fitz.open(file_path) as doc:
        for page_num, page in enumerate(doc):
            try:
                tables = page.find_tables().tables
                for t_idx, table in enumerate(tables):
                    print(f"  Table {t_idx}:")
                    rows = table.extract()
                    for r_idx, row in enumerate(rows):
                        print(f"    R{r_idx}: {row}")
            except Exception as e:
                pass
            
if __name__ == "__main__":
    run()

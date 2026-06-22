import sys
sys.path.insert(0, r"c:\Users\islam\Projects\NextRH-\ai-service")
import psycopg
from app.config import settings

conn = psycopg.connect(f"host={settings.DB_HOST} port={settings.DB_PORT} user={settings.DB_USER} password={settings.DB_PASSWORD} dbname={settings.DB_NAME}")
cur = conn.cursor()

# Check schema
cur.execute("SELECT column_name, data_type FROM information_schema.columns WHERE table_name='employee_rag_vectors' ORDER BY ordinal_position")
print("=== SCHEMA ===")
for r in cur.fetchall():
    print(f"  {r[0]}: {r[1]}")

# Check row count
cur.execute("SELECT COUNT(*) FROM employee_rag_vectors")
print(f"\nTotal rows: {cur.fetchone()[0]}")

# Get distinct names
cur.execute("SELECT DISTINCT metadata_json->>'name' as name FROM employee_rag_vectors WHERE metadata_json->>'name' IS NOT NULL ORDER BY name")
names = [r[0] for r in cur.fetchall()]
print(f"\n=== EMPLOYEES ({len(names)}) ===")
for n in names:
    print(f"  - {n}")

# Chunk types per employee
print("\n=== CHUNK TYPES PER EMPLOYEE ===")
cur.execute(
    "SELECT metadata_json->>'name' as name, metadata_json->>'chunk_type' as chunk_type, COUNT(*) "
    "FROM employee_rag_vectors "
    "WHERE metadata_json->>'name' IS NOT NULL "
    "GROUP BY metadata_json->>'name', metadata_json->>'chunk_type' "
    "ORDER BY name, chunk_type"
)
for r in cur.fetchall():
    print(f"  {r[0]} | {r[1]} | {r[2]}")

# Employees with certifications
print("\n=== EMPLOYEES WITH CERT CHUNKS ===")
cur.execute(
    "SELECT DISTINCT metadata_json->>'name' FROM employee_rag_vectors "
    "WHERE metadata_json->>'chunk_type' IN ('certifications','certification_entry') ORDER BY 1"
)
for r in cur.fetchall():
    print(f"  - {r[0]}")

# Sample a certification chunk content
print("\n=== SAMPLE CERT CHUNK ===")
cur.execute(
    "SELECT metadata_json->>'name', metadata_json->>'chunk_type', LEFT(content, 300) "
    "FROM employee_rag_vectors "
    "WHERE metadata_json->>'chunk_type' IN ('certifications','certification_entry') LIMIT 3"
)
for r in cur.fetchall():
    print(f"  Name: {r[0]}, Type: {r[1]}")
    print(f"  Content: {r[2]}\n")

conn.close()

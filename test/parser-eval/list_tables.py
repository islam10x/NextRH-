import sys
sys.path.insert(0, r"c:\Users\islam\Projects\NextRH-\ai-service")
import psycopg
from app.config import settings

conn = psycopg.connect(f"host={settings.DB_HOST} port={settings.DB_PORT} user={settings.DB_USER} password={settings.DB_PASSWORD} dbname={settings.DB_NAME}")
cur = conn.cursor()
cur.execute("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
print("=== TABLES ===")
for r in cur.fetchall():
    print(f"  {r[0]}")
conn.close()

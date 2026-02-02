-- Enable UUID extension (though gen_random_uuid() is built-in in PG14, uuid-ossp provides other functions)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enable pgvector for AI embeddings (as implied by ai_search_queries/metadata structure)
CREATE EXTENSION IF NOT EXISTS "vector";

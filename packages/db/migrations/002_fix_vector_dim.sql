-- Drop and recreate with correct 3072 dimensions (gemini-embedding-001 output)
DROP TABLE IF EXISTS incident_memory;
CREATE TABLE incident_memory (
    memory_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id   UUID,
    summary       STRING,
    resolution    STRING,
    embedding     VECTOR(3072),
    created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE VECTOR INDEX IF NOT EXISTS incident_memory_embedding_idx ON incident_memory (embedding);

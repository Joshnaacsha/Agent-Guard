CREATE TABLE IF NOT EXISTS incidents (
    incident_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pod_name        STRING NOT NULL,
    namespace       STRING NOT NULL,
    status          STRING NOT NULL DEFAULT 'DETECTED',
    version         INT NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS diagnoses (
    diagnosis_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id     UUID REFERENCES incidents(incident_id),
    agent_id        STRING NOT NULL,
    root_cause      STRING NOT NULL,
    confidence      DECIMAL,
    status          STRING NOT NULL DEFAULT 'PROPOSED',
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS remediation_budget (
    namespace   STRING PRIMARY KEY,
    budget      DECIMAL NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_actions (
    action_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id   UUID REFERENCES incidents(incident_id),
    agent_id      STRING NOT NULL,
    action        STRING NOT NULL,
    outcome       STRING NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incident_memory (
    memory_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id   UUID,
    summary       STRING,
    resolution    STRING,
    embedding     VECTOR(3072),
    created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE VECTOR INDEX IF NOT EXISTS incident_memory_embedding_idx ON incident_memory (embedding);

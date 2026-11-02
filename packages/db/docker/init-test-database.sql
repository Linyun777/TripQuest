-- Runs only when Docker initializes a new PostgreSQL data volume.
-- The current POSTGRES_USER becomes the owner of the isolated test database.
SELECT 'CREATE DATABASE tripquest_test WITH TEMPLATE template0 ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'tripquest_test')
\gexec

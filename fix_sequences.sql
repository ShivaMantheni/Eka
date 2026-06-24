-- Fix PostgreSQL primary key sequences desynced after SQLite migration.
-- Run on the production server:
--   psql -U eka_user -d eka_automation -f fix_sequences.sql

SELECT setval('duts_id_seq',               COALESCE((SELECT MAX(id) FROM duts), 1));
SELECT setval('dut_configurations_id_seq', COALESCE((SELECT MAX(id) FROM dut_configurations), 1));
SELECT setval('images_id_seq',             COALESCE((SELECT MAX(id) FROM images), 1));
SELECT setval('scripts_id_seq',            COALESCE((SELECT MAX(id) FROM scripts), 1));
SELECT setval('executions_id_seq',         COALESCE((SELECT MAX(id) FROM executions), 1));
SELECT setval('execution_logs_id_seq',     COALESCE((SELECT MAX(id) FROM execution_logs), 1));
SELECT setval('dut_locks_id_seq',          COALESCE((SELECT MAX(id) FROM dut_locks), 1));
SELECT setval('topology_connections_id_seq', COALESCE((SELECT MAX(id) FROM topology_connections), 1));
SELECT setval('user_sessions_id_seq',      COALESCE((SELECT MAX(id) FROM user_sessions), 1));
SELECT setval('hardware_load_jobs_id_seq', COALESCE((SELECT MAX(id) FROM hardware_load_jobs), 1));
SELECT setval('audit_logs_id_seq',         COALESCE((SELECT MAX(id) FROM audit_logs), 1));

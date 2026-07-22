-- Migration to extend project_sla_policies with full SLA metadata columns
ALTER TABLE project_sla_policies ADD COLUMN IF NOT EXISTS priority_name VARCHAR(100);
ALTER TABLE project_sla_policies ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE project_sla_policies ADD COLUMN IF NOT EXISTS response_hours INTEGER;
ALTER TABLE project_sla_policies ADD COLUMN IF NOT EXISTS service_window VARCHAR(50) DEFAULT 'Business Hours';
ALTER TABLE project_sla_policies ADD COLUMN IF NOT EXISTS display_order INTEGER DEFAULT 1;
ALTER TABLE project_sla_policies ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT FALSE;
ALTER TABLE project_sla_policies ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

-- Populate existing rows with default values
UPDATE project_sla_policies SET response_hours = resolve_hours WHERE response_hours IS NULL;
UPDATE project_sla_policies SET priority_name = priority WHERE priority_name IS NULL;
UPDATE project_sla_policies SET description = 'Default SLA policy details' WHERE description IS NULL;

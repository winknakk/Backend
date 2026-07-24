-- Migration to add environment and project_type columns to projects table
ALTER TABLE projects ADD COLUMN IF NOT EXISTS environment VARCHAR(255);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_type VARCHAR(255) DEFAULT 'Support Project';

-- Update existing projects with correct metadata
UPDATE projects SET environment = 'AutomationX Demo Environment', project_type = 'Demo Project' WHERE id = 1;
UPDATE projects SET environment = 'Customer Success Production', project_type = 'Support Project' WHERE id = 2;
UPDATE projects SET environment = 'Avalant 24/7 Production', project_type = 'Support Project' WHERE id = 8;
UPDATE projects SET environment = 'SSO Production', project_type = 'Support Project' WHERE id = 11;
UPDATE projects SET environment = 'CRA Production', project_type = 'Support Project' WHERE id = 12;

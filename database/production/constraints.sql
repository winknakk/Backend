-- ============================================================================
-- AutomationX V3 Platform — Production Constraints & Triggers
-- Target Database: PostgreSQL 16+
-- ============================================================================

-- Apply Triggers for Auto-updating updated_at Columns
CREATE TRIGGER update_companies_modtime BEFORE UPDATE ON companies FOR EACH ROW EXECUTE PROCEDURE update_timestamp_column();
CREATE TRIGGER update_projects_modtime BEFORE UPDATE ON projects FOR EACH ROW EXECUTE PROCEDURE update_timestamp_column();
CREATE TRIGGER update_teams_modtime BEFORE UPDATE ON teams FOR EACH ROW EXECUTE PROCEDURE update_timestamp_column();
CREATE TRIGGER update_profiles_modtime BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE PROCEDURE update_timestamp_column();
CREATE TRIGGER update_identities_modtime BEFORE UPDATE ON identities FOR EACH ROW EXECUTE PROCEDURE update_timestamp_column();
CREATE TRIGGER update_operators_modtime BEFORE UPDATE ON operators FOR EACH ROW EXECUTE PROCEDURE update_timestamp_column();
CREATE TRIGGER update_conversations_modtime BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE PROCEDURE update_timestamp_column();
CREATE TRIGGER update_tickets_modtime BEFORE UPDATE ON tickets FOR EACH ROW EXECUTE PROCEDURE update_timestamp_column();
CREATE TRIGGER update_knowledge_docs_modtime BEFORE UPDATE ON knowledge_documents FOR EACH ROW EXECUTE PROCEDURE update_timestamp_column();

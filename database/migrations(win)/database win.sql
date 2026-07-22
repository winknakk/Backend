-- DROP SCHEMA public;

CREATE SCHEMA public AUTHORIZATION postgres;

-- DROP TYPE public.admin_audit_logs;

CREATE TYPE public.admin_audit_logs AS (
	id serial4,
	project_id int4,
	"action" varchar(100),
	old_value jsonb,
	new_value jsonb,
	actor varchar(255),
	"timestamp" timestamptz,
	operator_id int4);

-- DROP TYPE public.ai_memory;

CREATE TYPE public.ai_memory AS (
	id serial4,
	profile_id int4,
	project_id int4,
	memory_type varchar(50),
	"key" varchar(255),
	value text,
	value_embedding text,
	source_conv_id int4,
	source_ticket_id int4,
	confidence numeric(3,2),
	expires_at timestamptz,
	created_at timestamptz,
	updated_at timestamptz,
	memory_scope varchar(50));

-- DROP TYPE public.companies;

CREATE TYPE public.companies AS (
	id int4,
	"name" varchar(255),
	created_at timestamptz,
	deleted_at timestamptz,
	slug varchar(100),
	plan_tier varchar(50),
	status varchar(50));

-- DROP TYPE public.company_holiday_calendars;

CREATE TYPE public.company_holiday_calendars AS (
	id serial4,
	company_id int4,
	"name" varchar(255),
	country_code varchar(10),
	is_default bool,
	created_at timestamptz);

-- DROP TYPE public.company_holidays;

CREATE TYPE public.company_holidays AS (
	id serial4,
	calendar_id int4,
	holiday_date date,
	"name" varchar(255),
	holiday_type varchar(50),
	created_at timestamptz);

-- DROP TYPE public.conversation_events;

CREATE TYPE public.conversation_events AS (
	id serial4,
	conversation_id int4,
	event_type varchar(255),
	payload jsonb,
	correlation_id varchar(255),
	created_at timestamptz);

-- DROP TYPE public.conversation_handoffs;

CREATE TYPE public.conversation_handoffs AS (
	id serial4,
	conversation_id int4,
	project_id int4,
	from_owner varchar(20),
	to_owner varchar(20),
	from_operator_id int4,
	to_operator_id int4,
	trigger_type varchar(50),
	reason text,
	started_at timestamptz,
	ended_at timestamptz,
	context_snapshot jsonb,
	ticket_id int4);

-- DROP TYPE public.conversation_participants;

CREATE TYPE public.conversation_participants AS (
	id serial4,
	conversation_id int4,
	project_id int4,
	participant_type varchar(50),
	identity_id int4,
	operator_id int4,
	session_role varchar(50),
	join_source varchar(50),
	joined_at timestamptz,
	left_at timestamptz,
	is_active bool,
	channel_metadata jsonb);

-- DROP TYPE public.conversation_ticket_links;

CREATE TYPE public.conversation_ticket_links AS (
	id serial4,
	conversation_id int4,
	ticket_id int4,
	link_type varchar(50),
	linked_at timestamptz,
	linked_by varchar(20));

-- DROP TYPE public.conversations;

CREATE TYPE public.conversations AS (
	id int4,
	promptx_conversation_id varchar(100),
	identity_id int4,
	project_id int4,
	status varchar(50),
	channel varchar(50),
	handled_by varchar(50),
	assigned_pm varchar(50),
	updated_at timestamptz,
	created_at timestamptz,
	operator_id int4,
	takeover_state varchar(50),
	last_message_at timestamptz,
	deleted_at timestamptz);

-- DROP TYPE public.customer_enrollments;

CREATE TYPE public.customer_enrollments AS (
	id serial4,
	profile_id int4,
	project_id int4,
	company_id int4,
	enrollment_source varchar(50),
	enrollment_type varchar(50),
	first_contact_at timestamptz,
	enrolled_at timestamptz,
	enrolled_by int4,
	is_active bool,
	notes text);

-- DROP TYPE public.document_embeddings;

CREATE TYPE public.document_embeddings AS (
	id serial4,
	doc_id varchar(255),
	"content" text,
	metadata jsonb,
	embedding text,
	updated_at timestamptz,
	created_at timestamptz);

-- DROP TYPE public.identities;

CREATE TYPE public.identities AS (
	id serial4,
	profile_id int4,
	channel varchar(50),
	channel_ref varchar(255),
	created_at timestamptz,
	deleted_at timestamptz,
	gdpr_erased_at timestamptz,
	is_pii bool,
	account_type varchar(50),
	is_shared_account bool);

-- DROP TYPE public.internal_notes;

CREATE TYPE public.internal_notes AS (
	id serial4,
	conversation_id int4,
	ticket_id int4,
	operator_id int4,
	"content" text,
	is_pinned bool,
	mentioned_ops _int4,
	created_at timestamptz,
	updated_at timestamptz);

-- DROP TYPE public.knowledge_documents;

CREATE TYPE public.knowledge_documents AS (
	id uuid,
	project_id int4,
	company_id int4,
	external_doc_id varchar(255),
	title varchar(500),
	raw_content text,
	processed_content text,
	document_type varchar(50),
	"language" varchar(20),
	source_url text,
	chunk_index int4,
	chunk_total int4,
	parent_doc_id uuid,
	"version" int4,
	is_active bool,
	indexed_at timestamptz,
	metadata jsonb,
	created_by int4,
	created_at timestamptz,
	updated_at timestamptz,
	deleted_at timestamptz);

-- DROP TYPE public.knowledge_embeddings;

CREATE TYPE public.knowledge_embeddings AS (
	id serial4,
	document_id uuid,
	project_id int4,
	model_name varchar(150),
	model_version varchar(50),
	dimensions int4,
	embedding text,
	created_at timestamptz);

-- DROP TYPE public.message_attachments;

CREATE TYPE public.message_attachments AS (
	id serial4,
	message_id int4,
	file_url varchar(2048),
	file_name varchar(255),
	file_type varchar(100),
	file_size int4,
	created_at timestamptz);

-- DROP TYPE public.messages;

CREATE TYPE public.messages AS (
	id serial4,
	conversation_id int4,
	"role" varchar(50),
	"content" text,
	created_at timestamptz,
	query text,
	external_id varchar(255),
	deleted_at timestamptz,
	ticket_id int4,
	message_purpose varchar(50));

-- DROP TYPE public.operator_project_access;

CREATE TYPE public.operator_project_access AS (
	operator_id int4,
	project_id int4,
	"role" varchar(50),
	granted_at timestamptz,
	granted_by int4);

-- DROP TYPE public.operators;

CREATE TYPE public.operators AS (
	id serial4,
	company_id int4,
	email varchar(255),
	"name" varchar(255),
	display_name varchar(255),
	avatar_url text,
	"role" varchar(50),
	status varchar(50),
	password_hash text,
	last_login_at timestamptz,
	settings jsonb,
	created_at timestamptz,
	updated_at timestamptz,
	deleted_at timestamptz,
	primary_team_id int4);

-- DROP TYPE public.outbox_events;

CREATE TYPE public.outbox_events AS (
	id serial4,
	event_type varchar(255),
	payload jsonb,
	status varchar(50),
	attempts int4,
	error_message text,
	created_at timestamptz,
	updated_at timestamptz);

-- DROP TYPE public.profile_projects;

CREATE TYPE public.profile_projects AS (
	profile_id int4,
	project_id int4);

-- DROP TYPE public.profiles;

CREATE TYPE public.profiles AS (
	id int4,
	company_id int4,
	"name" varchar(255),
	created_at timestamptz,
	deleted_at timestamptz,
	gdpr_consent_at timestamptz,
	gdpr_erased_at timestamptz,
	is_pii_erased bool,
	data_region varchar(20),
	merged_into_profile_id int4,
	merged_at timestamptz,
	is_merged bool);

-- DROP TYPE public.project_ai_settings;

CREATE TYPE public.project_ai_settings AS (
	id serial4,
	project_id int4,
	confidence_threshold numeric(3,2),
	max_handoff_depth int4,
	vector_match_threshold numeric(3,2),
	created_at timestamptz);

-- DROP TYPE public.project_business_hours;

CREATE TYPE public.project_business_hours AS (
	id serial4,
	project_id int4,
	day_of_week int4,
	start_time time,
	end_time time,
	timezone varchar(100),
	created_at timestamptz,
	holiday_calendar_id int4);

-- DROP TYPE public.project_channels;

CREATE TYPE public.project_channels AS (
	id serial4,
	project_id int4,
	channel_type varchar(50),
	channel_id varchar(255),
	secret_token text,
	credentials_json jsonb,
	active bool,
	created_at timestamptz,
	secret_token_encrypted bytea,
	credentials_encrypted bytea,
	encryption_key_id varchar(200),
	encrypted_at timestamptz);

-- DROP TYPE public.project_feature_flags;

CREATE TYPE public.project_feature_flags AS (
	id serial4,
	project_id int4,
	flag_name varchar(255),
	is_enabled bool,
	created_at timestamptz);

-- DROP TYPE public.project_holidays;

CREATE TYPE public.project_holidays AS (
	id serial4,
	project_id int4,
	holiday_date date,
	"name" varchar(255),
	created_at timestamptz);

-- DROP TYPE public.project_mcp_permissions;

CREATE TYPE public.project_mcp_permissions AS (
	id serial4,
	project_id int4,
	tool_name varchar(255),
	allowed_roles _varchar,
	policy_rules jsonb,
	created_at timestamptz);

-- DROP TYPE public.project_prompts;

CREATE TYPE public.project_prompts AS (
	id serial4,
	project_id int4,
	system_instruction text,
	model_name varchar(100),
	temperature numeric(3,2),
	max_tokens int4,
	created_at timestamptz,
	"version" int4,
	version_label varchar(100),
	is_active bool,
	ab_weight numeric(5,2));

-- DROP TYPE public.project_routing_rules;

CREATE TYPE public.project_routing_rules AS (
	id serial4,
	project_id int4,
	rule_type varchar(100),
	conditions jsonb,
	target_handler varchar(255),
	created_at timestamptz);

-- DROP TYPE public.project_sla_policies;

CREATE TYPE public.project_sla_policies AS (
	id serial4,
	project_id int4,
	priority varchar(50),
	resolve_hours int4,
	created_at timestamptz,
	priority_name varchar(100),
	description text,
	response_hours int4,
	service_window varchar(50),
	display_order int4,
	is_default bool,
	is_active bool);

-- DROP TYPE public.projects;

CREATE TYPE public.projects AS (
	id int4,
	company_id int4,
	"name" varchar(255),
	created_at timestamptz,
	environment varchar(255),
	project_type varchar(255),
	deleted_at timestamptz,
	slug varchar(100),
	status varchar(50),
	timezone varchar(100),
	team_id int4);

-- DROP TYPE public.schema_migrations;

CREATE TYPE public.schema_migrations AS (
	"version" varchar(255),
	executed_at timestamptz);

-- DROP TYPE public.takeover_sessions;

CREATE TYPE public.takeover_sessions AS (
	id serial4,
	conversation_id int4,
	operator_id int4,
	project_id int4,
	status varchar(50),
	acquired_at timestamptz,
	expires_at timestamptz,
	released_at timestamptz,
	release_reason varchar(100),
	notes text,
	ticket_id int4);

-- DROP TYPE public.teams;

CREATE TYPE public.teams AS (
	id serial4,
	company_id int4,
	"name" varchar(255),
	description text,
	parent_team_id int4,
	status varchar(50),
	created_by int4,
	created_at timestamptz,
	updated_at timestamptz);

-- DROP TYPE public.ticket_embeddings;

CREATE TYPE public.ticket_embeddings AS (
	id serial4,
	ticket_id int4,
	embedding text,
	created_at timestamptz);

-- DROP TYPE public.ticket_events;

CREATE TYPE public.ticket_events AS (
	id serial4,
	ticket_id int4,
	event_type varchar(100),
	actor varchar(50),
	"source" varchar(50),
	correlation_id varchar(100),
	payload jsonb,
	created_at timestamptz);

-- DROP TYPE public.tickets;

CREATE TYPE public.tickets AS (
	ticket_id varchar(50),
	subject text,
	summary text,
	status varchar(50),
	priority varchar(10),
	assigned_pm varchar(50),
	created_via varchar(50),
	plane_issue_id varchar(255),
	conversation_id int4,
	project_id int4,
	created_at timestamptz,
	id serial4,
	severity varchar(50),
	due_date timestamptz,
	title varchar(255),
	original_problem_statement text,
	running_summary text,
	last_ai_summary text,
	duplicate_of_ticket_id int4,
	duplicate_score numeric(3,2),
	duplicate_reason text,
	ai_confidence_metrics jsonb,
	searchable_text tsvector,
	enrichment_state varchar(50),
	operator_id int4,
	first_response_at timestamptz,
	resolved_at timestamptz,
	closed_at timestamptz,
	sla_breached bool,
	sla_breach_at timestamptz,
	deleted_at timestamptz,
	parent_ticket_id int4,
	issue_category varchar(100),
	total_sla_exposure_minutes int4,
	reopened_count int4,
	last_reopened_at timestamptz);

-- DROP TYPE public.traces;

CREATE TYPE public.traces AS (
	id serial4,
	trace_id uuid,
	session_id varchar(255),
	agent_id varchar(255),
	tool_name varchar(255),
	called_at timestamptz,
	reason text,
	arguments jsonb,
	"result" jsonb,
	status varchar(50),
	error_message text,
	completed_at timestamptz,
	request_id varchar(255),
	conversation_id varchar(255),
	parent_trace_id varchar(255));

-- DROP TYPE public.webchat_sessions;

CREATE TYPE public.webchat_sessions AS (
	id serial4,
	identity_id int4,
	session_token varchar(512),
	created_at timestamptz,
	last_active_at timestamptz);

-- DROP TYPE public.webhook_events;

CREATE TYPE public.webhook_events AS (
	id uuid,
	project_id int4,
	platform varchar(50),
	channel_type varchar(50),
	channel_id varchar(255),
	platform_event_id varchar(500),
	idempotency_key varchar(500),
	raw_payload jsonb,
	http_headers jsonb,
	hmac_signature text,
	hmac_valid bool,
	status varchar(50),
	attempts int4,
	max_attempts int4,
	last_error text,
	next_retry_at timestamptz,
	processed_at timestamptz,
	bullmq_job_id varchar(255),
	resulting_conv_id int4,
	ip_address inet,
	received_at timestamptz,
	updated_at timestamptz);

-- DROP TYPE public._admin_audit_logs;

CREATE TYPE public._admin_audit_logs (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.admin_audit_logs,
	DELIMITER = ',');

-- DROP TYPE public._ai_memory;

CREATE TYPE public._ai_memory (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.ai_memory,
	DELIMITER = ',');

-- DROP TYPE public._companies;

CREATE TYPE public._companies (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.companies,
	DELIMITER = ',');

-- DROP TYPE public._company_holiday_calendars;

CREATE TYPE public._company_holiday_calendars (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.company_holiday_calendars,
	DELIMITER = ',');

-- DROP TYPE public._company_holidays;

CREATE TYPE public._company_holidays (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.company_holidays,
	DELIMITER = ',');

-- DROP TYPE public._conversation_events;

CREATE TYPE public._conversation_events (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.conversation_events,
	DELIMITER = ',');

-- DROP TYPE public._conversation_handoffs;

CREATE TYPE public._conversation_handoffs (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.conversation_handoffs,
	DELIMITER = ',');

-- DROP TYPE public._conversation_participants;

CREATE TYPE public._conversation_participants (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.conversation_participants,
	DELIMITER = ',');

-- DROP TYPE public._conversation_ticket_links;

CREATE TYPE public._conversation_ticket_links (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.conversation_ticket_links,
	DELIMITER = ',');

-- DROP TYPE public._conversations;

CREATE TYPE public._conversations (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.conversations,
	DELIMITER = ',');

-- DROP TYPE public._customer_enrollments;

CREATE TYPE public._customer_enrollments (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.customer_enrollments,
	DELIMITER = ',');

-- DROP TYPE public._document_embeddings;

CREATE TYPE public._document_embeddings (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.document_embeddings,
	DELIMITER = ',');

-- DROP TYPE public._identities;

CREATE TYPE public._identities (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.identities,
	DELIMITER = ',');

-- DROP TYPE public._internal_notes;

CREATE TYPE public._internal_notes (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.internal_notes,
	DELIMITER = ',');

-- DROP TYPE public._knowledge_documents;

CREATE TYPE public._knowledge_documents (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.knowledge_documents,
	DELIMITER = ',');

-- DROP TYPE public._knowledge_embeddings;

CREATE TYPE public._knowledge_embeddings (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.knowledge_embeddings,
	DELIMITER = ',');

-- DROP TYPE public._message_attachments;

CREATE TYPE public._message_attachments (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.message_attachments,
	DELIMITER = ',');

-- DROP TYPE public._messages;

CREATE TYPE public._messages (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.messages,
	DELIMITER = ',');

-- DROP TYPE public._operator_project_access;

CREATE TYPE public._operator_project_access (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.operator_project_access,
	DELIMITER = ',');

-- DROP TYPE public._operators;

CREATE TYPE public._operators (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.operators,
	DELIMITER = ',');

-- DROP TYPE public._outbox_events;

CREATE TYPE public._outbox_events (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.outbox_events,
	DELIMITER = ',');

-- DROP TYPE public._profile_projects;

CREATE TYPE public._profile_projects (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.profile_projects,
	DELIMITER = ',');

-- DROP TYPE public._profiles;

CREATE TYPE public._profiles (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.profiles,
	DELIMITER = ',');

-- DROP TYPE public._project_ai_settings;

CREATE TYPE public._project_ai_settings (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.project_ai_settings,
	DELIMITER = ',');

-- DROP TYPE public._project_business_hours;

CREATE TYPE public._project_business_hours (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.project_business_hours,
	DELIMITER = ',');

-- DROP TYPE public._project_channels;

CREATE TYPE public._project_channels (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.project_channels,
	DELIMITER = ',');

-- DROP TYPE public._project_feature_flags;

CREATE TYPE public._project_feature_flags (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.project_feature_flags,
	DELIMITER = ',');

-- DROP TYPE public._project_holidays;

CREATE TYPE public._project_holidays (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.project_holidays,
	DELIMITER = ',');

-- DROP TYPE public._project_mcp_permissions;

CREATE TYPE public._project_mcp_permissions (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.project_mcp_permissions,
	DELIMITER = ',');

-- DROP TYPE public._project_prompts;

CREATE TYPE public._project_prompts (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.project_prompts,
	DELIMITER = ',');

-- DROP TYPE public._project_routing_rules;

CREATE TYPE public._project_routing_rules (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.project_routing_rules,
	DELIMITER = ',');

-- DROP TYPE public._project_sla_policies;

CREATE TYPE public._project_sla_policies (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.project_sla_policies,
	DELIMITER = ',');

-- DROP TYPE public._projects;

CREATE TYPE public._projects (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.projects,
	DELIMITER = ',');

-- DROP TYPE public._schema_migrations;

CREATE TYPE public._schema_migrations (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.schema_migrations,
	DELIMITER = ',');

-- DROP TYPE public._takeover_sessions;

CREATE TYPE public._takeover_sessions (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.takeover_sessions,
	DELIMITER = ',');

-- DROP TYPE public._teams;

CREATE TYPE public._teams (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.teams,
	DELIMITER = ',');

-- DROP TYPE public._ticket_embeddings;

CREATE TYPE public._ticket_embeddings (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.ticket_embeddings,
	DELIMITER = ',');

-- DROP TYPE public._ticket_events;

CREATE TYPE public._ticket_events (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.ticket_events,
	DELIMITER = ',');

-- DROP TYPE public._tickets;

CREATE TYPE public._tickets (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.tickets,
	DELIMITER = ',');

-- DROP TYPE public._traces;

CREATE TYPE public._traces (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.traces,
	DELIMITER = ',');

-- DROP TYPE public._webchat_sessions;

CREATE TYPE public._webchat_sessions (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.webchat_sessions,
	DELIMITER = ',');

-- DROP TYPE public._webhook_events;

CREATE TYPE public._webhook_events (
	INPUT = array_in,
	OUTPUT = array_out,
	RECEIVE = array_recv,
	SEND = array_send,
	ANALYZE = array_typanalyze,
	ALIGNMENT = 8,
	STORAGE = any,
	CATEGORY = A,
	ELEMENT = public.webhook_events,
	DELIMITER = ',');

-- DROP SEQUENCE public.admin_audit_logs_id_seq;

CREATE SEQUENCE public.admin_audit_logs_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.ai_memory_id_seq;

CREATE SEQUENCE public.ai_memory_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.company_holiday_calendars_id_seq;

CREATE SEQUENCE public.company_holiday_calendars_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.company_holidays_id_seq;

CREATE SEQUENCE public.company_holidays_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.conversation_events_id_seq;

CREATE SEQUENCE public.conversation_events_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.conversation_handoffs_id_seq;

CREATE SEQUENCE public.conversation_handoffs_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.conversation_participants_id_seq;

CREATE SEQUENCE public.conversation_participants_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.conversation_ticket_links_id_seq;

CREATE SEQUENCE public.conversation_ticket_links_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.customer_enrollments_id_seq;

CREATE SEQUENCE public.customer_enrollments_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.document_embeddings_id_seq;

CREATE SEQUENCE public.document_embeddings_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.identities_id_seq;

CREATE SEQUENCE public.identities_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.internal_notes_id_seq;

CREATE SEQUENCE public.internal_notes_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.knowledge_embeddings_id_seq;

CREATE SEQUENCE public.knowledge_embeddings_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.message_attachments_id_seq;

CREATE SEQUENCE public.message_attachments_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.messages_id_seq;

CREATE SEQUENCE public.messages_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.operators_id_seq;

CREATE SEQUENCE public.operators_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.outbox_events_id_seq;

CREATE SEQUENCE public.outbox_events_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.project_ai_settings_id_seq;

CREATE SEQUENCE public.project_ai_settings_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.project_business_hours_id_seq;

CREATE SEQUENCE public.project_business_hours_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.project_channels_id_seq;

CREATE SEQUENCE public.project_channels_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.project_feature_flags_id_seq;

CREATE SEQUENCE public.project_feature_flags_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.project_holidays_id_seq;

CREATE SEQUENCE public.project_holidays_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.project_mcp_permissions_id_seq;

CREATE SEQUENCE public.project_mcp_permissions_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.project_prompts_id_seq;

CREATE SEQUENCE public.project_prompts_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.project_routing_rules_id_seq;

CREATE SEQUENCE public.project_routing_rules_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.project_sla_policies_id_seq;

CREATE SEQUENCE public.project_sla_policies_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.takeover_sessions_id_seq;

CREATE SEQUENCE public.takeover_sessions_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.teams_id_seq;

CREATE SEQUENCE public.teams_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.ticket_embeddings_id_seq;

CREATE SEQUENCE public.ticket_embeddings_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.ticket_events_id_seq;

CREATE SEQUENCE public.ticket_events_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.tickets_id_seq;

CREATE SEQUENCE public.tickets_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.traces_id_seq;

CREATE SEQUENCE public.traces_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;
-- DROP SEQUENCE public.webchat_sessions_id_seq;

CREATE SEQUENCE public.webchat_sessions_id_seq
	INCREMENT BY 1
	MINVALUE 1
	MAXVALUE 2147483647
	START 1
	CACHE 1
	NO CYCLE;-- public.companies definition

-- Drop table

-- DROP TABLE public.companies;

CREATE TABLE public.companies (
	id int4 NOT NULL,
	"name" varchar(255) NOT NULL,
	created_at timestamptz DEFAULT now() NULL,
	deleted_at timestamptz NULL,
	slug varchar(100) NULL,
	plan_tier varchar(50) DEFAULT 'starter'::character varying NOT NULL,
	status varchar(50) DEFAULT 'active'::character varying NOT NULL,
	CONSTRAINT companies_id_not_null NOT NULL id,
	CONSTRAINT companies_name_not_null NOT NULL name,
	CONSTRAINT companies_pkey PRIMARY KEY (id),
	CONSTRAINT companies_plan_tier_not_null NOT NULL plan_tier,
	CONSTRAINT companies_status_not_null NOT NULL status
);


-- public.document_embeddings definition

-- Drop table

-- DROP TABLE public.document_embeddings;

CREATE TABLE public.document_embeddings (
	id serial4 NOT NULL,
	doc_id varchar(255) NOT NULL,
	"content" text NOT NULL,
	metadata jsonb DEFAULT '{}'::jsonb NULL,
	embedding text NULL,
	updated_at timestamptz DEFAULT now() NULL,
	created_at timestamptz DEFAULT now() NULL,
	CONSTRAINT document_embeddings_content_not_null NOT NULL content,
	CONSTRAINT document_embeddings_doc_id_key UNIQUE (doc_id),
	CONSTRAINT document_embeddings_doc_id_not_null NOT NULL doc_id,
	CONSTRAINT document_embeddings_id_not_null NOT NULL id,
	CONSTRAINT document_embeddings_pkey PRIMARY KEY (id)
);
CREATE INDEX idx_document_embeddings_doc_id ON public.document_embeddings USING btree (doc_id);


-- public.outbox_events definition

-- Drop table

-- DROP TABLE public.outbox_events;

CREATE TABLE public.outbox_events (
	id serial4 NOT NULL,
	event_type varchar(255) NOT NULL,
	payload jsonb DEFAULT '{}'::jsonb NOT NULL,
	status varchar(50) DEFAULT 'pending'::character varying NOT NULL,
	attempts int4 DEFAULT 0 NOT NULL,
	error_message text NULL,
	created_at timestamptz DEFAULT now() NULL,
	updated_at timestamptz DEFAULT now() NULL,
	CONSTRAINT outbox_events_attempts_not_null NOT NULL attempts,
	CONSTRAINT outbox_events_event_type_not_null NOT NULL event_type,
	CONSTRAINT outbox_events_id_not_null NOT NULL id,
	CONSTRAINT outbox_events_payload_not_null NOT NULL payload,
	CONSTRAINT outbox_events_pkey PRIMARY KEY (id),
	CONSTRAINT outbox_events_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'processed'::character varying, 'failed'::character varying])::text[]))),
	CONSTRAINT outbox_events_status_not_null NOT NULL status
);
CREATE INDEX idx_outbox_events_status ON public.outbox_events USING btree (status);


-- public.schema_migrations definition

-- Drop table

-- DROP TABLE public.schema_migrations;

CREATE TABLE public.schema_migrations (
	"version" varchar(255) NOT NULL,
	executed_at timestamptz DEFAULT now() NULL,
	CONSTRAINT schema_migrations_pkey PRIMARY KEY (version),
	CONSTRAINT schema_migrations_version_not_null NOT NULL version
);


-- public.traces definition

-- Drop table

-- DROP TABLE public.traces;

CREATE TABLE public.traces (
	id serial4 NOT NULL,
	trace_id uuid NOT NULL,
	session_id varchar(255) NOT NULL,
	agent_id varchar(255) NULL,
	tool_name varchar(255) NOT NULL,
	called_at timestamptz NOT NULL,
	reason text NULL,
	arguments jsonb DEFAULT '{}'::jsonb NULL,
	"result" jsonb NULL,
	status varchar(50) DEFAULT 'RUNNING'::character varying NULL,
	error_message text NULL,
	completed_at timestamptz NULL,
	request_id varchar(255) NULL,
	conversation_id varchar(255) NULL,
	parent_trace_id varchar(255) NULL,
	CONSTRAINT traces_called_at_not_null NOT NULL called_at,
	CONSTRAINT traces_id_not_null NOT NULL id,
	CONSTRAINT traces_pkey PRIMARY KEY (id),
	CONSTRAINT traces_session_id_not_null NOT NULL session_id,
	CONSTRAINT traces_tool_name_not_null NOT NULL tool_name,
	CONSTRAINT traces_trace_id_key UNIQUE (trace_id),
	CONSTRAINT traces_trace_id_not_null NOT NULL trace_id
);
CREATE INDEX idx_traces_agent ON public.traces USING btree (agent_id);
CREATE INDEX idx_traces_session ON public.traces USING btree (session_id);
CREATE INDEX idx_traces_trace_id ON public.traces USING btree (trace_id);


-- public.company_holiday_calendars definition

-- Drop table

-- DROP TABLE public.company_holiday_calendars;

CREATE TABLE public.company_holiday_calendars (
	id serial4 NOT NULL,
	company_id int4 NOT NULL,
	"name" varchar(255) NOT NULL,
	country_code varchar(10) DEFAULT 'TH'::character varying NOT NULL,
	is_default bool DEFAULT false NOT NULL,
	created_at timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT company_holiday_calendars_company_id_not_null NOT NULL company_id,
	CONSTRAINT company_holiday_calendars_country_code_not_null NOT NULL country_code,
	CONSTRAINT company_holiday_calendars_created_at_not_null NOT NULL created_at,
	CONSTRAINT company_holiday_calendars_id_not_null NOT NULL id,
	CONSTRAINT company_holiday_calendars_is_default_not_null NOT NULL is_default,
	CONSTRAINT company_holiday_calendars_name_not_null NOT NULL name,
	CONSTRAINT company_holiday_calendars_pkey PRIMARY KEY (id),
	CONSTRAINT company_holiday_calendars_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE
);


-- public.company_holidays definition

-- Drop table

-- DROP TABLE public.company_holidays;

CREATE TABLE public.company_holidays (
	id serial4 NOT NULL,
	calendar_id int4 NOT NULL,
	holiday_date date NOT NULL,
	"name" varchar(255) NOT NULL,
	holiday_type varchar(50) DEFAULT 'public'::character varying NOT NULL,
	created_at timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT company_holidays_calendar_id_holiday_date_key UNIQUE (calendar_id, holiday_date),
	CONSTRAINT company_holidays_calendar_id_not_null NOT NULL calendar_id,
	CONSTRAINT company_holidays_created_at_not_null NOT NULL created_at,
	CONSTRAINT company_holidays_holiday_date_not_null NOT NULL holiday_date,
	CONSTRAINT company_holidays_holiday_type_check CHECK (((holiday_type)::text = ANY ((ARRAY['public'::character varying, 'company'::character varying, 'regional'::character varying, 'optional'::character varying])::text[]))),
	CONSTRAINT company_holidays_holiday_type_not_null NOT NULL holiday_type,
	CONSTRAINT company_holidays_id_not_null NOT NULL id,
	CONSTRAINT company_holidays_name_not_null NOT NULL name,
	CONSTRAINT company_holidays_pkey PRIMARY KEY (id),
	CONSTRAINT company_holidays_calendar_id_fkey FOREIGN KEY (calendar_id) REFERENCES public.company_holiday_calendars(id) ON DELETE CASCADE
);


-- public.profiles definition

-- Drop table

-- DROP TABLE public.profiles;

CREATE TABLE public.profiles (
	id int4 NOT NULL,
	company_id int4 NULL,
	"name" varchar(255) NOT NULL,
	created_at timestamptz DEFAULT now() NULL,
	deleted_at timestamptz NULL,
	gdpr_consent_at timestamptz NULL,
	gdpr_erased_at timestamptz NULL,
	is_pii_erased bool DEFAULT false NOT NULL,
	data_region varchar(20) DEFAULT 'TH'::character varying NOT NULL,
	merged_into_profile_id int4 NULL,
	merged_at timestamptz NULL,
	is_merged bool DEFAULT false NOT NULL,
	CONSTRAINT profiles_data_region_not_null NOT NULL data_region,
	CONSTRAINT profiles_id_not_null NOT NULL id,
	CONSTRAINT profiles_is_merged_not_null NOT NULL is_merged,
	CONSTRAINT profiles_is_pii_erased_not_null NOT NULL is_pii_erased,
	CONSTRAINT profiles_name_not_null NOT NULL name,
	CONSTRAINT profiles_pkey PRIMARY KEY (id),
	CONSTRAINT profiles_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE,
	CONSTRAINT profiles_merged_into_profile_id_fkey FOREIGN KEY (merged_into_profile_id) REFERENCES public.profiles(id) ON DELETE SET NULL
);
CREATE INDEX idx_profiles_company_id ON public.profiles USING btree (company_id);


-- public.identities definition

-- Drop table

-- DROP TABLE public.identities;

CREATE TABLE public.identities (
	id serial4 NOT NULL,
	profile_id int4 NULL,
	channel varchar(50) NOT NULL,
	channel_ref varchar(255) NOT NULL,
	created_at timestamptz DEFAULT now() NULL,
	deleted_at timestamptz NULL,
	gdpr_erased_at timestamptz NULL,
	is_pii bool DEFAULT true NOT NULL,
	account_type varchar(50) DEFAULT 'individual'::character varying NOT NULL,
	is_shared_account bool DEFAULT false NOT NULL,
	CONSTRAINT identities_account_type_not_null NOT NULL account_type,
	CONSTRAINT identities_channel_not_null NOT NULL channel,
	CONSTRAINT identities_channel_ref_not_null NOT NULL channel_ref,
	CONSTRAINT identities_id_not_null NOT NULL id,
	CONSTRAINT identities_is_pii_not_null NOT NULL is_pii,
	CONSTRAINT identities_is_shared_account_not_null NOT NULL is_shared_account,
	CONSTRAINT identities_pkey PRIMARY KEY (id),
	CONSTRAINT identities_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE SET NULL
);
CREATE INDEX idx_identities_channel_ref ON public.identities USING btree (channel, channel_ref);
CREATE INDEX idx_identities_profile_id ON public.identities USING btree (profile_id);


-- public.webchat_sessions definition

-- Drop table

-- DROP TABLE public.webchat_sessions;

CREATE TABLE public.webchat_sessions (
	id serial4 NOT NULL,
	identity_id int4 NOT NULL,
	session_token varchar(512) NOT NULL,
	created_at timestamptz DEFAULT now() NULL,
	last_active_at timestamptz DEFAULT now() NULL,
	CONSTRAINT webchat_sessions_id_not_null NOT NULL id,
	CONSTRAINT webchat_sessions_identity_id_not_null NOT NULL identity_id,
	CONSTRAINT webchat_sessions_pkey PRIMARY KEY (id),
	CONSTRAINT webchat_sessions_session_token_key UNIQUE (session_token),
	CONSTRAINT webchat_sessions_session_token_not_null NOT NULL session_token,
	CONSTRAINT webchat_sessions_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES public.identities(id) ON DELETE CASCADE
);


-- public.admin_audit_logs definition

-- Drop table

-- DROP TABLE public.admin_audit_logs;

CREATE TABLE public.admin_audit_logs (
	id serial4 NOT NULL,
	project_id int4 NULL,
	"action" varchar(100) NOT NULL,
	old_value jsonb DEFAULT '{}'::jsonb NULL,
	new_value jsonb DEFAULT '{}'::jsonb NULL,
	actor varchar(255) DEFAULT 'admin'::character varying NULL,
	"timestamp" timestamptz DEFAULT now() NULL,
	operator_id int4 NULL,
	CONSTRAINT admin_audit_logs_action_not_null NOT NULL action,
	CONSTRAINT admin_audit_logs_id_not_null NOT NULL id,
	CONSTRAINT admin_audit_logs_pkey PRIMARY KEY (id)
);


-- public.ai_memory definition

-- Drop table

-- DROP TABLE public.ai_memory;

CREATE TABLE public.ai_memory (
	id serial4 NOT NULL,
	profile_id int4 NULL,
	project_id int4 NOT NULL,
	memory_type varchar(50) NOT NULL,
	"key" varchar(255) NOT NULL,
	value text NOT NULL,
	value_embedding text NULL,
	source_conv_id int4 NULL,
	source_ticket_id int4 NULL,
	confidence numeric(3, 2) DEFAULT 1.00 NOT NULL,
	expires_at timestamptz NULL,
	created_at timestamptz DEFAULT now() NOT NULL,
	updated_at timestamptz DEFAULT now() NOT NULL,
	memory_scope varchar(50) DEFAULT 'conversation'::character varying NOT NULL,
	CONSTRAINT ai_memory_confidence_not_null NOT NULL confidence,
	CONSTRAINT ai_memory_created_at_not_null NOT NULL created_at,
	CONSTRAINT ai_memory_id_not_null NOT NULL id,
	CONSTRAINT ai_memory_key_not_null NOT NULL key,
	CONSTRAINT ai_memory_memory_scope_not_null NOT NULL memory_scope,
	CONSTRAINT ai_memory_memory_type_check CHECK (((memory_type)::text = ANY ((ARRAY['preference'::character varying, 'fact'::character varying, 'issue'::character varying, 'resolution'::character varying, 'context'::character varying])::text[]))),
	CONSTRAINT ai_memory_memory_type_not_null NOT NULL memory_type,
	CONSTRAINT ai_memory_pkey PRIMARY KEY (id),
	CONSTRAINT ai_memory_project_id_not_null NOT NULL project_id,
	CONSTRAINT ai_memory_updated_at_not_null NOT NULL updated_at,
	CONSTRAINT ai_memory_value_not_null NOT NULL value
);


-- public.conversation_events definition

-- Drop table

-- DROP TABLE public.conversation_events;

CREATE TABLE public.conversation_events (
	id serial4 NOT NULL,
	conversation_id int4 NOT NULL,
	event_type varchar(255) NOT NULL,
	payload jsonb DEFAULT '{}'::jsonb NOT NULL,
	correlation_id varchar(255) NOT NULL,
	created_at timestamptz DEFAULT now() NULL,
	CONSTRAINT conversation_events_conversation_id_not_null NOT NULL conversation_id,
	CONSTRAINT conversation_events_correlation_id_not_null NOT NULL correlation_id,
	CONSTRAINT conversation_events_event_type_not_null NOT NULL event_type,
	CONSTRAINT conversation_events_id_not_null NOT NULL id,
	CONSTRAINT conversation_events_payload_not_null NOT NULL payload,
	CONSTRAINT conversation_events_pkey PRIMARY KEY (id)
);
CREATE INDEX idx_conversation_events_conversation_id ON public.conversation_events USING btree (conversation_id);


-- public.conversation_handoffs definition

-- Drop table

-- DROP TABLE public.conversation_handoffs;

CREATE TABLE public.conversation_handoffs (
	id serial4 NOT NULL,
	conversation_id int4 NOT NULL,
	project_id int4 NOT NULL,
	from_owner varchar(20) NOT NULL,
	to_owner varchar(20) NOT NULL,
	from_operator_id int4 NULL,
	to_operator_id int4 NULL,
	trigger_type varchar(50) DEFAULT 'unknown'::character varying NOT NULL,
	reason text NULL,
	started_at timestamptz DEFAULT now() NOT NULL,
	ended_at timestamptz NULL,
	context_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
	ticket_id int4 NULL,
	CONSTRAINT conversation_handoffs_context_snapshot_not_null NOT NULL context_snapshot,
	CONSTRAINT conversation_handoffs_conversation_id_not_null NOT NULL conversation_id,
	CONSTRAINT conversation_handoffs_from_owner_check CHECK (((from_owner)::text = ANY ((ARRAY['ai'::character varying, 'human'::character varying, 'system'::character varying])::text[]))),
	CONSTRAINT conversation_handoffs_from_owner_not_null NOT NULL from_owner,
	CONSTRAINT conversation_handoffs_id_not_null NOT NULL id,
	CONSTRAINT conversation_handoffs_pkey PRIMARY KEY (id),
	CONSTRAINT conversation_handoffs_project_id_not_null NOT NULL project_id,
	CONSTRAINT conversation_handoffs_started_at_not_null NOT NULL started_at,
	CONSTRAINT conversation_handoffs_to_owner_check CHECK (((to_owner)::text = ANY ((ARRAY['ai'::character varying, 'human'::character varying, 'system'::character varying])::text[]))),
	CONSTRAINT conversation_handoffs_to_owner_not_null NOT NULL to_owner,
	CONSTRAINT conversation_handoffs_trigger_type_check CHECK (((trigger_type)::text = ANY ((ARRAY['customer_request'::character varying, 'ai_escalation'::character varying, 'operator_claim'::character varying, 'operator_release'::character varying, 'timeout_expired'::character varying, 'force_release'::character varying, 'sla_breach'::character varying, 'system'::character varying])::text[]))),
	CONSTRAINT conversation_handoffs_trigger_type_not_null NOT NULL trigger_type
);
CREATE INDEX idx_handoffs_conversation ON public.conversation_handoffs USING btree (conversation_id, started_at DESC);


-- public.conversation_participants definition

-- Drop table

-- DROP TABLE public.conversation_participants;

CREATE TABLE public.conversation_participants (
	id serial4 NOT NULL,
	conversation_id int4 NOT NULL,
	project_id int4 NOT NULL,
	participant_type varchar(50) DEFAULT 'customer'::character varying NOT NULL,
	identity_id int4 NULL,
	operator_id int4 NULL,
	session_role varchar(50) DEFAULT 'member'::character varying NOT NULL,
	join_source varchar(50) DEFAULT 'direct'::character varying NOT NULL,
	joined_at timestamptz DEFAULT now() NOT NULL,
	left_at timestamptz NULL,
	is_active bool DEFAULT true NOT NULL,
	channel_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT conversation_participants_channel_metadata_not_null NOT NULL channel_metadata,
	CONSTRAINT conversation_participants_conversation_id_identity_id_key UNIQUE (conversation_id, identity_id),
	CONSTRAINT conversation_participants_conversation_id_not_null NOT NULL conversation_id,
	CONSTRAINT conversation_participants_conversation_id_operator_id_key UNIQUE (conversation_id, operator_id),
	CONSTRAINT conversation_participants_id_not_null NOT NULL id,
	CONSTRAINT conversation_participants_is_active_not_null NOT NULL is_active,
	CONSTRAINT conversation_participants_join_source_check CHECK (((join_source)::text = ANY ((ARRAY['direct'::character varying, 'invited'::character varying, 'webhook'::character varying, 'escalation'::character varying, 'takeover'::character varying, 'system'::character varying])::text[]))),
	CONSTRAINT conversation_participants_join_source_not_null NOT NULL join_source,
	CONSTRAINT conversation_participants_joined_at_not_null NOT NULL joined_at,
	CONSTRAINT conversation_participants_participant_type_check CHECK (((participant_type)::text = ANY ((ARRAY['customer'::character varying, 'operator'::character varying, 'ai'::character varying, 'observer'::character varying, 'collaborator'::character varying])::text[]))),
	CONSTRAINT conversation_participants_participant_type_not_null NOT NULL participant_type,
	CONSTRAINT conversation_participants_pkey PRIMARY KEY (id),
	CONSTRAINT conversation_participants_project_id_not_null NOT NULL project_id,
	CONSTRAINT conversation_participants_session_role_check CHECK (((session_role)::text = ANY ((ARRAY['reporter'::character varying, 'owner'::character varying, 'collaborator'::character varying, 'observer'::character varying, 'ai_handler'::character varying, 'member'::character varying])::text[]))),
	CONSTRAINT conversation_participants_session_role_not_null NOT NULL session_role,
	CONSTRAINT participant_has_single_owner CHECK ((((identity_id IS NOT NULL) AND (operator_id IS NULL) AND ((participant_type)::text <> 'ai'::text)) OR ((operator_id IS NOT NULL) AND (identity_id IS NULL) AND ((participant_type)::text <> 'ai'::text)) OR (((participant_type)::text = 'ai'::text) AND (identity_id IS NULL) AND (operator_id IS NULL))))
);
CREATE INDEX idx_participants_conv_active ON public.conversation_participants USING btree (conversation_id, is_active) WHERE (is_active = true);


-- public.conversation_ticket_links definition

-- Drop table

-- DROP TABLE public.conversation_ticket_links;

CREATE TABLE public.conversation_ticket_links (
	id serial4 NOT NULL,
	conversation_id int4 NOT NULL,
	ticket_id int4 NOT NULL,
	link_type varchar(50) DEFAULT 'primary'::character varying NOT NULL,
	linked_at timestamptz DEFAULT now() NOT NULL,
	linked_by varchar(20) DEFAULT 'system'::character varying NOT NULL,
	CONSTRAINT conversation_ticket_links_conversation_id_not_null NOT NULL conversation_id,
	CONSTRAINT conversation_ticket_links_conversation_id_ticket_id_key UNIQUE (conversation_id, ticket_id),
	CONSTRAINT conversation_ticket_links_id_not_null NOT NULL id,
	CONSTRAINT conversation_ticket_links_link_type_check CHECK (((link_type)::text = ANY ((ARRAY['primary'::character varying, 'related'::character varying, 'escalated_from'::character varying, 'merged_from'::character varying])::text[]))),
	CONSTRAINT conversation_ticket_links_link_type_not_null NOT NULL link_type,
	CONSTRAINT conversation_ticket_links_linked_at_not_null NOT NULL linked_at,
	CONSTRAINT conversation_ticket_links_linked_by_check CHECK (((linked_by)::text = ANY ((ARRAY['ai'::character varying, 'operator'::character varying, 'system'::character varying, 'api'::character varying])::text[]))),
	CONSTRAINT conversation_ticket_links_linked_by_not_null NOT NULL linked_by,
	CONSTRAINT conversation_ticket_links_pkey PRIMARY KEY (id),
	CONSTRAINT conversation_ticket_links_ticket_id_not_null NOT NULL ticket_id
);


-- public.conversations definition

-- Drop table

-- DROP TABLE public.conversations;

CREATE TABLE public.conversations (
	id int4 NOT NULL,
	promptx_conversation_id varchar(100) NULL,
	identity_id int4 NULL,
	project_id int4 NULL,
	status varchar(50) NOT NULL,
	channel varchar(50) NOT NULL,
	handled_by varchar(50) NULL,
	assigned_pm varchar(50) NULL,
	updated_at timestamptz NULL,
	created_at timestamptz DEFAULT now() NULL,
	operator_id int4 NULL,
	takeover_state varchar(50) DEFAULT 'none'::character varying NOT NULL,
	last_message_at timestamptz NULL,
	deleted_at timestamptz NULL,
	CONSTRAINT conversations_channel_not_null NOT NULL channel,
	CONSTRAINT conversations_id_not_null NOT NULL id,
	CONSTRAINT conversations_pkey PRIMARY KEY (id),
	CONSTRAINT conversations_promptx_conversation_id_key UNIQUE (promptx_conversation_id),
	CONSTRAINT conversations_status_not_null NOT NULL status,
	CONSTRAINT conversations_takeover_state_not_null NOT NULL takeover_state
);
CREATE INDEX idx_conversations_identity ON public.conversations USING btree (identity_id);
CREATE INDEX idx_conversations_project_id ON public.conversations USING btree (project_id);
CREATE INDEX idx_conversations_status ON public.conversations USING btree (status);


-- public.customer_enrollments definition

-- Drop table

-- DROP TABLE public.customer_enrollments;

CREATE TABLE public.customer_enrollments (
	id serial4 NOT NULL,
	profile_id int4 NOT NULL,
	project_id int4 NOT NULL,
	company_id int4 NOT NULL,
	enrollment_source varchar(50) DEFAULT 'first_contact'::character varying NOT NULL,
	enrollment_type varchar(50) DEFAULT 'customer'::character varying NOT NULL,
	first_contact_at timestamptz NULL,
	enrolled_at timestamptz DEFAULT now() NOT NULL,
	enrolled_by int4 NULL,
	is_active bool DEFAULT true NOT NULL,
	notes text NULL,
	CONSTRAINT customer_enrollments_company_id_not_null NOT NULL company_id,
	CONSTRAINT customer_enrollments_enrolled_at_not_null NOT NULL enrolled_at,
	CONSTRAINT customer_enrollments_enrollment_source_check CHECK (((enrollment_source)::text = ANY ((ARRAY['first_contact'::character varying, 'imported'::character varying, 'invited'::character varying, 'proactive'::character varying, 'api'::character varying])::text[]))),
	CONSTRAINT customer_enrollments_enrollment_source_not_null NOT NULL enrollment_source,
	CONSTRAINT customer_enrollments_enrollment_type_check CHECK (((enrollment_type)::text = ANY ((ARRAY['customer'::character varying, 'vip'::character varying, 'internal'::character varying, 'blocked'::character varying])::text[]))),
	CONSTRAINT customer_enrollments_enrollment_type_not_null NOT NULL enrollment_type,
	CONSTRAINT customer_enrollments_id_not_null NOT NULL id,
	CONSTRAINT customer_enrollments_is_active_not_null NOT NULL is_active,
	CONSTRAINT customer_enrollments_pkey PRIMARY KEY (id),
	CONSTRAINT customer_enrollments_profile_id_not_null NOT NULL profile_id,
	CONSTRAINT customer_enrollments_profile_id_project_id_key UNIQUE (profile_id, project_id),
	CONSTRAINT customer_enrollments_project_id_not_null NOT NULL project_id
);
CREATE INDEX idx_enrollments_profile ON public.customer_enrollments USING btree (profile_id, is_active);


-- public.internal_notes definition

-- Drop table

-- DROP TABLE public.internal_notes;

CREATE TABLE public.internal_notes (
	id serial4 NOT NULL,
	conversation_id int4 NOT NULL,
	ticket_id int4 NULL,
	operator_id int4 NOT NULL,
	"content" text NOT NULL,
	is_pinned bool DEFAULT false NOT NULL,
	mentioned_ops _int4 DEFAULT '{}'::integer[] NOT NULL,
	created_at timestamptz DEFAULT now() NOT NULL,
	updated_at timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT internal_notes_content_not_null NOT NULL content,
	CONSTRAINT internal_notes_conversation_id_not_null NOT NULL conversation_id,
	CONSTRAINT internal_notes_created_at_not_null NOT NULL created_at,
	CONSTRAINT internal_notes_id_not_null NOT NULL id,
	CONSTRAINT internal_notes_is_pinned_not_null NOT NULL is_pinned,
	CONSTRAINT internal_notes_mentioned_ops_not_null NOT NULL mentioned_ops,
	CONSTRAINT internal_notes_operator_id_not_null NOT NULL operator_id,
	CONSTRAINT internal_notes_pkey PRIMARY KEY (id),
	CONSTRAINT internal_notes_updated_at_not_null NOT NULL updated_at
);
CREATE INDEX idx_notes_conv ON public.internal_notes USING btree (conversation_id, created_at DESC);


-- public.knowledge_documents definition

-- Drop table

-- DROP TABLE public.knowledge_documents;

CREATE TABLE public.knowledge_documents (
	id uuid DEFAULT uuid_generate_v7() NOT NULL,
	project_id int4 NOT NULL,
	company_id int4 NOT NULL,
	external_doc_id varchar(255) NULL,
	title varchar(500) NOT NULL,
	raw_content text NOT NULL,
	processed_content text NULL,
	document_type varchar(50) DEFAULT 'knowledge'::character varying NOT NULL,
	"language" varchar(20) DEFAULT 'th'::character varying NOT NULL,
	source_url text NULL,
	chunk_index int4 DEFAULT 0 NOT NULL,
	chunk_total int4 DEFAULT 1 NOT NULL,
	parent_doc_id uuid NULL,
	"version" int4 DEFAULT 1 NOT NULL,
	is_active bool DEFAULT true NOT NULL,
	indexed_at timestamptz NULL,
	metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
	created_by int4 NULL,
	created_at timestamptz DEFAULT now() NOT NULL,
	updated_at timestamptz DEFAULT now() NOT NULL,
	deleted_at timestamptz NULL,
	CONSTRAINT knowledge_documents_chunk_index_not_null NOT NULL chunk_index,
	CONSTRAINT knowledge_documents_chunk_total_not_null NOT NULL chunk_total,
	CONSTRAINT knowledge_documents_company_id_not_null NOT NULL company_id,
	CONSTRAINT knowledge_documents_created_at_not_null NOT NULL created_at,
	CONSTRAINT knowledge_documents_document_type_check CHECK (((document_type)::text = ANY ((ARRAY['faq'::character varying, 'manual'::character varying, 'policy'::character varying, 'procedure'::character varying, 'ticket_resolution'::character varying, 'conversation_summary'::character varying, 'product_spec'::character varying, 'legal'::character varying, 'sop'::character varying, 'other'::character varying])::text[]))),
	CONSTRAINT knowledge_documents_document_type_not_null NOT NULL document_type,
	CONSTRAINT knowledge_documents_id_not_null NOT NULL id,
	CONSTRAINT knowledge_documents_is_active_not_null NOT NULL is_active,
	CONSTRAINT knowledge_documents_language_not_null NOT NULL language,
	CONSTRAINT knowledge_documents_metadata_not_null NOT NULL metadata,
	CONSTRAINT knowledge_documents_pkey PRIMARY KEY (id),
	CONSTRAINT knowledge_documents_project_id_external_doc_id_chunk_index_key UNIQUE (project_id, external_doc_id, chunk_index),
	CONSTRAINT knowledge_documents_project_id_not_null NOT NULL project_id,
	CONSTRAINT knowledge_documents_raw_content_not_null NOT NULL raw_content,
	CONSTRAINT knowledge_documents_title_not_null NOT NULL title,
	CONSTRAINT knowledge_documents_updated_at_not_null NOT NULL updated_at,
	CONSTRAINT knowledge_documents_version_not_null NOT NULL version
);


-- public.knowledge_embeddings definition

-- Drop table

-- DROP TABLE public.knowledge_embeddings;

CREATE TABLE public.knowledge_embeddings (
	id serial4 NOT NULL,
	document_id uuid NOT NULL,
	project_id int4 NOT NULL,
	model_name varchar(150) DEFAULT 'text-embedding-3-small'::character varying NOT NULL,
	model_version varchar(50) NULL,
	dimensions int4 DEFAULT 1536 NOT NULL,
	embedding text DEFAULT ''::text NOT NULL,
	created_at timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT knowledge_embeddings_created_at_not_null NOT NULL created_at,
	CONSTRAINT knowledge_embeddings_dimensions_not_null NOT NULL dimensions,
	CONSTRAINT knowledge_embeddings_document_id_not_null NOT NULL document_id,
	CONSTRAINT knowledge_embeddings_embedding_not_null NOT NULL embedding,
	CONSTRAINT knowledge_embeddings_id_not_null NOT NULL id,
	CONSTRAINT knowledge_embeddings_model_name_not_null NOT NULL model_name,
	CONSTRAINT knowledge_embeddings_pkey PRIMARY KEY (id),
	CONSTRAINT knowledge_embeddings_project_id_not_null NOT NULL project_id
);


-- public.message_attachments definition

-- Drop table

-- DROP TABLE public.message_attachments;

CREATE TABLE public.message_attachments (
	id serial4 NOT NULL,
	message_id int4 NOT NULL,
	file_url varchar(2048) NOT NULL,
	file_name varchar(255) NOT NULL,
	file_type varchar(100) NULL,
	file_size int4 NULL,
	created_at timestamptz DEFAULT now() NULL,
	CONSTRAINT message_attachments_file_name_not_null NOT NULL file_name,
	CONSTRAINT message_attachments_file_url_not_null NOT NULL file_url,
	CONSTRAINT message_attachments_id_not_null NOT NULL id,
	CONSTRAINT message_attachments_message_id_not_null NOT NULL message_id,
	CONSTRAINT message_attachments_pkey PRIMARY KEY (id)
);


-- public.messages definition

-- Drop table

-- DROP TABLE public.messages;

CREATE TABLE public.messages (
	id serial4 NOT NULL,
	conversation_id int4 NOT NULL,
	"role" varchar(50) NOT NULL,
	"content" text NOT NULL,
	created_at timestamptz NULL,
	query text NULL,
	external_id varchar(255) NULL,
	deleted_at timestamptz NULL,
	ticket_id int4 NULL,
	message_purpose varchar(50) DEFAULT 'reply'::character varying NOT NULL,
	CONSTRAINT messages_content_not_null NOT NULL content,
	CONSTRAINT messages_conversation_id_not_null NOT NULL conversation_id,
	CONSTRAINT messages_id_not_null NOT NULL id,
	CONSTRAINT messages_message_purpose_not_null NOT NULL message_purpose,
	CONSTRAINT messages_pkey PRIMARY KEY (id),
	CONSTRAINT messages_role_not_null NOT NULL role,
	CONSTRAINT unique_channel_external_id UNIQUE (conversation_id, external_id)
);
CREATE INDEX idx_messages_conversation ON public.messages USING btree (conversation_id);


-- public.operator_project_access definition

-- Drop table

-- DROP TABLE public.operator_project_access;

CREATE TABLE public.operator_project_access (
	operator_id int4 NOT NULL,
	project_id int4 NOT NULL,
	"role" varchar(50) DEFAULT 'agent'::character varying NOT NULL,
	granted_at timestamptz DEFAULT now() NOT NULL,
	granted_by int4 NULL,
	CONSTRAINT operator_project_access_granted_at_not_null NOT NULL granted_at,
	CONSTRAINT operator_project_access_operator_id_not_null NOT NULL operator_id,
	CONSTRAINT operator_project_access_pkey PRIMARY KEY (operator_id, project_id),
	CONSTRAINT operator_project_access_project_id_not_null NOT NULL project_id,
	CONSTRAINT operator_project_access_role_check CHECK (((role)::text = ANY ((ARRAY['manager'::character varying, 'agent'::character varying, 'readonly'::character varying])::text[]))),
	CONSTRAINT operator_project_access_role_not_null NOT NULL role
);


-- public.operators definition

-- Drop table

-- DROP TABLE public.operators;

CREATE TABLE public.operators (
	id serial4 NOT NULL,
	company_id int4 NOT NULL,
	email varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	display_name varchar(255) NULL,
	avatar_url text NULL,
	"role" varchar(50) DEFAULT 'agent'::character varying NOT NULL,
	status varchar(50) DEFAULT 'active'::character varying NOT NULL,
	password_hash text NULL,
	last_login_at timestamptz NULL,
	settings jsonb DEFAULT '{}'::jsonb NOT NULL,
	created_at timestamptz DEFAULT now() NOT NULL,
	updated_at timestamptz DEFAULT now() NOT NULL,
	deleted_at timestamptz NULL,
	primary_team_id int4 NULL,
	CONSTRAINT operators_company_id_email_key UNIQUE (company_id, email),
	CONSTRAINT operators_company_id_not_null NOT NULL company_id,
	CONSTRAINT operators_created_at_not_null NOT NULL created_at,
	CONSTRAINT operators_email_not_null NOT NULL email,
	CONSTRAINT operators_id_not_null NOT NULL id,
	CONSTRAINT operators_name_not_null NOT NULL name,
	CONSTRAINT operators_pkey PRIMARY KEY (id),
	CONSTRAINT operators_role_check CHECK (((role)::text = ANY ((ARRAY['super_admin'::character varying, 'admin'::character varying, 'manager'::character varying, 'agent'::character varying, 'readonly'::character varying])::text[]))),
	CONSTRAINT operators_role_not_null NOT NULL role,
	CONSTRAINT operators_settings_not_null NOT NULL settings,
	CONSTRAINT operators_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'inactive'::character varying, 'suspended'::character varying])::text[]))),
	CONSTRAINT operators_status_not_null NOT NULL status,
	CONSTRAINT operators_updated_at_not_null NOT NULL updated_at
);
CREATE INDEX idx_operators_company ON public.operators USING btree (company_id, status);
CREATE INDEX idx_operators_email ON public.operators USING btree (email);


-- public.profile_projects definition

-- Drop table

-- DROP TABLE public.profile_projects;

CREATE TABLE public.profile_projects (
	profile_id int4 NOT NULL,
	project_id int4 NOT NULL,
	CONSTRAINT profile_projects_pkey PRIMARY KEY (profile_id, project_id),
	CONSTRAINT profile_projects_profile_id_not_null NOT NULL profile_id,
	CONSTRAINT profile_projects_project_id_not_null NOT NULL project_id
);
CREATE INDEX idx_profile_projects_project_id ON public.profile_projects USING btree (project_id);


-- public.project_ai_settings definition

-- Drop table

-- DROP TABLE public.project_ai_settings;

CREATE TABLE public.project_ai_settings (
	id serial4 NOT NULL,
	project_id int4 NOT NULL,
	confidence_threshold numeric(3, 2) DEFAULT 0.70 NULL,
	max_handoff_depth int4 DEFAULT 5 NULL,
	vector_match_threshold numeric(3, 2) DEFAULT 0.60 NULL,
	created_at timestamptz DEFAULT now() NULL,
	CONSTRAINT project_ai_settings_id_not_null NOT NULL id,
	CONSTRAINT project_ai_settings_pkey PRIMARY KEY (id),
	CONSTRAINT project_ai_settings_project_id_key UNIQUE (project_id),
	CONSTRAINT project_ai_settings_project_id_not_null NOT NULL project_id
);


-- public.project_business_hours definition

-- Drop table

-- DROP TABLE public.project_business_hours;

CREATE TABLE public.project_business_hours (
	id serial4 NOT NULL,
	project_id int4 NOT NULL,
	day_of_week int4 NOT NULL,
	start_time time NOT NULL,
	end_time time NOT NULL,
	timezone varchar(100) DEFAULT 'UTC'::character varying NULL,
	created_at timestamptz DEFAULT now() NULL,
	holiday_calendar_id int4 NULL,
	CONSTRAINT project_business_hours_day_of_week_check CHECK (((day_of_week >= 0) AND (day_of_week <= 6))),
	CONSTRAINT project_business_hours_day_of_week_not_null NOT NULL day_of_week,
	CONSTRAINT project_business_hours_end_time_not_null NOT NULL end_time,
	CONSTRAINT project_business_hours_id_not_null NOT NULL id,
	CONSTRAINT project_business_hours_pkey PRIMARY KEY (id),
	CONSTRAINT project_business_hours_project_id_not_null NOT NULL project_id,
	CONSTRAINT project_business_hours_start_time_not_null NOT NULL start_time
);


-- public.project_channels definition

-- Drop table

-- DROP TABLE public.project_channels;

CREATE TABLE public.project_channels (
	id serial4 NOT NULL,
	project_id int4 NOT NULL,
	channel_type varchar(50) NOT NULL,
	channel_id varchar(255) NOT NULL,
	secret_token text NULL,
	credentials_json jsonb DEFAULT '{}'::jsonb NULL,
	active bool DEFAULT true NULL,
	created_at timestamptz DEFAULT now() NULL,
	secret_token_encrypted bytea NULL,
	credentials_encrypted bytea NULL,
	encryption_key_id varchar(200) NULL,
	encrypted_at timestamptz NULL,
	CONSTRAINT project_channels_channel_id_not_null NOT NULL channel_id,
	CONSTRAINT project_channels_channel_type_not_null NOT NULL channel_type,
	CONSTRAINT project_channels_id_not_null NOT NULL id,
	CONSTRAINT project_channels_pkey PRIMARY KEY (id),
	CONSTRAINT project_channels_project_id_not_null NOT NULL project_id
);
CREATE INDEX idx_project_channels_project_id ON public.project_channels USING btree (project_id);


-- public.project_feature_flags definition

-- Drop table

-- DROP TABLE public.project_feature_flags;

CREATE TABLE public.project_feature_flags (
	id serial4 NOT NULL,
	project_id int4 NOT NULL,
	flag_name varchar(255) NOT NULL,
	is_enabled bool DEFAULT false NULL,
	created_at timestamptz DEFAULT now() NULL,
	CONSTRAINT project_feature_flags_flag_name_not_null NOT NULL flag_name,
	CONSTRAINT project_feature_flags_id_not_null NOT NULL id,
	CONSTRAINT project_feature_flags_pkey PRIMARY KEY (id),
	CONSTRAINT project_feature_flags_project_id_flag_name_key UNIQUE (project_id, flag_name),
	CONSTRAINT project_feature_flags_project_id_not_null NOT NULL project_id
);


-- public.project_holidays definition

-- Drop table

-- DROP TABLE public.project_holidays;

CREATE TABLE public.project_holidays (
	id serial4 NOT NULL,
	project_id int4 NOT NULL,
	holiday_date date NOT NULL,
	"name" varchar(255) NULL,
	created_at timestamptz DEFAULT now() NULL,
	CONSTRAINT project_holidays_holiday_date_not_null NOT NULL holiday_date,
	CONSTRAINT project_holidays_id_not_null NOT NULL id,
	CONSTRAINT project_holidays_pkey PRIMARY KEY (id),
	CONSTRAINT project_holidays_project_id_holiday_date_key UNIQUE (project_id, holiday_date),
	CONSTRAINT project_holidays_project_id_not_null NOT NULL project_id
);


-- public.project_mcp_permissions definition

-- Drop table

-- DROP TABLE public.project_mcp_permissions;

CREATE TABLE public.project_mcp_permissions (
	id serial4 NOT NULL,
	project_id int4 NOT NULL,
	tool_name varchar(255) NOT NULL,
	allowed_roles _varchar DEFAULT '{}'::character varying[] NULL,
	policy_rules jsonb DEFAULT '{}'::jsonb NULL,
	created_at timestamptz DEFAULT now() NULL,
	CONSTRAINT project_mcp_permissions_id_not_null NOT NULL id,
	CONSTRAINT project_mcp_permissions_pkey PRIMARY KEY (id),
	CONSTRAINT project_mcp_permissions_project_id_not_null NOT NULL project_id,
	CONSTRAINT project_mcp_permissions_project_id_tool_name_key UNIQUE (project_id, tool_name),
	CONSTRAINT project_mcp_permissions_tool_name_not_null NOT NULL tool_name
);


-- public.project_prompts definition

-- Drop table

-- DROP TABLE public.project_prompts;

CREATE TABLE public.project_prompts (
	id serial4 NOT NULL,
	project_id int4 NOT NULL,
	system_instruction text NOT NULL,
	model_name varchar(100) DEFAULT 'gemini-1.5-pro'::character varying NULL,
	temperature numeric(3, 2) DEFAULT 0.00 NULL,
	max_tokens int4 DEFAULT 2048 NULL,
	created_at timestamptz DEFAULT now() NULL,
	"version" int4 DEFAULT 1 NOT NULL,
	version_label varchar(100) NULL,
	is_active bool DEFAULT true NOT NULL,
	ab_weight numeric(5, 2) DEFAULT 100.00 NOT NULL,
	CONSTRAINT project_prompts_ab_weight_not_null NOT NULL ab_weight,
	CONSTRAINT project_prompts_id_not_null NOT NULL id,
	CONSTRAINT project_prompts_is_active_not_null NOT NULL is_active,
	CONSTRAINT project_prompts_pkey PRIMARY KEY (id),
	CONSTRAINT project_prompts_project_id_not_null NOT NULL project_id,
	CONSTRAINT project_prompts_system_instruction_not_null NOT NULL system_instruction,
	CONSTRAINT project_prompts_version_not_null NOT NULL version
);
CREATE INDEX idx_project_prompts_project_id ON public.project_prompts USING btree (project_id);


-- public.project_routing_rules definition

-- Drop table

-- DROP TABLE public.project_routing_rules;

CREATE TABLE public.project_routing_rules (
	id serial4 NOT NULL,
	project_id int4 NOT NULL,
	rule_type varchar(100) NOT NULL,
	conditions jsonb DEFAULT '{}'::jsonb NULL,
	target_handler varchar(255) NOT NULL,
	created_at timestamptz DEFAULT now() NULL,
	CONSTRAINT project_routing_rules_id_not_null NOT NULL id,
	CONSTRAINT project_routing_rules_pkey PRIMARY KEY (id),
	CONSTRAINT project_routing_rules_project_id_not_null NOT NULL project_id,
	CONSTRAINT project_routing_rules_rule_type_not_null NOT NULL rule_type,
	CONSTRAINT project_routing_rules_target_handler_not_null NOT NULL target_handler
);


-- public.project_sla_policies definition

-- Drop table

-- DROP TABLE public.project_sla_policies;

CREATE TABLE public.project_sla_policies (
	id serial4 NOT NULL,
	project_id int4 NOT NULL,
	priority varchar(50) NOT NULL,
	resolve_hours int4 NOT NULL,
	created_at timestamptz DEFAULT now() NULL,
	priority_name varchar(100) NULL,
	description text NULL,
	response_hours int4 NULL,
	service_window varchar(50) DEFAULT 'Business Hours'::character varying NULL,
	display_order int4 DEFAULT 1 NULL,
	is_default bool DEFAULT false NULL,
	is_active bool DEFAULT true NULL,
	CONSTRAINT project_sla_policies_id_not_null NOT NULL id,
	CONSTRAINT project_sla_policies_pkey PRIMARY KEY (id),
	CONSTRAINT project_sla_policies_priority_not_null NOT NULL priority,
	CONSTRAINT project_sla_policies_project_id_not_null NOT NULL project_id,
	CONSTRAINT project_sla_policies_project_id_priority_key UNIQUE (project_id, priority),
	CONSTRAINT project_sla_policies_resolve_hours_not_null NOT NULL resolve_hours
);
CREATE INDEX idx_project_sla_policies_project_id ON public.project_sla_policies USING btree (project_id);


-- public.projects definition

-- Drop table

-- DROP TABLE public.projects;

CREATE TABLE public.projects (
	id int4 NOT NULL,
	company_id int4 NULL,
	"name" varchar(255) NOT NULL,
	created_at timestamptz DEFAULT now() NULL,
	environment varchar(255) NULL,
	project_type varchar(255) DEFAULT 'Support Project'::character varying NULL,
	deleted_at timestamptz NULL,
	slug varchar(100) NULL,
	status varchar(50) DEFAULT 'active'::character varying NOT NULL,
	timezone varchar(100) DEFAULT 'Asia/Bangkok'::character varying NOT NULL,
	team_id int4 NULL,
	CONSTRAINT projects_id_not_null NOT NULL id,
	CONSTRAINT projects_name_not_null NOT NULL name,
	CONSTRAINT projects_pkey PRIMARY KEY (id),
	CONSTRAINT projects_status_not_null NOT NULL status,
	CONSTRAINT projects_timezone_not_null NOT NULL timezone
);
CREATE INDEX idx_projects_company_id ON public.projects USING btree (company_id);


-- public.takeover_sessions definition

-- Drop table

-- DROP TABLE public.takeover_sessions;

CREATE TABLE public.takeover_sessions (
	id serial4 NOT NULL,
	conversation_id int4 NOT NULL,
	operator_id int4 NOT NULL,
	project_id int4 NOT NULL,
	status varchar(50) DEFAULT 'active'::character varying NOT NULL,
	acquired_at timestamptz DEFAULT now() NOT NULL,
	expires_at timestamptz NOT NULL,
	released_at timestamptz NULL,
	release_reason varchar(100) NULL,
	notes text NULL,
	ticket_id int4 NULL,
	CONSTRAINT takeover_sessions_acquired_at_not_null NOT NULL acquired_at,
	CONSTRAINT takeover_sessions_conversation_id_not_null NOT NULL conversation_id,
	CONSTRAINT takeover_sessions_expires_at_not_null NOT NULL expires_at,
	CONSTRAINT takeover_sessions_id_not_null NOT NULL id,
	CONSTRAINT takeover_sessions_operator_id_not_null NOT NULL operator_id,
	CONSTRAINT takeover_sessions_pkey PRIMARY KEY (id),
	CONSTRAINT takeover_sessions_project_id_not_null NOT NULL project_id,
	CONSTRAINT takeover_sessions_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'released'::character varying, 'expired'::character varying, 'force_released'::character varying])::text[]))),
	CONSTRAINT takeover_sessions_status_not_null NOT NULL status
);
CREATE INDEX idx_takeover_conv_status ON public.takeover_sessions USING btree (conversation_id, status);
CREATE INDEX idx_takeover_operator ON public.takeover_sessions USING btree (operator_id, acquired_at DESC);


-- public.teams definition

-- Drop table

-- DROP TABLE public.teams;

CREATE TABLE public.teams (
	id serial4 NOT NULL,
	company_id int4 NOT NULL,
	"name" varchar(255) NOT NULL,
	description text NULL,
	parent_team_id int4 NULL,
	status varchar(50) DEFAULT 'active'::character varying NOT NULL,
	created_by int4 NULL,
	created_at timestamptz DEFAULT now() NOT NULL,
	updated_at timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT teams_company_id_name_key UNIQUE (company_id, name),
	CONSTRAINT teams_company_id_not_null NOT NULL company_id,
	CONSTRAINT teams_created_at_not_null NOT NULL created_at,
	CONSTRAINT teams_id_not_null NOT NULL id,
	CONSTRAINT teams_name_not_null NOT NULL name,
	CONSTRAINT teams_pkey PRIMARY KEY (id),
	CONSTRAINT teams_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'archived'::character varying])::text[]))),
	CONSTRAINT teams_status_not_null NOT NULL status,
	CONSTRAINT teams_updated_at_not_null NOT NULL updated_at
);


-- public.ticket_embeddings definition

-- Drop table

-- DROP TABLE public.ticket_embeddings;

CREATE TABLE public.ticket_embeddings (
	id serial4 NOT NULL,
	ticket_id int4 NOT NULL,
	embedding text NOT NULL,
	created_at timestamptz DEFAULT now() NULL,
	CONSTRAINT ticket_embeddings_embedding_not_null NOT NULL embedding,
	CONSTRAINT ticket_embeddings_id_not_null NOT NULL id,
	CONSTRAINT ticket_embeddings_pkey PRIMARY KEY (id),
	CONSTRAINT ticket_embeddings_ticket_id_key UNIQUE (ticket_id),
	CONSTRAINT ticket_embeddings_ticket_id_not_null NOT NULL ticket_id
);


-- public.ticket_events definition

-- Drop table

-- DROP TABLE public.ticket_events;

CREATE TABLE public.ticket_events (
	id serial4 NOT NULL,
	ticket_id int4 NOT NULL,
	event_type varchar(100) NOT NULL,
	actor varchar(50) NOT NULL,
	"source" varchar(50) NOT NULL,
	correlation_id varchar(100) NULL,
	payload jsonb NOT NULL,
	created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT ticket_events_actor_not_null NOT NULL actor,
	CONSTRAINT ticket_events_created_at_not_null NOT NULL created_at,
	CONSTRAINT ticket_events_event_type_not_null NOT NULL event_type,
	CONSTRAINT ticket_events_id_not_null NOT NULL id,
	CONSTRAINT ticket_events_payload_not_null NOT NULL payload,
	CONSTRAINT ticket_events_pkey PRIMARY KEY (id),
	CONSTRAINT ticket_events_source_not_null NOT NULL source,
	CONSTRAINT ticket_events_ticket_id_not_null NOT NULL ticket_id
);
CREATE INDEX ticket_events_ticket_id_idx ON public.ticket_events USING btree (ticket_id, created_at);


-- public.tickets definition

-- Drop table

-- DROP TABLE public.tickets;

CREATE TABLE public.tickets (
	ticket_id varchar(50) NOT NULL,
	subject text NOT NULL,
	summary text NULL,
	status varchar(50) NOT NULL,
	priority varchar(10) NOT NULL,
	assigned_pm varchar(50) NULL,
	created_via varchar(50) NULL,
	plane_issue_id varchar(255) NULL,
	conversation_id int4 NULL,
	project_id int4 NULL,
	created_at timestamptz DEFAULT now() NULL,
	id serial4 NOT NULL,
	severity varchar(50) NULL,
	due_date timestamptz NULL,
	title varchar(255) NULL,
	original_problem_statement text NULL,
	running_summary text NULL,
	last_ai_summary text NULL,
	duplicate_of_ticket_id int4 NULL,
	duplicate_score numeric(3, 2) DEFAULT 0.00 NULL,
	duplicate_reason text NULL,
	ai_confidence_metrics jsonb DEFAULT '{"title": 0.00, "summary": 0.00, "duplicate": 0.00}'::jsonb NULL,
	searchable_text tsvector NULL,
	enrichment_state varchar(50) DEFAULT 'PENDING'::character varying NOT NULL,
	operator_id int4 NULL,
	first_response_at timestamptz NULL,
	resolved_at timestamptz NULL,
	closed_at timestamptz NULL,
	sla_breached bool DEFAULT false NOT NULL,
	sla_breach_at timestamptz NULL,
	deleted_at timestamptz NULL,
	parent_ticket_id int4 NULL,
	issue_category varchar(100) NULL,
	total_sla_exposure_minutes int4 DEFAULT 0 NOT NULL,
	reopened_count int4 DEFAULT 0 NOT NULL,
	last_reopened_at timestamptz NULL,
	CONSTRAINT tickets_enrichment_state_not_null NOT NULL enrichment_state,
	CONSTRAINT tickets_id_not_null NOT NULL ticket_id,
	CONSTRAINT tickets_id_not_null1 NOT NULL id,
	CONSTRAINT tickets_pkey PRIMARY KEY (id),
	CONSTRAINT tickets_priority_not_null NOT NULL priority,
	CONSTRAINT tickets_reopened_count_not_null NOT NULL reopened_count,
	CONSTRAINT tickets_sla_breached_not_null NOT NULL sla_breached,
	CONSTRAINT tickets_status_not_null NOT NULL status,
	CONSTRAINT tickets_subject_not_null NOT NULL subject,
	CONSTRAINT tickets_ticket_id_key UNIQUE (ticket_id),
	CONSTRAINT tickets_total_sla_exposure_minutes_not_null NOT NULL total_sla_exposure_minutes
);
CREATE INDEX idx_tickets_conversation ON public.tickets USING btree (conversation_id);
CREATE INDEX idx_tickets_project_id ON public.tickets USING btree (project_id);
CREATE INDEX tickets_searchable_text_idx ON public.tickets USING gin (searchable_text);


-- public.webhook_events definition

-- Drop table

-- DROP TABLE public.webhook_events;

CREATE TABLE public.webhook_events (
	id uuid DEFAULT uuid_generate_v7() NOT NULL,
	project_id int4 NULL,
	platform varchar(50) NOT NULL,
	channel_type varchar(50) NULL,
	channel_id varchar(255) NULL,
	platform_event_id varchar(500) NULL,
	idempotency_key varchar(500) NOT NULL,
	raw_payload jsonb NOT NULL,
	http_headers jsonb DEFAULT '{}'::jsonb NOT NULL,
	hmac_signature text NULL,
	hmac_valid bool NULL,
	status varchar(50) DEFAULT 'received'::character varying NOT NULL,
	attempts int4 DEFAULT 0 NOT NULL,
	max_attempts int4 DEFAULT 3 NOT NULL,
	last_error text NULL,
	next_retry_at timestamptz NULL,
	processed_at timestamptz NULL,
	bullmq_job_id varchar(255) NULL,
	resulting_conv_id int4 NULL,
	ip_address inet NULL,
	received_at timestamptz DEFAULT now() NOT NULL,
	updated_at timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT webhook_events_attempts_not_null NOT NULL attempts,
	CONSTRAINT webhook_events_http_headers_not_null NOT NULL http_headers,
	CONSTRAINT webhook_events_id_not_null NOT NULL id,
	CONSTRAINT webhook_events_idempotency_key_key UNIQUE (idempotency_key),
	CONSTRAINT webhook_events_idempotency_key_not_null NOT NULL idempotency_key,
	CONSTRAINT webhook_events_max_attempts_not_null NOT NULL max_attempts,
	CONSTRAINT webhook_events_pkey PRIMARY KEY (id),
	CONSTRAINT webhook_events_platform_check CHECK (((platform)::text = ANY ((ARRAY['line'::character varying, 'line_group'::character varying, 'whatsapp'::character varying, 'facebook'::character varying, 'instagram'::character varying, 'email'::character varying, 'webchat'::character varying, 'internal'::character varying, 'unknown'::character varying])::text[]))),
	CONSTRAINT webhook_events_platform_not_null NOT NULL platform,
	CONSTRAINT webhook_events_raw_payload_not_null NOT NULL raw_payload,
	CONSTRAINT webhook_events_received_at_not_null NOT NULL received_at,
	CONSTRAINT webhook_events_status_check CHECK (((status)::text = ANY ((ARRAY['received'::character varying, 'queued'::character varying, 'processing'::character varying, 'processed'::character varying, 'failed'::character varying, 'duplicate'::character varying, 'skipped'::character varying, 'replayed'::character varying])::text[]))),
	CONSTRAINT webhook_events_status_not_null NOT NULL status,
	CONSTRAINT webhook_events_updated_at_not_null NOT NULL updated_at
);
CREATE INDEX idx_webhook_platform_event ON public.webhook_events USING btree (platform, platform_event_id) WHERE (platform_event_id IS NOT NULL);
CREATE INDEX idx_webhook_status_retry ON public.webhook_events USING btree (status, next_retry_at) WHERE ((status)::text = ANY ((ARRAY['received'::character varying, 'failed'::character varying])::text[]));


-- public.admin_audit_logs foreign keys

ALTER TABLE public.admin_audit_logs ADD CONSTRAINT admin_audit_logs_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES public.operators(id) ON DELETE SET NULL;
ALTER TABLE public.admin_audit_logs ADD CONSTRAINT admin_audit_logs_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


-- public.ai_memory foreign keys

ALTER TABLE public.ai_memory ADD CONSTRAINT ai_memory_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE public.ai_memory ADD CONSTRAINT ai_memory_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
ALTER TABLE public.ai_memory ADD CONSTRAINT ai_memory_source_conv_id_fkey FOREIGN KEY (source_conv_id) REFERENCES public.conversations(id) ON DELETE SET NULL;
ALTER TABLE public.ai_memory ADD CONSTRAINT ai_memory_source_ticket_id_fkey FOREIGN KEY (source_ticket_id) REFERENCES public.tickets(id) ON DELETE SET NULL;


-- public.conversation_events foreign keys

ALTER TABLE public.conversation_events ADD CONSTRAINT conversation_events_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


-- public.conversation_handoffs foreign keys

ALTER TABLE public.conversation_handoffs ADD CONSTRAINT conversation_handoffs_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;
ALTER TABLE public.conversation_handoffs ADD CONSTRAINT conversation_handoffs_from_operator_id_fkey FOREIGN KEY (from_operator_id) REFERENCES public.operators(id) ON DELETE SET NULL;
ALTER TABLE public.conversation_handoffs ADD CONSTRAINT conversation_handoffs_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
ALTER TABLE public.conversation_handoffs ADD CONSTRAINT conversation_handoffs_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE SET NULL;
ALTER TABLE public.conversation_handoffs ADD CONSTRAINT conversation_handoffs_to_operator_id_fkey FOREIGN KEY (to_operator_id) REFERENCES public.operators(id) ON DELETE SET NULL;


-- public.conversation_participants foreign keys

ALTER TABLE public.conversation_participants ADD CONSTRAINT conversation_participants_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;
ALTER TABLE public.conversation_participants ADD CONSTRAINT conversation_participants_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES public.identities(id) ON DELETE SET NULL;
ALTER TABLE public.conversation_participants ADD CONSTRAINT conversation_participants_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES public.operators(id) ON DELETE SET NULL;
ALTER TABLE public.conversation_participants ADD CONSTRAINT conversation_participants_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


-- public.conversation_ticket_links foreign keys

ALTER TABLE public.conversation_ticket_links ADD CONSTRAINT conversation_ticket_links_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;
ALTER TABLE public.conversation_ticket_links ADD CONSTRAINT conversation_ticket_links_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE CASCADE;


-- public.conversations foreign keys

ALTER TABLE public.conversations ADD CONSTRAINT conversations_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES public.identities(id) ON DELETE SET NULL;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES public.operators(id) ON DELETE SET NULL;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


-- public.customer_enrollments foreign keys

ALTER TABLE public.customer_enrollments ADD CONSTRAINT customer_enrollments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
ALTER TABLE public.customer_enrollments ADD CONSTRAINT customer_enrollments_enrolled_by_fkey FOREIGN KEY (enrolled_by) REFERENCES public.operators(id) ON DELETE SET NULL;
ALTER TABLE public.customer_enrollments ADD CONSTRAINT customer_enrollments_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE public.customer_enrollments ADD CONSTRAINT customer_enrollments_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


-- public.internal_notes foreign keys

ALTER TABLE public.internal_notes ADD CONSTRAINT internal_notes_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;
ALTER TABLE public.internal_notes ADD CONSTRAINT internal_notes_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES public.operators(id) ON DELETE CASCADE;
ALTER TABLE public.internal_notes ADD CONSTRAINT internal_notes_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE SET NULL;


-- public.knowledge_documents foreign keys

ALTER TABLE public.knowledge_documents ADD CONSTRAINT knowledge_documents_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
ALTER TABLE public.knowledge_documents ADD CONSTRAINT knowledge_documents_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.operators(id) ON DELETE SET NULL;
ALTER TABLE public.knowledge_documents ADD CONSTRAINT knowledge_documents_parent_doc_id_fkey FOREIGN KEY (parent_doc_id) REFERENCES public.knowledge_documents(id) ON DELETE CASCADE;
ALTER TABLE public.knowledge_documents ADD CONSTRAINT knowledge_documents_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


-- public.knowledge_embeddings foreign keys

ALTER TABLE public.knowledge_embeddings ADD CONSTRAINT knowledge_embeddings_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.knowledge_documents(id) ON DELETE CASCADE;
ALTER TABLE public.knowledge_embeddings ADD CONSTRAINT knowledge_embeddings_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


-- public.message_attachments foreign keys

ALTER TABLE public.message_attachments ADD CONSTRAINT message_attachments_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE CASCADE;


-- public.messages foreign keys

ALTER TABLE public.messages ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;
ALTER TABLE public.messages ADD CONSTRAINT messages_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE SET NULL;


-- public.operator_project_access foreign keys

ALTER TABLE public.operator_project_access ADD CONSTRAINT operator_project_access_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.operators(id) ON DELETE SET NULL;
ALTER TABLE public.operator_project_access ADD CONSTRAINT operator_project_access_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES public.operators(id) ON DELETE CASCADE;
ALTER TABLE public.operator_project_access ADD CONSTRAINT operator_project_access_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


-- public.operators foreign keys

ALTER TABLE public.operators ADD CONSTRAINT operators_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
ALTER TABLE public.operators ADD CONSTRAINT operators_primary_team_id_fkey FOREIGN KEY (primary_team_id) REFERENCES public.teams(id) ON DELETE SET NULL;


-- public.profile_projects foreign keys

ALTER TABLE public.profile_projects ADD CONSTRAINT profile_projects_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE public.profile_projects ADD CONSTRAINT profile_projects_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


-- public.project_ai_settings foreign keys

ALTER TABLE public.project_ai_settings ADD CONSTRAINT project_ai_settings_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


-- public.project_business_hours foreign keys

ALTER TABLE public.project_business_hours ADD CONSTRAINT project_business_hours_holiday_calendar_id_fkey FOREIGN KEY (holiday_calendar_id) REFERENCES public.company_holiday_calendars(id) ON DELETE SET NULL;
ALTER TABLE public.project_business_hours ADD CONSTRAINT project_business_hours_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


-- public.project_channels foreign keys

ALTER TABLE public.project_channels ADD CONSTRAINT project_channels_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


-- public.project_feature_flags foreign keys

ALTER TABLE public.project_feature_flags ADD CONSTRAINT project_feature_flags_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


-- public.project_holidays foreign keys

ALTER TABLE public.project_holidays ADD CONSTRAINT project_holidays_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


-- public.project_mcp_permissions foreign keys

ALTER TABLE public.project_mcp_permissions ADD CONSTRAINT project_mcp_permissions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


-- public.project_prompts foreign keys

ALTER TABLE public.project_prompts ADD CONSTRAINT project_prompts_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


-- public.project_routing_rules foreign keys

ALTER TABLE public.project_routing_rules ADD CONSTRAINT project_routing_rules_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


-- public.project_sla_policies foreign keys

ALTER TABLE public.project_sla_policies ADD CONSTRAINT project_sla_policies_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


-- public.projects foreign keys

ALTER TABLE public.projects ADD CONSTRAINT projects_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
ALTER TABLE public.projects ADD CONSTRAINT projects_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE SET NULL;


-- public.takeover_sessions foreign keys

ALTER TABLE public.takeover_sessions ADD CONSTRAINT takeover_sessions_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;
ALTER TABLE public.takeover_sessions ADD CONSTRAINT takeover_sessions_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES public.operators(id) ON DELETE CASCADE;
ALTER TABLE public.takeover_sessions ADD CONSTRAINT takeover_sessions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
ALTER TABLE public.takeover_sessions ADD CONSTRAINT takeover_sessions_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE SET NULL;


-- public.teams foreign keys

ALTER TABLE public.teams ADD CONSTRAINT teams_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
ALTER TABLE public.teams ADD CONSTRAINT teams_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.operators(id) ON DELETE SET NULL;
ALTER TABLE public.teams ADD CONSTRAINT teams_parent_team_id_fkey FOREIGN KEY (parent_team_id) REFERENCES public.teams(id) ON DELETE SET NULL;


-- public.ticket_embeddings foreign keys

ALTER TABLE public.ticket_embeddings ADD CONSTRAINT ticket_embeddings_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE CASCADE;


-- public.ticket_events foreign keys

ALTER TABLE public.ticket_events ADD CONSTRAINT ticket_events_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE CASCADE;


-- public.tickets foreign keys

ALTER TABLE public.tickets ADD CONSTRAINT tickets_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE SET NULL;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_duplicate_of_ticket_id_fkey FOREIGN KEY (duplicate_of_ticket_id) REFERENCES public.tickets(id) ON DELETE SET NULL;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES public.operators(id) ON DELETE SET NULL;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_parent_ticket_id_fkey FOREIGN KEY (parent_ticket_id) REFERENCES public.tickets(id) ON DELETE SET NULL;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);


-- public.webhook_events foreign keys

ALTER TABLE public.webhook_events ADD CONSTRAINT webhook_events_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
ALTER TABLE public.webhook_events ADD CONSTRAINT webhook_events_resulting_conv_id_fkey FOREIGN KEY (resulting_conv_id) REFERENCES public.conversations(id) ON DELETE SET NULL;



-- DROP FUNCTION public.armor(bytea, _text, _text);

CREATE OR REPLACE FUNCTION public.armor(bytea, text[], text[])
 RETURNS text
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_armor$function$
;

-- DROP FUNCTION public.armor(bytea);

CREATE OR REPLACE FUNCTION public.armor(bytea)
 RETURNS text
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_armor$function$
;

-- DROP FUNCTION public.crypt(text, text);

CREATE OR REPLACE FUNCTION public.crypt(text, text)
 RETURNS text
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_crypt$function$
;

-- DROP FUNCTION public.dearmor(text);

CREATE OR REPLACE FUNCTION public.dearmor(text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_dearmor$function$
;

-- DROP FUNCTION public.decrypt(bytea, bytea, text);

CREATE OR REPLACE FUNCTION public.decrypt(bytea, bytea, text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_decrypt$function$
;

-- DROP FUNCTION public.decrypt_iv(bytea, bytea, bytea, text);

CREATE OR REPLACE FUNCTION public.decrypt_iv(bytea, bytea, bytea, text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_decrypt_iv$function$
;

-- DROP FUNCTION public.digest(bytea, text);

CREATE OR REPLACE FUNCTION public.digest(bytea, text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_digest$function$
;

-- DROP FUNCTION public.digest(text, text);

CREATE OR REPLACE FUNCTION public.digest(text, text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_digest$function$
;

-- DROP FUNCTION public.encrypt(bytea, bytea, text);

CREATE OR REPLACE FUNCTION public.encrypt(bytea, bytea, text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_encrypt$function$
;

-- DROP FUNCTION public.encrypt_iv(bytea, bytea, bytea, text);

CREATE OR REPLACE FUNCTION public.encrypt_iv(bytea, bytea, bytea, text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_encrypt_iv$function$
;

-- DROP FUNCTION public.fips_mode();

CREATE OR REPLACE FUNCTION public.fips_mode()
 RETURNS boolean
 LANGUAGE c
 PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_check_fipsmode$function$
;

-- DROP FUNCTION public.gen_random_bytes(int4);

CREATE OR REPLACE FUNCTION public.gen_random_bytes(integer)
 RETURNS bytea
 LANGUAGE c
 PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_random_bytes$function$
;

-- DROP FUNCTION public.gen_random_uuid();

CREATE OR REPLACE FUNCTION public.gen_random_uuid()
 RETURNS uuid
 LANGUAGE c
 PARALLEL SAFE
AS '$libdir/pgcrypto', $function$pg_random_uuid$function$
;

-- DROP FUNCTION public.gen_salt(text, int4);

CREATE OR REPLACE FUNCTION public.gen_salt(text, integer)
 RETURNS text
 LANGUAGE c
 PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_gen_salt_rounds$function$
;

-- DROP FUNCTION public.gen_salt(text);

CREATE OR REPLACE FUNCTION public.gen_salt(text)
 RETURNS text
 LANGUAGE c
 PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_gen_salt$function$
;

-- DROP FUNCTION public.hmac(text, text, text);

CREATE OR REPLACE FUNCTION public.hmac(text, text, text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_hmac$function$
;

-- DROP FUNCTION public.hmac(bytea, bytea, text);

CREATE OR REPLACE FUNCTION public.hmac(bytea, bytea, text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pg_hmac$function$
;

-- DROP FUNCTION public.pgp_armor_headers(in text, out text, out text);

CREATE OR REPLACE FUNCTION public.pgp_armor_headers(text, OUT key text, OUT value text)
 RETURNS SETOF record
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_armor_headers$function$
;

-- DROP FUNCTION public.pgp_key_id(bytea);

CREATE OR REPLACE FUNCTION public.pgp_key_id(bytea)
 RETURNS text
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_key_id_w$function$
;

-- DROP FUNCTION public.pgp_pub_decrypt(bytea, bytea, text);

CREATE OR REPLACE FUNCTION public.pgp_pub_decrypt(bytea, bytea, text)
 RETURNS text
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_pub_decrypt_text$function$
;

-- DROP FUNCTION public.pgp_pub_decrypt(bytea, bytea);

CREATE OR REPLACE FUNCTION public.pgp_pub_decrypt(bytea, bytea)
 RETURNS text
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_pub_decrypt_text$function$
;

-- DROP FUNCTION public.pgp_pub_decrypt(bytea, bytea, text, text);

CREATE OR REPLACE FUNCTION public.pgp_pub_decrypt(bytea, bytea, text, text)
 RETURNS text
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_pub_decrypt_text$function$
;

-- DROP FUNCTION public.pgp_pub_decrypt_bytea(bytea, bytea);

CREATE OR REPLACE FUNCTION public.pgp_pub_decrypt_bytea(bytea, bytea)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_pub_decrypt_bytea$function$
;

-- DROP FUNCTION public.pgp_pub_decrypt_bytea(bytea, bytea, text);

CREATE OR REPLACE FUNCTION public.pgp_pub_decrypt_bytea(bytea, bytea, text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_pub_decrypt_bytea$function$
;

-- DROP FUNCTION public.pgp_pub_decrypt_bytea(bytea, bytea, text, text);

CREATE OR REPLACE FUNCTION public.pgp_pub_decrypt_bytea(bytea, bytea, text, text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_pub_decrypt_bytea$function$
;

-- DROP FUNCTION public.pgp_pub_encrypt(text, bytea, text);

CREATE OR REPLACE FUNCTION public.pgp_pub_encrypt(text, bytea, text)
 RETURNS bytea
 LANGUAGE c
 PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_pub_encrypt_text$function$
;

-- DROP FUNCTION public.pgp_pub_encrypt(text, bytea);

CREATE OR REPLACE FUNCTION public.pgp_pub_encrypt(text, bytea)
 RETURNS bytea
 LANGUAGE c
 PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_pub_encrypt_text$function$
;

-- DROP FUNCTION public.pgp_pub_encrypt_bytea(bytea, bytea);

CREATE OR REPLACE FUNCTION public.pgp_pub_encrypt_bytea(bytea, bytea)
 RETURNS bytea
 LANGUAGE c
 PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_pub_encrypt_bytea$function$
;

-- DROP FUNCTION public.pgp_pub_encrypt_bytea(bytea, bytea, text);

CREATE OR REPLACE FUNCTION public.pgp_pub_encrypt_bytea(bytea, bytea, text)
 RETURNS bytea
 LANGUAGE c
 PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_pub_encrypt_bytea$function$
;

-- DROP FUNCTION public.pgp_sym_decrypt(bytea, text);

CREATE OR REPLACE FUNCTION public.pgp_sym_decrypt(bytea, text)
 RETURNS text
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_sym_decrypt_text$function$
;

-- DROP FUNCTION public.pgp_sym_decrypt(bytea, text, text);

CREATE OR REPLACE FUNCTION public.pgp_sym_decrypt(bytea, text, text)
 RETURNS text
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_sym_decrypt_text$function$
;

-- DROP FUNCTION public.pgp_sym_decrypt_bytea(bytea, text);

CREATE OR REPLACE FUNCTION public.pgp_sym_decrypt_bytea(bytea, text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_sym_decrypt_bytea$function$
;

-- DROP FUNCTION public.pgp_sym_decrypt_bytea(bytea, text, text);

CREATE OR REPLACE FUNCTION public.pgp_sym_decrypt_bytea(bytea, text, text)
 RETURNS bytea
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_sym_decrypt_bytea$function$
;

-- DROP FUNCTION public.pgp_sym_encrypt(text, text, text);

CREATE OR REPLACE FUNCTION public.pgp_sym_encrypt(text, text, text)
 RETURNS bytea
 LANGUAGE c
 PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_sym_encrypt_text$function$
;

-- DROP FUNCTION public.pgp_sym_encrypt(text, text);

CREATE OR REPLACE FUNCTION public.pgp_sym_encrypt(text, text)
 RETURNS bytea
 LANGUAGE c
 PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_sym_encrypt_text$function$
;

-- DROP FUNCTION public.pgp_sym_encrypt_bytea(bytea, text, text);

CREATE OR REPLACE FUNCTION public.pgp_sym_encrypt_bytea(bytea, text, text)
 RETURNS bytea
 LANGUAGE c
 PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_sym_encrypt_bytea$function$
;

-- DROP FUNCTION public.pgp_sym_encrypt_bytea(bytea, text);

CREATE OR REPLACE FUNCTION public.pgp_sym_encrypt_bytea(bytea, text)
 RETURNS bytea
 LANGUAGE c
 PARALLEL SAFE STRICT
AS '$libdir/pgcrypto', $function$pgp_sym_encrypt_bytea$function$
;

-- DROP FUNCTION public.uuid_generate_v7();

CREATE OR REPLACE FUNCTION public.uuid_generate_v7()
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  unix_ts_ms BYTEA;
  uuid_bytes BYTEA;
BEGIN
  unix_ts_ms := substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3);
  uuid_bytes := uuid_send(gen_random_uuid());
  uuid_bytes := overlay(uuid_bytes placing unix_ts_ms from 1 for 6);
  uuid_bytes := set_bit(uuid_bytes, 52, 1);
  uuid_bytes := set_bit(uuid_bytes, 53, 1);
  RETURN encode(uuid_bytes, 'hex')::uuid;
END $function$
;
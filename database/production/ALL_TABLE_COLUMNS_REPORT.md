# 📑 รายงานโครงสร้างคอลัมน์ทั้งหมดใน Schema cs_tickets (45 ตาราง)

### 📌 ตาราง `cs_tickets.admin_audit_logs` (12 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('admin_audit_logs_id_seq'::regclass)` |
| `entity_type` | `character varying` | NO | - |
| `entity_id` | `character varying` | NO | - |
| `action` | `character varying` | NO | - |
| `changes` | `jsonb` | YES | `'{}'::jsonb` |
| `actor` | `character varying` | NO | - |
| `created_at` | `timestamp with time zone` | NO | `now()` |
| `project_id` | `integer` | YES | - |
| `old_value` | `jsonb` | YES | - |
| `new_value` | `jsonb` | YES | - |
| `timestamp` | `timestamp with time zone` | YES | - |
| `operator_id` | `integer` | YES | - |

---

### 📌 ตาราง `cs_tickets.ai_memory` (14 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('ai_memory_id_seq'::regclass)` |
| `profile_id` | `character varying` | YES | - |
| `project_id` | `integer` | YES | - |
| `memory_type` | `character varying` | NO | - |
| `key` | `character varying` | NO | - |
| `value` | `text` | NO | - |
| `confidence` | `numeric` | YES | `1.0` |
| `expires_at` | `timestamp with time zone` | YES | - |
| `created_at` | `timestamp with time zone` | NO | `now()` |
| `updated_at` | `timestamp with time zone` | YES | `now()` |
| `value_embedding` | `text` | YES | - |
| `source_conv_id` | `integer` | YES | - |
| `source_ticket_id` | `integer` | YES | - |
| `memory_scope` | `character varying` | YES | - |

---

### 📌 ตาราง `cs_tickets.companies` (9 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('companies_id_seq'::regclass)` |
| `name` | `character varying` | NO | - |
| `ai_profile_context` | `text` | YES | - |
| `created_at` | `timestamp with time zone` | NO | `now()` |
| `updated_at` | `timestamp with time zone` | YES | `now()` |
| `deleted_at` | `timestamp with time zone` | YES | - |
| `slug` | `character varying` | YES | - |
| `plan_tier` | `character varying` | YES | - |
| `status` | `character varying` | YES | - |

---

### 📌 ตาราง `cs_tickets.company_holiday_calendars` (7 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('company_holiday_calendars_id_seq'::regclass)` |
| `company_id` | `integer` | YES | - |
| `calendar_name` | `character varying` | NO | - |
| `country_code` | `character varying` | YES | `'TH'::character varying` |
| `is_default` | `boolean` | YES | `false` |
| `name` | `character varying` | YES | - |
| `created_at` | `timestamp with time zone` | NO | - |

---

### 📌 ตาราง `cs_tickets.company_holidays` (6 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('company_holidays_id_seq'::regclass)` |
| `calendar_id` | `integer` | YES | - |
| `holiday_date` | `date` | NO | - |
| `name` | `character varying` | NO | - |
| `holiday_type` | `character varying` | YES | - |
| `created_at` | `timestamp with time zone` | NO | - |

---

### 📌 ตาราง `cs_tickets.conversation_events` (8 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('conversation_events_id_seq'::regclass)` |
| `conversation_id` | `integer` | YES | - |
| `event_type` | `character varying` | NO | - |
| `actor_type` | `character varying` | NO | - |
| `actor_id` | `character varying` | YES | - |
| `payload` | `jsonb` | YES | `'{}'::jsonb` |
| `created_at` | `timestamp with time zone` | NO | `now()` |
| `correlation_id` | `character varying` | YES | - |

---

### 📌 ตาราง `cs_tickets.conversation_handoffs` (18 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('conversation_handoffs_id_seq'::regclass)` |
| `conversation_id` | `integer` | YES | - |
| `from_handler` | `character varying` | NO | - |
| `to_handler` | `character varying` | NO | - |
| `reason_code` | `character varying` | YES | - |
| `reason_detail` | `text` | YES | - |
| `context_snapshot` | `jsonb` | YES | `'{}'::jsonb` |
| `created_at` | `timestamp with time zone` | NO | `now()` |
| `project_id` | `integer` | NO | - |
| `from_owner` | `character varying` | YES | - |
| `to_owner` | `character varying` | YES | - |
| `from_operator_id` | `integer` | YES | - |
| `to_operator_id` | `integer` | YES | - |
| `trigger_type` | `character varying` | YES | - |
| `reason` | `text` | YES | - |
| `started_at` | `timestamp with time zone` | NO | - |
| `ended_at` | `timestamp with time zone` | YES | - |
| `ticket_id` | `integer` | YES | - |

---

### 📌 ตาราง `cs_tickets.conversation_participants` (13 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('conversation_participants_id_seq'::regclass)` |
| `conversation_id` | `integer` | YES | - |
| `participant_type` | `character varying` | NO | - |
| `participant_id` | `character varying` | NO | - |
| `joined_at` | `timestamp with time zone` | NO | `now()` |
| `left_at` | `timestamp with time zone` | YES | - |
| `project_id` | `integer` | NO | - |
| `identity_id` | `integer` | YES | - |
| `operator_id` | `integer` | YES | - |
| `session_role` | `character varying` | YES | - |
| `join_source` | `character varying` | YES | - |
| `is_active` | `boolean` | NO | - |
| `channel_metadata` | `jsonb` | NO | - |

---

### 📌 ตาราง `cs_tickets.conversation_ticket_links` (7 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `conversation_id` | `integer` | NO | - |
| `ticket_id` | `integer` | NO | - |
| `link_type` | `character varying` | YES | `'primary'::character varying` |
| `created_at` | `timestamp with time zone` | NO | `now()` |
| `id` | `integer` | NO | `nextval('conversation_ticket_links_id_seq'::regclass)` |
| `linked_at` | `timestamp with time zone` | NO | - |
| `linked_by` | `character varying` | YES | - |

---

### 📌 ตาราง `cs_tickets.conversations` (14 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('conversations_id_seq'::regclass)` |
| `identity_id` | `integer` | YES | - |
| `project_id` | `integer` | YES | - |
| `promptx_conversation_id` | `character varying` | YES | - |
| `channel` | `character varying` | NO | - |
| `status` | `character varying` | YES | `'open'::character varying` |
| `handled_by` | `character varying` | YES | `'ai'::character varying` |
| `assigned_pm` | `character varying` | YES | - |
| `operator_id` | `character varying` | YES | - |
| `takeover_state` | `character varying` | YES | `'none'::character varying` |
| `last_message_at` | `timestamp with time zone` | YES | - |
| `deleted_at` | `timestamp with time zone` | YES | - |
| `created_at` | `timestamp with time zone` | NO | `now()` |
| `updated_at` | `timestamp with time zone` | YES | `now()` |

---

### 📌 ตาราง `cs_tickets.customer_enrollments` (15 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('customer_enrollments_id_seq'::regclass)` |
| `profile_id` | `character varying` | YES | - |
| `project_id` | `integer` | YES | - |
| `customer_type` | `character varying` | YES | `'standard'::character varying` |
| `enrolment_source` | `character varying` | YES | `'web'::character varying` |
| `is_active` | `boolean` | YES | `true` |
| `joined_at` | `timestamp with time zone` | NO | `now()` |
| `updated_at` | `timestamp with time zone` | YES | `now()` |
| `company_id` | `integer` | NO | - |
| `enrollment_source` | `character varying` | YES | - |
| `enrollment_type` | `character varying` | YES | - |
| `first_contact_at` | `timestamp with time zone` | YES | - |
| `enrolled_at` | `timestamp with time zone` | NO | - |
| `enrolled_by` | `integer` | YES | - |
| `notes` | `text` | YES | - |

---

### 📌 ตาราง `cs_tickets.document_embeddings` (7 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('document_embeddings_id_seq'::regclass)` |
| `doc_id` | `character varying` | NO | - |
| `content` | `text` | NO | - |
| `metadata` | `jsonb` | YES | `'{}'::jsonb` |
| `embedding` | `text` | YES | - |
| `created_at` | `timestamp with time zone` | NO | `now()` |
| `updated_at` | `timestamp with time zone` | YES | `now()` |

---

### 📌 ตาราง `cs_tickets.identities` (12 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('identities_id_seq'::regclass)` |
| `profile_id` | `character varying` | YES | - |
| `channel` | `character varying` | NO | - |
| `channel_ref` | `character varying` | NO | - |
| `is_shared` | `boolean` | YES | `false` |
| `created_at` | `timestamp with time zone` | NO | `now()` |
| `updated_at` | `timestamp with time zone` | YES | `now()` |
| `deleted_at` | `timestamp with time zone` | YES | - |
| `gdpr_erased_at` | `timestamp with time zone` | YES | - |
| `is_pii` | `boolean` | NO | - |
| `account_type` | `character varying` | YES | - |
| `is_shared_account` | `boolean` | NO | - |

---

### 📌 ตาราง `cs_tickets.internal_notes` (11 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('internal_notes_id_seq'::regclass)` |
| `conversation_id` | `integer` | YES | - |
| `ticket_id` | `integer` | YES | - |
| `operator_id` | `character varying` | YES | - |
| `note_text` | `text` | NO | - |
| `is_pinned` | `boolean` | YES | `false` |
| `mentions` | `jsonb` | YES | `'[]'::jsonb` |
| `created_at` | `timestamp with time zone` | NO | `now()` |
| `content` | `text` | NO | - |
| `mentioned_ops` | `ARRAY` | NO | - |
| `updated_at` | `timestamp with time zone` | NO | - |

---

### 📌 ตาราง `cs_tickets.knowledge_documents` (23 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('knowledge_documents_id_seq'::regclass)` |
| `project_id` | `integer` | YES | - |
| `title` | `character varying` | NO | - |
| `content` | `text` | NO | - |
| `category` | `character varying` | YES | `'general'::character varying` |
| `is_active` | `boolean` | YES | `true` |
| `deleted_at` | `timestamp with time zone` | YES | - |
| `created_at` | `timestamp with time zone` | NO | `now()` |
| `updated_at` | `timestamp with time zone` | YES | `now()` |
| `company_id` | `integer` | NO | - |
| `external_doc_id` | `character varying` | YES | - |
| `raw_content` | `text` | NO | - |
| `processed_content` | `text` | YES | - |
| `document_type` | `character varying` | YES | - |
| `language` | `character varying` | YES | - |
| `source_url` | `text` | YES | - |
| `chunk_index` | `integer` | NO | - |
| `chunk_total` | `integer` | NO | - |
| `parent_doc_id` | `uuid` | YES | - |
| `version` | `integer` | NO | - |
| `indexed_at` | `timestamp with time zone` | YES | - |
| `metadata` | `jsonb` | NO | - |
| `created_by` | `integer` | YES | - |

---

### 📌 ตาราง `cs_tickets.knowledge_embeddings` (10 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('knowledge_embeddings_id_seq'::regclass)` |
| `document_id` | `integer` | YES | - |
| `chunk_content` | `text` | NO | - |
| `chunk_index` | `integer` | NO | - |
| `embedding` | `text` | YES | - |
| `created_at` | `timestamp with time zone` | NO | `now()` |
| `project_id` | `integer` | NO | - |
| `model_name` | `character varying` | YES | - |
| `model_version` | `character varying` | YES | - |
| `dimensions` | `integer` | NO | - |

---

### 📌 ตาราง `cs_tickets.message_attachments` (11 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('message_attachments_id_seq'::regclass)` |
| `message_id` | `integer` | YES | - |
| `file_url` | `text` | NO | - |
| `thumbnail_url` | `text` | YES | - |
| `file_name` | `character varying` | NO | - |
| `file_type` | `character varying` | NO | - |
| `file_size` | `integer` | NO | - |
| `storage_key` | `character varying` | YES | - |
| `attachment_status` | `character varying` | YES | `'ready'::character varying` |
| `metadata` | `jsonb` | YES | `'{}'::jsonb` |
| `created_at` | `timestamp with time zone` | NO | `now()` |

---

### 📌 ตาราง `cs_tickets.messages` (16 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('messages_id_seq'::regclass)` |
| `conversation_id` | `integer` | YES | - |
| `ticket_id` | `integer` | YES | - |
| `reply_to_message_id` | `integer` | YES | - |
| `role` | `character varying` | NO | - |
| `content` | `text` | NO | - |
| `message_type` | `character varying` | YES | `'text'::character varying` |
| `quote_token` | `text` | YES | - |
| `external_id` | `character varying` | YES | - |
| `delivery_status` | `character varying` | YES | `'sent'::character varying` |
| `reactions` | `jsonb` | YES | `'{}'::jsonb` |
| `is_pinned` | `boolean` | YES | `false` |
| `deleted_at` | `timestamp with time zone` | YES | - |
| `created_at` | `timestamp with time zone` | NO | `now()` |
| `query` | `text` | YES | - |
| `message_purpose` | `character varying` | YES | - |

---

### 📌 ตาราง `cs_tickets.notification_logs` (8 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('notification_logs_id_seq'::regclass)` |
| `ticket_id` | `integer` | YES | - |
| `operator_id` | `character varying` | YES | - |
| `channel` | `character varying` | NO | - |
| `recipient_ref` | `character varying` | NO | - |
| `status` | `character varying` | YES | `'SENT'::character varying` |
| `ack_at` | `timestamp with time zone` | YES | - |
| `created_at` | `timestamp with time zone` | NO | `now()` |

---

### 📌 ตาราง `cs_tickets.on_call_rosters` (7 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('on_call_rosters_id_seq'::regclass)` |
| `project_id` | `integer` | YES | - |
| `operator_id` | `character varying` | YES | - |
| `shift_start` | `timestamp with time zone` | NO | - |
| `shift_end` | `timestamp with time zone` | NO | - |
| `is_active` | `boolean` | YES | `true` |
| `created_at` | `timestamp with time zone` | NO | `now()` |

---

### 📌 ตาราง `cs_tickets.operator_project_access` (7 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `operator_id` | `character varying` | NO | - |
| `project_id` | `integer` | NO | - |
| `access_level` | `character varying` | NO | `'agent'::character varying` |
| `assigned_at` | `timestamp with time zone` | NO | `now()` |
| `role` | `character varying` | YES | - |
| `granted_at` | `timestamp with time zone` | NO | - |
| `granted_by` | `integer` | YES | - |

---

### 📌 ตาราง `cs_tickets.operators` (17 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `character varying` | NO | - |
| `company_id` | `integer` | YES | - |
| `email` | `character varying` | NO | - |
| `name` | `character varying` | NO | - |
| `role` | `character varying` | NO | `'agent'::character varying` |
| `is_active` | `boolean` | YES | `true` |
| `last_login_at` | `timestamp with time zone` | YES | - |
| `metadata` | `jsonb` | YES | `'{}'::jsonb` |
| `created_at` | `timestamp with time zone` | NO | `now()` |
| `updated_at` | `timestamp with time zone` | YES | `now()` |
| `display_name` | `character varying` | YES | - |
| `avatar_url` | `text` | YES | - |
| `status` | `character varying` | YES | - |
| `password_hash` | `text` | YES | - |
| `settings` | `jsonb` | NO | - |
| `deleted_at` | `timestamp with time zone` | YES | - |
| `primary_team_id` | `integer` | YES | - |

---

### 📌 ตาราง `cs_tickets.outbox_events` (11 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('outbox_events_id_seq'::regclass)` |
| `aggregate_type` | `character varying` | NO | - |
| `aggregate_id` | `character varying` | NO | - |
| `event_type` | `character varying` | NO | - |
| `payload` | `jsonb` | NO | - |
| `status` | `character varying` | YES | `'pending'::character varying` |
| `processed_at` | `timestamp with time zone` | YES | - |
| `created_at` | `timestamp with time zone` | NO | `now()` |
| `attempts` | `integer` | NO | - |
| `error_message` | `text` | YES | - |
| `updated_at` | `timestamp with time zone` | YES | - |

---

### 📌 ตาราง `cs_tickets.profile_projects` (3 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `profile_id` | `character varying` | NO | - |
| `project_id` | `integer` | NO | - |
| `created_at` | `timestamp with time zone` | NO | `now()` |

---

### 📌 ตาราง `cs_tickets.profiles` (17 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `character varying` | NO | - |
| `company_id` | `integer` | YES | - |
| `name` | `character varying` | NO | - |
| `email` | `character varying` | YES | - |
| `phone` | `character varying` | YES | - |
| `gdpr_consent` | `boolean` | YES | `true` |
| `metadata` | `jsonb` | YES | `'{}'::jsonb` |
| `created_at` | `timestamp with time zone` | NO | `now()` |
| `updated_at` | `timestamp with time zone` | YES | `now()` |
| `deleted_at` | `timestamp with time zone` | YES | - |
| `gdpr_consent_at` | `timestamp with time zone` | YES | - |
| `gdpr_erased_at` | `timestamp with time zone` | YES | - |
| `is_pii_erased` | `boolean` | NO | - |
| `data_region` | `character varying` | YES | - |
| `merged_into_profile_id` | `integer` | YES | - |
| `merged_at` | `timestamp with time zone` | YES | - |
| `is_merged` | `boolean` | NO | - |

---

### 📌 ตาราง `cs_tickets.project_ai_settings` (9 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('project_ai_settings_id_seq'::regclass)` |
| `project_id` | `integer` | YES | - |
| `confidence_threshold` | `numeric` | YES | `0.75` |
| `max_handoff_depth` | `integer` | YES | `3` |
| `vector_match_limit` | `integer` | YES | `5` |
| `allow_tools` | `boolean` | YES | `true` |
| `updated_at` | `timestamp with time zone` | YES | `now()` |
| `vector_match_threshold` | `numeric` | YES | - |
| `created_at` | `timestamp with time zone` | YES | - |

---

### 📌 ตาราง `cs_tickets.project_business_hours` (8 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('project_business_hours_id_seq'::regclass)` |
| `project_id` | `integer` | YES | - |
| `day_of_week` | `integer` | NO | - |
| `start_time` | `time without time zone` | NO | - |
| `end_time` | `time without time zone` | NO | - |
| `timezone` | `character varying` | YES | `'Asia/Bangkok'::character varying` |
| `created_at` | `timestamp with time zone` | YES | - |
| `holiday_calendar_id` | `integer` | YES | - |

---

### 📌 ตาราง `cs_tickets.project_channels` (15 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('project_channels_id_seq'::regclass)` |
| `project_id` | `integer` | YES | - |
| `channel_type` | `character varying` | NO | - |
| `is_enabled` | `boolean` | YES | `true` |
| `config_metadata` | `jsonb` | YES | `'{}'::jsonb` |
| `updated_at` | `timestamp with time zone` | YES | `now()` |
| `channel_id` | `character varying` | YES | - |
| `secret_token` | `text` | YES | - |
| `credentials_json` | `jsonb` | YES | - |
| `active` | `boolean` | YES | - |
| `created_at` | `timestamp with time zone` | YES | - |
| `secret_token_encrypted` | `bytea` | YES | - |
| `credentials_encrypted` | `bytea` | YES | - |
| `encryption_key_id` | `character varying` | YES | - |
| `encrypted_at` | `timestamp with time zone` | YES | - |

---

### 📌 ตาราง `cs_tickets.project_feature_flags` (7 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('project_feature_flags_id_seq'::regclass)` |
| `project_id` | `integer` | YES | - |
| `flag_key` | `character varying` | NO | - |
| `is_enabled` | `boolean` | YES | `false` |
| `config` | `jsonb` | YES | `'{}'::jsonb` |
| `flag_name` | `character varying` | YES | - |
| `created_at` | `timestamp with time zone` | YES | - |

---

### 📌 ตาราง `cs_tickets.project_holidays` (6 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('project_holidays_id_seq'::regclass)` |
| `project_id` | `integer` | YES | - |
| `holiday_date` | `date` | NO | - |
| `description` | `character varying` | YES | - |
| `name` | `character varying` | YES | - |
| `created_at` | `timestamp with time zone` | YES | - |

---

### 📌 ตาราง `cs_tickets.project_mcp_permissions` (7 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('project_mcp_permissions_id_seq'::regclass)` |
| `project_id` | `integer` | YES | - |
| `tool_name` | `character varying` | NO | - |
| `is_allowed` | `boolean` | YES | `true` |
| `policy_rules` | `jsonb` | YES | `'{}'::jsonb` |
| `allowed_roles` | `ARRAY` | YES | - |
| `created_at` | `timestamp with time zone` | YES | - |

---

### 📌 ตาราง `cs_tickets.project_prompts` (13 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('project_prompts_id_seq'::regclass)` |
| `project_id` | `integer` | YES | - |
| `system_prompt` | `text` | NO | - |
| `model_name` | `character varying` | YES | `'gpt-4o'::character varying` |
| `temperature` | `numeric` | YES | `0.2` |
| `max_tokens` | `integer` | YES | `2000` |
| `updated_at` | `timestamp with time zone` | YES | `now()` |
| `system_instruction` | `text` | NO | - |
| `created_at` | `timestamp with time zone` | YES | - |
| `version` | `integer` | NO | - |
| `version_label` | `character varying` | YES | - |
| `is_active` | `boolean` | NO | - |
| `ab_weight` | `numeric` | YES | - |

---

### 📌 ตาราง `cs_tickets.project_routing_rules` (10 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('project_routing_rules_id_seq'::regclass)` |
| `project_id` | `integer` | YES | - |
| `rule_name` | `character varying` | NO | - |
| `condition_json` | `jsonb` | NO | - |
| `target_handler` | `character varying` | NO | - |
| `priority` | `integer` | YES | `1` |
| `is_active` | `boolean` | YES | `true` |
| `rule_type` | `character varying` | YES | - |
| `conditions` | `jsonb` | YES | - |
| `created_at` | `timestamp with time zone` | YES | - |

---

### 📌 ตาราง `cs_tickets.project_sla_policies` (15 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('project_sla_policies_id_seq'::regclass)` |
| `project_id` | `integer` | YES | - |
| `priority` | `character varying` | NO | - |
| `first_response_time_minutes` | `integer` | NO | - |
| `resolution_time_minutes` | `integer` | NO | - |
| `is_active` | `boolean` | YES | `true` |
| `updated_at` | `timestamp with time zone` | YES | `now()` |
| `resolve_hours` | `integer` | YES | - |
| `created_at` | `character varying` | YES | - |
| `priority_name` | `character varying` | YES | - |
| `description` | `character varying` | YES | - |
| `response_hours` | `integer` | YES | - |
| `service_window` | `character varying` | YES | - |
| `display_order` | `integer` | YES | - |
| `is_default` | `boolean` | YES | - |

---

### 📌 ตาราง `cs_tickets.projects` (13 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('projects_id_seq'::regclass)` |
| `company_id` | `integer` | YES | - |
| `name` | `character varying` | NO | - |
| `project_type` | `character varying` | YES | `'support'::character varying` |
| `environment` | `character varying` | YES | `'production'::character varying` |
| `metadata` | `jsonb` | YES | `'{}'::jsonb` |
| `created_at` | `timestamp with time zone` | NO | `now()` |
| `updated_at` | `timestamp with time zone` | YES | `now()` |
| `deleted_at` | `character varying` | YES | - |
| `slug` | `character varying` | YES | - |
| `status` | `character varying` | YES | - |
| `timezone` | `character varying` | YES | - |
| `team_id` | `character varying` | YES | - |

---

### 📌 ตาราง `cs_tickets.schema_migrations` (2 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `version` | `character varying` | NO | - |
| `executed_at` | `timestamp with time zone` | NO | `now()` |

---

### 📌 ตาราง `cs_tickets.takeover_sessions` (13 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('takeover_sessions_id_seq'::regclass)` |
| `conversation_id` | `integer` | YES | - |
| `operator_id` | `character varying` | YES | - |
| `status` | `character varying` | NO | `'ACTIVE_HUMAN'::character varying` |
| `reason` | `text` | YES | - |
| `started_at` | `timestamp with time zone` | NO | `now()` |
| `expires_at` | `timestamp with time zone` | NO | - |
| `released_at` | `timestamp with time zone` | YES | - |
| `project_id` | `character varying` | YES | - |
| `acquired_at` | `character varying` | YES | - |
| `release_reason` | `character varying` | YES | - |
| `notes` | `character varying` | YES | - |
| `ticket_id` | `character varying` | YES | - |

---

### 📌 ตาราง `cs_tickets.teams` (9 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('teams_id_seq'::regclass)` |
| `company_id` | `integer` | YES | - |
| `parent_team_id` | `integer` | YES | - |
| `name` | `character varying` | NO | - |
| `description` | `text` | YES | - |
| `created_at` | `timestamp with time zone` | NO | `now()` |
| `updated_at` | `timestamp with time zone` | YES | `now()` |
| `status` | `character varying` | YES | - |
| `created_by` | `character varying` | YES | - |

---

### 📌 ตาราง `cs_tickets.ticket_embeddings` (6 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `ticket_id` | `integer` | NO | - |
| `content` | `text` | NO | - |
| `embedding` | `text` | YES | - |
| `updated_at` | `timestamp with time zone` | YES | `now()` |
| `id` | `character varying` | YES | - |
| `created_at` | `character varying` | YES | - |

---

### 📌 ตาราง `cs_tickets.ticket_events` (8 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('ticket_events_id_seq'::regclass)` |
| `ticket_id` | `integer` | YES | - |
| `event_type` | `character varying` | NO | - |
| `actor` | `character varying` | NO | - |
| `payload` | `jsonb` | YES | `'{}'::jsonb` |
| `correlation_id` | `character varying` | YES | - |
| `created_at` | `timestamp with time zone` | NO | `now()` |
| `source` | `character varying` | YES | - |

---

### 📌 ตาราง `cs_tickets.tickets` (38 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('tickets_id_seq'::regclass)` |
| `conversation_id` | `integer` | YES | - |
| `project_id` | `integer` | YES | - |
| `ticket_number` | `character varying` | YES | - |
| `subject` | `character varying` | NO | - |
| `summary` | `text` | YES | - |
| `status` | `character varying` | YES | `'open'::character varying` |
| `priority` | `character varying` | YES | `'medium'::character varying` |
| `severity` | `character varying` | YES | `'low'::character varying` |
| `assigned_pm` | `character varying` | YES | - |
| `created_via` | `character varying` | YES | `'ai'::character varying` |
| `plane_issue_id` | `character varying` | YES | - |
| `enrichment_state` | `jsonb` | YES | `'{}'::jsonb` |
| `due_date` | `timestamp with time zone` | YES | - |
| `resolved_at` | `timestamp with time zone` | YES | - |
| `closed_at` | `timestamp with time zone` | YES | - |
| `created_at` | `timestamp with time zone` | NO | `now()` |
| `updated_at` | `timestamp with time zone` | YES | `now()` |
| `ticket_id` | `character varying` | YES | - |
| `title` | `character varying` | YES | - |
| `original_problem_statement` | `character varying` | YES | - |
| `running_summary` | `character varying` | YES | - |
| `last_ai_summary` | `character varying` | YES | - |
| `duplicate_of_ticket_id` | `character varying` | YES | - |
| `duplicate_score` | `real` | YES | - |
| `duplicate_reason` | `character varying` | YES | - |
| `ai_confidence_metrics` | `character varying` | YES | - |
| `searchable_text` | `character varying` | YES | - |
| `operator_id` | `character varying` | YES | - |
| `first_response_at` | `character varying` | YES | - |
| `sla_breached` | `boolean` | YES | - |
| `sla_breach_at` | `character varying` | YES | - |
| `deleted_at` | `character varying` | YES | - |
| `parent_ticket_id` | `character varying` | YES | - |
| `issue_category` | `character varying` | YES | - |
| `total_sla_exposure_minutes` | `integer` | YES | - |
| `reopened_count` | `integer` | YES | - |
| `last_reopened_at` | `character varying` | YES | - |

---

### 📌 ตาราง `cs_tickets.traces` (15 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('traces_id_seq'::regclass)` |
| `trace_id` | `uuid` | NO | - |
| `session_id` | `character varying` | YES | - |
| `agent_id` | `character varying` | YES | - |
| `tool_name` | `character varying` | YES | - |
| `called_at` | `timestamp with time zone` | YES | `now()` |
| `reason` | `text` | YES | - |
| `arguments` | `jsonb` | YES | - |
| `result` | `jsonb` | YES | - |
| `status` | `character varying` | YES | `'success'::character varying` |
| `error_message` | `text` | YES | - |
| `completed_at` | `timestamp with time zone` | YES | - |
| `request_id` | `character varying` | YES | - |
| `conversation_id` | `character varying` | YES | - |
| `parent_trace_id` | `character varying` | YES | - |

---

### 📌 ตาราง `cs_tickets.verification_requests` (10 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('verification_requests_id_seq'::regclass)` |
| `project_id` | `integer` | YES | - |
| `profile_id` | `character varying` | YES | - |
| `strategy` | `character varying` | NO | - |
| `target_ref` | `character varying` | NO | - |
| `otp_code_hash` | `character varying` | YES | - |
| `invitation_token` | `character varying` | YES | - |
| `expires_at` | `timestamp with time zone` | NO | - |
| `is_used` | `boolean` | YES | `false` |
| `created_at` | `timestamp with time zone` | NO | `now()` |

---

### 📌 ตาราง `cs_tickets.webchat_sessions` (8 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('webchat_sessions_id_seq'::regclass)` |
| `conversation_id` | `integer` | YES | - |
| `identity_id` | `integer` | YES | - |
| `session_token` | `text` | NO | - |
| `guest_uuid` | `character varying` | NO | - |
| `is_active` | `boolean` | YES | `true` |
| `last_active_at` | `timestamp with time zone` | YES | `now()` |
| `created_at` | `timestamp with time zone` | NO | `now()` |

---

### 📌 ตาราง `cs_tickets.webhook_events` (27 คอลัมน์)
| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |
| :--- | :--- | :---: | :--- |
| `id` | `integer` | NO | `nextval('webhook_events_id_seq'::regclass)` |
| `channel` | `character varying` | NO | - |
| `event_id` | `character varying` | NO | - |
| `payload` | `jsonb` | NO | - |
| `processed_status` | `character varying` | YES | `'received'::character varying` |
| `created_at` | `timestamp with time zone` | NO | `now()` |
| `project_id` | `character varying` | YES | - |
| `platform` | `character varying` | YES | - |
| `channel_type` | `character varying` | YES | - |
| `channel_id` | `character varying` | YES | - |
| `platform_event_id` | `character varying` | YES | - |
| `idempotency_key` | `character varying` | YES | - |
| `raw_payload` | `character varying` | YES | - |
| `http_headers` | `character varying` | YES | - |
| `hmac_signature` | `character varying` | YES | - |
| `hmac_valid` | `character varying` | YES | - |
| `status` | `character varying` | YES | - |
| `attempts` | `character varying` | YES | - |
| `max_attempts` | `character varying` | YES | - |
| `last_error` | `character varying` | YES | - |
| `next_retry_at` | `character varying` | YES | - |
| `processed_at` | `character varying` | YES | - |
| `bullmq_job_id` | `character varying` | YES | - |
| `resulting_conv_id` | `character varying` | YES | - |
| `ip_address` | `character varying` | YES | - |
| `received_at` | `character varying` | YES | - |
| `updated_at` | `character varying` | YES | - |

---


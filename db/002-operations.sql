ALTER TABLE approval_requirement ADD UNIQUE(tenant_id,company_id,plan_id,action_id,id);
ALTER TABLE approval_scope ADD FOREIGN KEY(tenant_id,company_id,plan_id,action_id,requirement_id)
  REFERENCES approval_requirement(tenant_id,company_id,plan_id,action_id,id);
ALTER TABLE task ADD UNIQUE(tenant_id,company_id,plan_id,action_id,id);
ALTER TABLE command ADD FOREIGN KEY(tenant_id,company_id,plan_id,action_id,task_id)
  REFERENCES task(tenant_id,company_id,plan_id,action_id,id);
ALTER TABLE business_case ADD COLUMN context jsonb NOT NULL DEFAULT '{}';
ALTER TABLE ai_run ADD COLUMN input jsonb NOT NULL DEFAULT '{}';
ALTER TABLE ai_run ADD COLUMN metrics jsonb;
CREATE TABLE local_identity (
  principal_id uuid PRIMARY KEY REFERENCES principal(id), login text NOT NULL UNIQUE, password_hash text NOT NULL
);
CREATE INDEX intake_lookup ON intake_row (company_id, source_ref, row_id);
CREATE INDEX case_status ON business_case (company_id, status, created_at DESC);
CREATE INDEX scope_status ON approval_scope (company_id, state);
CREATE INDEX audit_object ON audit_event (company_id, object_id, created_at);
REVOKE ALL ON local_identity FROM PUBLIC;

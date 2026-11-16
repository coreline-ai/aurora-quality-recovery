ALTER TABLE approval_decision ADD UNIQUE(tenant_id,company_id,id);
ALTER TABLE evidence ADD UNIQUE(tenant_id,company_id,case_id,id);
CREATE TABLE recovery_work (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  case_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  department text NOT NULL CHECK (department IN ('SALES','PRODUCTION')),
  state text NOT NULL DEFAULT 'WAITING' CHECK (state IN ('WAITING','BLOCKED','ANSWERED','CANCELLED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  due_at timestamptz NOT NULL,
  evidence_id uuid,
  FOREIGN KEY (tenant_id,company_id,case_id) REFERENCES business_case(tenant_id,company_id,id),
  FOREIGN KEY (tenant_id,company_id,decision_id) REFERENCES approval_decision(tenant_id,company_id,id),
  FOREIGN KEY (tenant_id,company_id,case_id,evidence_id) REFERENCES evidence(tenant_id,company_id,case_id,id),
  UNIQUE (decision_id,department)
);
CREATE INDEX recovery_work_case ON recovery_work(case_id,decision_id);
INSERT INTO recovery_work(tenant_id,company_id,case_id,decision_id,department,due_at)
SELECT p.tenant_id,p.company_id,p.case_id,d.id,department,a.due_at
FROM approval_decision d JOIN approval_scope s ON s.id=d.scope_id
JOIN action_plan p ON p.id=s.plan_id JOIN business_case b ON b.id=p.case_id
JOIN plan_action a ON a.id=s.action_id CROSS JOIN unnest(ARRAY['SALES','PRODUCTION']) AS dept(department)
WHERE b.context->>'batch'='DEMO-BATCH-01' AND a.kind='RECALL' AND a.target_ref='DEMO-SHIP-01';
ALTER TABLE recovery_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_work FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON recovery_work USING (company_access(tenant_id,company_id))
  WITH CHECK (company_access(tenant_id,company_id));
REVOKE ALL ON recovery_work FROM PUBLIC;

CREATE TABLE followup_ticket (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  case_id uuid NOT NULL,
  closure_id uuid NOT NULL,
  item_no integer NOT NULL CHECK (item_no > 0),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  expected_evidence text NOT NULL CHECK (length(expected_evidence) BETWEEN 1 AND 500),
  owner_id uuid NOT NULL,
  owner_role text NOT NULL CHECK (owner_role IN ('ANALYST','SCM','SALES_SUPPORT')),
  due_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','COMPLETED')),
  completion_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state='COMPLETED')=(completion_id IS NOT NULL)),
  FOREIGN KEY (tenant_id,company_id,case_id) REFERENCES business_case(tenant_id,company_id,id),
  FOREIGN KEY (tenant_id,company_id,case_id,closure_id) REFERENCES evidence(tenant_id,company_id,case_id,id),
  FOREIGN KEY (tenant_id,company_id,case_id,completion_id) REFERENCES evidence(tenant_id,company_id,case_id,id),
  FOREIGN KEY (tenant_id,owner_id) REFERENCES principal(tenant_id,id),
  UNIQUE (tenant_id,company_id,case_id,item_no)
);
CREATE INDEX followup_ticket_owner ON followup_ticket(company_id,owner_id,state,due_at);
ALTER TABLE followup_ticket ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_ticket FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON followup_ticket USING (company_access(tenant_id,company_id))
  WITH CHECK (company_access(tenant_id,company_id));
REVOKE ALL ON followup_ticket FROM PUBLIC;

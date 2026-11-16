CREATE TABLE logistics_history (
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  classification text NOT NULL CHECK (classification IN ('SIMULATED_EVENT','VERIFIED_OPERATION')),
  case_key text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  category text NOT NULL,
  product text NOT NULL,
  issue text NOT NULL,
  center_codes text[] NOT NULL CHECK (cardinality(center_codes) > 0),
  closed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL CHECK (recorded_at >= closed_at),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,company_id,classification,case_key,revision),
  FOREIGN KEY (tenant_id,company_id) REFERENCES company(tenant_id,id)
);
CREATE INDEX logistics_history_company_time ON logistics_history(company_id,classification,recorded_at);
ALTER TABLE logistics_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_history FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON logistics_history USING (company_access(tenant_id,company_id))
  WITH CHECK (company_access(tenant_id,company_id));
REVOKE ALL ON logistics_history FROM PUBLIC;

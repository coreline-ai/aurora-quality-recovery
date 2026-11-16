CREATE TABLE warehouse_reference_pack (
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  version text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND payload->>'classification'='SIMULATED_EVENT'),
  PRIMARY KEY (tenant_id,company_id,version),
  FOREIGN KEY (tenant_id,company_id) REFERENCES company(tenant_id,id)
);
ALTER TABLE warehouse_reference_pack ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_reference_pack FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON warehouse_reference_pack USING (company_access(tenant_id,company_id));
REVOKE ALL ON warehouse_reference_pack FROM PUBLIC;

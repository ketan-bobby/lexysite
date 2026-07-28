-- Rollback for 0010_billing_term_and_limit_notifications.sql
DROP INDEX IF EXISTS plan_limit_notifications_tenant_kind_period_uq;
DROP TABLE IF EXISTS plan_limit_notifications;

ALTER TABLE tenants
  DROP COLUMN IF EXISTS billing_term;

DROP TYPE IF EXISTS tenant_billing_term;

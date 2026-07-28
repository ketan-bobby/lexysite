-- Rollback for 0056_billing_gaps_hardening.sql
DROP TABLE IF EXISTS public.billing_alerts_sent;

DROP INDEX IF EXISTS public.fee_line_items_seat_overage_period_uq;
ALTER TABLE public.fee_line_items
  DROP CONSTRAINT IF EXISTS fee_line_items_per_hire_shape;
ALTER TABLE public.fee_line_items
  DROP CONSTRAINT IF EXISTS fee_line_items_item_type_check;
-- NOT NULLs are only safe to restore after deleting non-per_hire rows:
DELETE FROM public.fee_line_items WHERE item_type <> 'per_hire';
ALTER TABLE public.fee_line_items ALTER COLUMN application_id SET NOT NULL;
ALTER TABLE public.fee_line_items ALTER COLUMN candidate_id  SET NOT NULL;
ALTER TABLE public.fee_line_items ALTER COLUMN job_id        SET NOT NULL;
ALTER TABLE public.fee_line_items ALTER COLUMN origin_channel SET NOT NULL;
ALTER TABLE public.fee_line_items ALTER COLUMN evidence       SET NOT NULL;
ALTER TABLE public.fee_line_items
  DROP COLUMN IF EXISTS item_type,
  DROP COLUMN IF EXISTS description,
  DROP COLUMN IF EXISTS period_key;

ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_grace_period_days_range;
ALTER TABLE public.tenants DROP COLUMN IF EXISTS grace_period_days;

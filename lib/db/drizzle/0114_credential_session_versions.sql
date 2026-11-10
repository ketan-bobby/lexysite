-- Identity/control database. Apply before deploying every API replica.
ALTER TABLE public.users ADD COLUMN credential_version text NOT NULL DEFAULT '0';

-- Rotate atomically with EVERY password-hash change, including future writers.
-- No timestamps: two changes in the same second must invalidate earlier tokens.
CREATE FUNCTION public.lexy_rotate_credential_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN
    NEW.credential_version := gen_random_uuid()::text;
  ELSE
    NEW.credential_version := OLD.credential_version;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER lexy_rotate_credential_version
BEFORE UPDATE OF password_hash, credential_version ON public.users
FOR EACH ROW EXECUTE FUNCTION public.lexy_rotate_credential_version();

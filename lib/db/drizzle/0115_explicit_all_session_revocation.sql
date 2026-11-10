-- Identity/control DB, after 0114. NULL requests a fresh server-generated epoch;
-- arbitrary supplied epochs are still ignored, preventing old-session revival.
CREATE OR REPLACE FUNCTION public.lexy_rotate_credential_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
     OR NEW.credential_version IS NULL THEN
    NEW.credential_version := gen_random_uuid()::text;
  ELSE
    NEW.credential_version := OLD.credential_version;
  END IF;
  RETURN NEW;
END;
$$;

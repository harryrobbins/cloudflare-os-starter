BEGIN;
-- Public semantic definitions only, never storage mappings, SQL or grant context.
CREATE FUNCTION records.get_model(module_id text,api_major int DEFAULT 1) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT m.manifest->'profile' FROM records_private.modules m WHERE m.id=module_id AND m.api_major=get_model.api_major
$$;
GRANT EXECUTE ON FUNCTION records.get_model(text,int) TO records_gateway;
COMMIT;

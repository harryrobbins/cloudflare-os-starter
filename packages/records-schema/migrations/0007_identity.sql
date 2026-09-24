-- Identity, Phase 2 (canonical plan §5): the shared replay guard for delegated tokens.
--
-- A delegated token (@records/identity) is single use: its `jti` is claimed once, after every
-- other check passed. Workers run many isolates, so the claim must be shared: this table. The app
-- role cannot read or write it directly; it can only call records.claim_delegated_token, which
-- claims one id in one statement (an expired row with the same id is reclaimed, not refused).
-- The publisher prunes expired rows through records.prune_delegated_token_uses().
--
-- identity_mappings convention for OIDC issuers (no schema change needed): `issuer` is the exact
-- `iss` of the trusted_issuers row, and `subject` is the token's `sub` for a person, or its
-- `common_name` for an Access service token. Operators add mappings by hand; nothing is
-- provisioned from a token, and an unmapped subject is refused.

CREATE TABLE records.delegated_token_uses (
  jti         text        PRIMARY KEY CHECK (length(jti) BETWEEN 16 AND 64),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX delegated_token_uses_expires ON records.delegated_token_uses (expires_at);
COMMENT ON TABLE records.delegated_token_uses IS 'records:module-global';
REVOKE ALL ON records.delegated_token_uses FROM PUBLIC;

-- Claim a token id. True the first time (or once the earlier claim has expired), false for a
-- replay. `p_expires_at` is the token's `exp`; delegated tokens live 60 s, so a claim further
-- than 10 minutes ahead is refused as an error rather than stored for long.
CREATE FUNCTION records.claim_delegated_token(p_jti text, p_expires_at timestamptz)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, records
  AS $$
  DECLARE
    v_claimed text;
  BEGIN
    IF p_jti IS NULL OR length(p_jti) NOT BETWEEN 16 AND 64 OR p_expires_at IS NULL
       OR p_expires_at > now() + interval '10 minutes' THEN
      RAISE EXCEPTION 'invalid delegated token claim' USING ERRCODE = '22023';
    END IF;
    INSERT INTO records.delegated_token_uses AS u (jti, expires_at)
         VALUES (p_jti, p_expires_at)
    ON CONFLICT (jti) DO UPDATE SET expires_at = EXCLUDED.expires_at
          WHERE u.expires_at < now()
    RETURNING u.jti INTO v_claimed;
    RETURN v_claimed IS NOT NULL;
  END
  $$;

-- Delete claims that expired more than five minutes ago. Returns how many were removed.
CREATE FUNCTION records.prune_delegated_token_uses()
  RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, records
  AS $$
    WITH gone AS (
      DELETE FROM records.delegated_token_uses WHERE expires_at < now() - interval '5 minutes' RETURNING 1
    )
    SELECT count(*)::integer FROM gone
  $$;

REVOKE ALL ON FUNCTION records.claim_delegated_token(text, timestamptz), records.prune_delegated_token_uses() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION records.claim_delegated_token(text, timestamptz) TO records_app;
GRANT EXECUTE ON FUNCTION records.prune_delegated_token_uses() TO records_publisher;

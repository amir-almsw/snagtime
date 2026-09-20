-- tempocove_rate_limit() is an allowlist: it returns false unless the exact (limit, window_ms) pair
-- is registered here, so an unregistered policy is not "unlimited", it is "always rejected". The
-- client gate arrived in Phase 02, after this table was written, and asked for two pairs that were
-- never added -- so /api/gate answered 429 to every visitor on the first attempt, permanently.
-- The baseline now carries these rows; this migration is for databases already deployed without them.
INSERT INTO tempocove_rate_policy (limit_value, window_ms)
VALUES (5, 300000), (200, 3600000)
ON CONFLICT (limit_value, window_ms) DO NOTHING;

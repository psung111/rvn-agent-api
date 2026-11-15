-- 0005_api_key_scopes: per-key scopes for the v0.31.0 auth slice.
--
-- `scopes` is a TEXT[] of 'read' / 'write'. NULL means full access
-- (['read', 'write']) — that is how keys issued before v0.31.0 read
-- back, so existing keys keep working unchanged. The CHECK keeps garbage
-- out of the column; the server still parses stored values leniently
-- (see scopesOf in src/auth/keys.ts), so a bad row can never take the
-- auth gate down.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scopes TEXT[];

ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_valid
  CHECK (scopes IS NULL OR scopes <@ ARRAY['read', 'write']::text[]);

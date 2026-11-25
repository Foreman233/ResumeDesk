-- The initial short timeout frequently expired before DeepSeek returned its structured profile.
-- Upgrade it once while keeping the configured endpoint, model and protected credentials.
UPDATE app_settings
SET value = json_set(value, '$.timeoutSeconds', 120)
WHERE key = 'ai'
  AND json_valid(value)
  AND json_type(value, '$.timeoutSeconds') = 'integer'
  AND json_extract(value, '$.timeoutSeconds') BETWEEN 5 AND 119
  AND lower(rtrim(trim(json_extract(value, '$.baseUrl')), '/')) IN (
    'https://api.deepseek.com',
    'https://api.deepseek.com/v1',
    'https://api.deepseek.com/chat/completions',
    'https://api.deepseek.com/v1/chat/completions'
  );

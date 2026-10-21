-- Atomic token bucket. One key per (scope, subject), e.g. "rl:{tenant:42}:api".
-- KEYS[1]  bucket key
-- ARGV[1]  capacity (max burst)
-- ARGV[2]  refill rate, tokens per second
-- ARGV[3]  cost of this request (usually 1)
-- Returns { allowed (0|1), remaining (floor), retry_after_ms }
-- Uses Redis server time so app servers with skewed clocks agree.
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end

tokens = math.min(capacity, tokens + math.max(0, now - ts) * rate / 1000)

local allowed = 0
local retry_after = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry_after = math.ceil((cost - tokens) * 1000 / rate)
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
-- Expire once the bucket would be full again: idle keys clean themselves up.
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity * 1000 / rate) + 1000)

return { allowed, math.floor(tokens), retry_after }

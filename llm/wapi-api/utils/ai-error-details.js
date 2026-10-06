export function safeAiError(error, secrets = []) {
  let message = String(error?.message || error || 'AI provider request failed');
  for (const secret of secrets.filter(Boolean)) message = message.split(String(secret)).join('[REDACTED]');
  message = message.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, '[REDACTED]')
    .replace(/([?&](?:key|api_key|token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ').slice(0, 400);
  const status = Number(error?.statusCode || error?.status || error?.response?.status) || null;
  const code = /insufficient.*balance|credit|quota.*exceed/i.test(message) || status === 402 ? 'AI_BALANCE_UNAVAILABLE'
    : status === 401 || status === 403 ? 'AI_AUTHENTICATION_FAILED'
    : status === 429 ? 'AI_RATE_LIMITED'
    : /timeout|timed out|abort/i.test(message) ? 'AI_TIMEOUT'
    : /Unsupported.*version|specification version/i.test(message) ? 'AI_SDK_INCOMPATIBLE'
    : 'AI_PROVIDER_FAILED';
  return { error: message, code, httpStatus: status, retryable: code === 'AI_TIMEOUT' || status === 429 || status >= 500 };
}

import { AiPromptLog } from '../models/index.js';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createXai } from '@ai-sdk/xai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createCohere } from '@ai-sdk/cohere';
import { createMistral } from '@ai-sdk/mistral';
import { createGroq } from '@ai-sdk/groq';
import { createTogetherAI } from '@ai-sdk/togetherai';
import { createFireworks } from '@ai-sdk/fireworks';
import { safeAiError } from '../utils/ai-error-details.js';

const PROVIDER_DEFAULTS = {
  deepseek: process.env.DEEPSEEK_API_BASE_URL || 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
  google: process.env.GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
  xai: 'https://api.x.ai/v1',
  anthropic: 'https://api.anthropic.com/v1',
  cohere: 'https://api.cohere.com/v2',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  together: 'https://api.together.xyz/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1'
};

const normalizeProvider = (provider) => {
  const value = String(provider || '').trim().toLowerCase();
  if (value === 'gemini') return 'google';
  if (value === 'grok' || value === 'x-ai') return 'xai';
  return value;
};

const normalizeBaseUrl = (provider, value) => {
  const fallback = PROVIDER_DEFAULTS[provider];
  const raw = String(value || fallback || '').trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname
      .replace(/\/chat\/completions\/?$/i, '')
      .replace(/\/generateContent\/?$/i, '')
      .replace(/\/models\/[^/]+\/?$/i, '')
      .replace(/\/$/, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    return raw
      .replace(/\/chat\/completions\/?$/i, '')
      .replace(/\/generateContent\/?$/i, '')
      .replace(/\/$/, '');
  }
};

class OmnicallService {
  constructor() {
    this.defaultModel = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  }

  /**
   * Safe JSON parser that handles markdown code blocks and conversational fluff
   */
  parseJsonSafely(text) {
    if (!text || typeof text !== 'string') return null;
    const clean = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/m, '')
      .trim();

    try {
      return JSON.parse(clean);
    } catch (e) {
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch (e2) {
          // Attempt trailing comma / control chars fix
          try {
            const sanitized = match[0].replace(/,[\s]*([}\]])/g, '$1');
            return JSON.parse(sanitized);
          } catch (e3) {
            return null;
          }
        }
      }
      return null;
    }
  }

  createModel({ provider, model, apiKey, baseUrl, fetch: providerFetch }) {
    const normalizedProvider = normalizeProvider(provider);
    const resolvedBaseUrl = normalizeBaseUrl(normalizedProvider, baseUrl);
    const commonOptions = {
      apiKey,
      ...(providerFetch ? { fetch: providerFetch } : {}),
      ...(resolvedBaseUrl ? { baseURL: resolvedBaseUrl } : {})
    };

    switch (normalizedProvider) {
      case 'openai':
        return createOpenAI(commonOptions).chat(model);
      case 'google':
        return createGoogleGenerativeAI(commonOptions).chat(model);
      case 'xai':
        return createXai(commonOptions).chat(model);
      case 'deepseek':
        return createDeepSeek(commonOptions).chat(model);
      case 'anthropic':
        return createAnthropic(commonOptions).chat(model);
      case 'cohere':
        return createCohere(commonOptions).languageModel(model);
      case 'mistral':
        return createMistral(commonOptions).chat(model);
      case 'groq':
        return createGroq(commonOptions).chat(model);
      case 'together':
        return createTogetherAI(commonOptions).chatModel(model);
      case 'fireworks':
        return createFireworks(commonOptions).chatModel(model);
      default:
        return createOpenAICompatible({
          name: normalizedProvider || 'custom',
          baseURL: resolvedBaseUrl || '',
          apiKey
        }).chatModel(model);
    }
  }

  /**
   * Call a hosted provider through the Vercel AI SDK.
   * No model is installed locally; the provider API receives the tenant key.
   */
  async callProvider({ provider, model, apiKey, baseUrl, messages, temperature, maxTokens, jsonMode, userId, workspaceId, abortSignal }) {
    if (!apiKey) throw new Error(`Missing API key for provider: ${provider}`);
    const normalizedProvider = normalizeProvider(provider);
    console.log('[AI SDK] Generated Request Body:', JSON.stringify({
      provider: normalizedProvider,
      model,
      user_id: userId ? String(userId) : null,
      workspace_id: workspaceId ? String(workspaceId) : null,
      message_count: messages.length,
      characters: messages.reduce((sum, message) => sum + String(message.content || '').length, 0),
      temperature,
      max_output_tokens: maxTokens,
      json_mode: Boolean(jsonMode)
    }, null, 2));

    const requestStartedAt = Date.now();
    let httpStatus = null;
    const result = await generateText({
      model: this.createModel({
        provider: normalizedProvider,
        model,
        apiKey,
        baseUrl,
        fetch: async (url, options) => {
          // OJO: NO inyectar response_format aqui. Probado el 2026-10-06: con el prompt largo del router
          // DeepSeek devolvio respuestas VACIAS en 6 de 10 llamadas y el turno caia al respaldo.
          // El contrato se valida (y se reintenta una vez) en el router.
          const response = await fetch(url, options);
          httpStatus = response.status;
          console.log('[AI SDK HTTP]', { provider: normalizedProvider, model, user_id: userId ? String(userId) : null, workspace_id: workspaceId ? String(workspaceId) : null, status: httpStatus, elapsedMs: Date.now()-requestStartedAt });
          return response;
        }
      }),
      messages,
      temperature,
      maxOutputTokens: maxTokens,
      abortSignal: abortSignal || AbortSignal.timeout(50000),
      maxRetries: 0
    });

    console.log('[AI SDK] Response:', {
      provider: normalizedProvider,
      model,
      user_id: userId ? String(userId) : null,
      workspace_id: workspaceId ? String(workspaceId) : null,
      elapsedMs: Date.now() - requestStartedAt,
      httpStatus,
      finishReason: result.finishReason || null
    });

    const text = String(result.text || '').trim();
    if (!text) throw new Error(`${normalizedProvider} returned an empty response`);
    const usage = result.usage || {};
    const promptTokens = Number(usage.inputTokens ?? usage.promptTokens ?? 0);
    const completionTokens = Number(usage.outputTokens ?? usage.completionTokens ?? 0);
    const totalTokens = Number(usage.totalTokens ?? (promptTokens + completionTokens));

    if (userId && AiPromptLog?.create) {
      await AiPromptLog.create({
        user_id: userId,
        feature: `ai_sdk_${normalizedProvider}`,
        workspace_id: workspaceId || null,
        provider: normalizedProvider,
        model,
        status: 'success',
        http_status: httpStatus,
        elapsed_ms: Date.now() - requestStartedAt,
        finish_reason: result.finishReason || null,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens
      }).catch(() => {});
    }

    return { text, usage: { promptTokens, completionTokens, totalTokens }, raw: result };
  }

  /**
   * Execute chat completion across resilient fallback providers
   */
  async chatCompletion({
    messages = [],
    systemPrompt = '',
    prompt = '',
    temperature = 0.2,
    maxTokens = 2048,
    jsonMode = false,
    customApiKey = null,
    preferredProvider = null,
    preferredModel = null,
    preferredBaseUrl = null,
    userId = null,
    workspaceId = null,
    fallbackChain = null,
    abortSignal = null
  } = {}) {
    // Preserve the structured conversation for the provider call.
    const apiMessages = [];
    if (systemPrompt) apiMessages.push({ role: 'system', content: systemPrompt });
    if (Array.isArray(messages)) {
      for (const message of messages) {
        if (!message || !['system', 'user', 'assistant'].includes(message.role)) continue;
        if (message.content === undefined || message.content === null) continue;
        apiMessages.push({ role: message.role, content: String(message.content) });
      }
    }
    if (prompt) apiMessages.push({ role: 'user', content: String(prompt) });
    if (apiMessages.length === 0) apiMessages.push({ role: 'user', content: '' });

    // Each tenant calls only the provider and key that tenant configured.
    // Platform keys in the environment are not part of this queue.
    let queue = [];
    if (Array.isArray(fallbackChain) && fallbackChain.length > 0) {
      queue = fallbackChain.filter((target) => target && target.apiKey && !String(target.apiKey).startsWith('enc:'));
    } else if (customApiKey && !String(customApiKey).startsWith('enc:')) {
      queue = [{
        provider: preferredProvider || 'deepseek',
        model: preferredModel || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        apiKey: customApiKey,
        baseUrl: preferredBaseUrl
      }];
    }

    const errors = [];
    if (!queue.length) {
      errors.push({ provider: preferredProvider, model: preferredModel,
        code: String(customApiKey || '').startsWith('enc:') ? 'AI_KEY_ENCRYPTED' : 'AI_KEY_MISSING',
        error: 'Tenant API key is missing or has not been decrypted', httpStatus: null, retryable: false });
    }
    for (const target of queue) {
      const { provider, model, apiKey } = target;
      const keyToUse = apiKey;
      if (!keyToUse || String(keyToUse).startsWith('enc:')) {
        errors.push({ provider, model, error: 'Missing tenant API key' });
        continue;
      }

      const startedAt = Date.now();
      try {
        const result = await this.callProvider({
          provider,
          model,
          apiKey: keyToUse,
          messages: apiMessages,
          temperature,
          maxTokens,
          jsonMode,
          baseUrl: target.baseUrl,
          userId,
          workspaceId,
          abortSignal
        });

        if (result.text) {
          let parsedJson = null;
          if (jsonMode) {
            parsedJson = this.parseJsonSafely(result.text);
          }

          return {
            success: true,
            provider: normalizeProvider(provider),
            model,
            text: result.text.trim(),
            json: parsedJson,
            usage: result.usage,
            errors
          };
        } else {
          errors.push({ provider, model, error: result.errors?.map(e => e.error).join('; ') || 'No output returned' });
        }
      } catch (callErr) {
        const details = safeAiError(callErr, [keyToUse]);
        errors.push({ provider, model, ...details });
        console.error('[AI Provider Failure]', JSON.stringify({
          at: new Date().toISOString(), user_id: userId ? String(userId) : null,
          workspace_id: workspaceId ? String(workspaceId) : null,
          provider, model, elapsedMs: Date.now() - startedAt, ...details
        }));
      }
    }

    return {
      success: false,
      text: '',
      json: null,
      errors
    };
  }
}

export const omnicallService = new OmnicallService();
export default omnicallService;

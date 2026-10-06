import omnicallService from '../services/omnicall.service.js';

const getNestedValue = (obj, path) => {
  return path.split('.').reduce((current, key) => current?.[key], obj);
};


const formatRequestBody = (model, prompt) => {
  const { provider, model_id, config } = model;
  const safeConfig = config || {};
  const safeConfigForLog = { ...safeConfig };
  delete safeConfigForLog.api_key;
  console.log('[AI] model configuration:', {
    provider,
    model_id,
    config: safeConfigForLog
  });
  switch (provider) {
    case 'anthropic':
      return {
        model: model_id,
        max_tokens: safeConfig.max_tokens || 1024,
        messages: [{ role: 'user', content: prompt }]
      };

    case 'google':
      return {
        contents: [
          {
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: safeConfig.temperature ?? 0.7,
          maxOutputTokens: safeConfig.max_tokens ?? 1024,
          topP: safeConfig.top_p ?? 0.95
        }
      };

    case 'openai':
    default:
      return {
        model: model_id,
        messages: [{ role: 'user', content: prompt }],
        temperature: safeConfig.temperature ?? 0.7,
        max_tokens: safeConfig.max_tokens || 1024,
        top_p: safeConfig.top_p ?? 1,
        frequency_penalty: safeConfig.frequency_penalty ?? 0,
        presence_penalty: safeConfig.presence_penalty ?? 0
      };
  }
};


const formatRequestHeaders = (model, apiKey) => {
  const { provider, api_version, headers_template } = model;
  const headers = {
    'Content-Type': 'application/json'
  };

  if (headers_template && Object.keys(headers_template).length > 0) {
    Object.entries(headers_template).forEach(([key, value]) => {
      if (typeof key !== 'string' || key.startsWith('$')) {
        return;
      }

      let headerValue = value;
      if (typeof headerValue === 'string') {
        headerValue = headerValue.replace('{{API_KEY}}', apiKey);
      }

      if (typeof headerValue === 'string' && headerValue.trim() !== '') {
        headers[key] = headerValue;
      }
    });

    if (headers['Authorization'] || headers['x-api-key'] || headers['x-goog-api-key']) {
      return headers;
    }
  }

  switch (provider) {
    case 'anthropic':
      if (!headers['x-api-key'] && typeof apiKey === 'string') {
        headers['x-api-key'] = apiKey;
      }
      if (typeof api_version === 'string') {
        headers['anthropic-version'] = api_version || '2023-06-01';
      }
      break;

    case 'google':
      if (headers_template && headers_template['x-goog-api-key'] && typeof apiKey === 'string') {
        headers['x-goog-api-key'] = apiKey;
      }
      break;

    case 'openai':
    case 'groq':
    case 'mistral':
    default:
      if (!headers['Authorization'] && typeof apiKey === 'string') {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
      break;
  }

  return headers;
};


const buildApiEndpoint = (model, apiKey) => {
  let { api_endpoint, provider, model_id } = model;

  if (provider === 'google') {
    let url = api_endpoint || 'https://generativelanguage.googleapis.com/v1/models';

    if (url.includes('v1beta') && (model_id.includes('gemini-1.5') || model_id.includes('gemini-2.'))) {
      url = url.replace('v1beta', 'v1');
    }

    if (url.endsWith('/models') || url.endsWith('/v1') || url.endsWith('/v1beta')) {
      const baseUrl = url.endsWith('/models') ? url : `${url.replace(/\/$/, '')}/models`;
      url = `${baseUrl}/${model_id}:generateContent`;
    } else if (!url.includes(':generateContent')) {
      if (url.endsWith(model_id)) {
        url = `${url}:generateContent`;
      } else if (!url.includes('/models/')) {
        url = `${url.replace(/\/$/, '')}/models/${model_id}:generateContent`;
      }
    }

    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}key=${apiKey}`;
  }

  return api_endpoint;
};


const callAIModel = async (userId, model, apiKey, prompt, options = {}) => {
  // Customer traffic uses only the chatbot key or the workspace owner's key.
  // The platform DEEPSEEK_API_KEY is never a fallback.
  if (!apiKey || !String(apiKey).trim() || String(apiKey).startsWith('enc:')) {
    throw new Error('AI API key is not configured for this tenant/chatbot');
  }
  const config = model?.config || {};
  const result = await omnicallService.chatCompletion({
    userId,
    messages: [{ role: 'user', content: String(prompt || '') }],
    customApiKey: apiKey,
    preferredProvider: model?.provider || 'deepseek',
    preferredModel: model?.model_id || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    preferredBaseUrl: model?.api_endpoint || null,
    temperature: options.temperature ?? config.temperature ?? 0.7,
    maxTokens: options.maxTokens ?? config.max_tokens ?? 1024,
    jsonMode: Boolean(options.jsonMode),
    abortSignal: options.abortSignal,
    // Keep this helper call scoped to the selected tenant/model. The caller
    // can explicitly opt into global fallback before arriving here.
    fallbackChain: [{
      provider: model?.provider || 'deepseek',
      model: model?.model_id || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      apiKey,
      baseUrl: model?.api_endpoint || null
    }]
  });

  if (!result.success) {
    const details = (result.errors || [])
      .map(error => `${error.provider || 'provider'}: ${error.error}`)
      .join('; ');
    throw new Error(details || 'AI provider returned no response');
  }

  return result.text;
};


const testAIModel = async (model, prompt, apiKey) => {

  if (!apiKey) {
    throw new Error('API key not found in model configuration');
  }

  return await callAIModel(null, model, apiKey, prompt);
};

export {
  getNestedValue,
  formatRequestBody,
  formatRequestHeaders,
  buildApiEndpoint,
  callAIModel,
  testAIModel
};

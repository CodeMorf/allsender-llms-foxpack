import omnicallService from './omnicall.service.js';

class DeepSeekService {
  constructor() {
    this.baseUrl = process.env.DEEPSEEK_API_BASE_URL || 'https://api.deepseek.com';
    this.defaultModel = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  }

  get apiKey() {
    return process.env.DEEPSEEK_API_KEY || '';
  }

  set apiKey(val) {
    process.env.DEEPSEEK_API_KEY = val;
  }

  /**
   * Reusable chat completion across all modules of the SaaS.
   */
  async chatCompletion({
    messages = [],
    model = this.defaultModel,
    temperature = 0.7,
    maxTokens = 3500,
    jsonMode = false
  }) {
    if (!this.apiKey) {
      throw new Error('DEEPSEEK_API_KEY is not configured');
    }

    try {
      const result = await omnicallService.chatCompletion({
        messages,
        temperature,
        maxTokens,
        jsonMode,
        customApiKey: this.apiKey,
        preferredProvider: 'deepseek',
        preferredModel: model,
        preferredBaseUrl: this.baseUrl,
        fallbackChain: [{
          provider: 'deepseek',
          model,
          apiKey: this.apiKey,
          baseUrl: this.baseUrl
        }]
      });

      if (!result.success) {
        const details = (result.errors || [])
          .map(error => error.error)
          .filter(Boolean)
          .join('; ');
        throw new Error(details || 'DeepSeek returned no response');
      }

      const content = String(result.text || '').trim();

      if (jsonMode) {
        const parsed = result.json || omnicallService.parseJsonSafely(content);
        if (!parsed) {
          throw new Error('DeepSeek returned invalid JSON');
        }
        return parsed;
      }

      return content;
    } catch (error) {
      const errorMsg = error.response?.data?.error?.message || error.response?.data || error.message;
      console.error('[DeepSeek API Error]:', errorMsg);
      throw new Error(`DeepSeek AI Error: ${errorMsg}`);
    }
  }

  /**
   * Generates or improves department structure in any requested language.
   * Auto-fills: name, description, welcome greeting, menu options, context questions (Name + Context),
   * transfer message, and away message.
   */
  async generateDepartmentSuggestions({
    name = '',
    description = '',
    industry = '',
    prompt = '',
    language = 'es',
    currentOptions = [],
    workspaceId = null
  }) {
    const langNames = {
      es: 'Español (Spanish)',
      en: 'English',
      pt: 'Português (Portuguese)',
      fr: 'Français (French)',
      it: 'Italiano (Italian)',
      de: 'Deutsch (German)'
    };
    const targetLang = langNames[language] || language || 'Español (Spanish)';

    const systemPrompt = `Eres un consultor experto en diseño de flujos omnicanal, chatbots de WhatsApp y enrutamiento departamental para la plataforma SaaS empresarial AllSender.
Tu misión es estructurar y autocompletar departamentos de atención al cliente de forma profesional, clara, persuasiva y amigable.

IMPORTANTE - IDIOMA DE SALIDA:
Debes responder TODO el contenido textual (títulos, descripciones, mensajes, preguntas) estrictamente en: ${targetLang}.

Siempre responde en formato JSON válido con la siguiente estructura exacta:
{
  "suggested_name": "Nombre claro y formal del departamento",
  "suggested_description": "Descripción concisa de la misión de este departamento",
  "welcome_greeting": "Mensaje cálido de bienvenida para el cliente (ej: ¡Hola! Gracias por comunicarte con nuestro departamento de...)",
  "transfer_message": "Mensaje cordial avisando que se transferirá a un agente (ej: ¡Bien! Te vamos a transferir con un agente para que te atienda.)",
  "away_message": "Mensaje profesional para cuando el cliente escriba fuera del horario laboral (ej: En este momento estamos fuera de horario. Nuestro horario es de Lunes a Viernes de 9:00 a 18:00...)",
  "farewell_message": "Mensaje de despedida y agradecimiento al resolver el caso",
  "options": [
    {
      "order": 1,
      "title": "Título corto de la opción (máximo 4 palabras)",
      "description": "Descripción breve de lo que resuelve esta opción",
      "suggested_area": "Nombre del área sugerida",
      "action": "case_and_assign",
      "notify": true,
      "questions": [
        {
          "order": 1,
          "text": "Pregunta de Nombre en ${targetLang} (ej: ¿Cuál es tu nombre completo?)",
          "type": "text",
          "variable": "nombre",
          "required": true
        },
        {
          "order": 2,
          "text": "Pregunta de Contexto / Motivo en ${targetLang} (ej: ¿Cuál es el motivo de tu consulta o en qué te podemos ayudar?)",
          "type": "text",
          "variable": "contexto",
          "required": true
        }
      ]
    }
  ]
}

Reglas estrictas:
1. IDIOMA: Todo el texto generado DEBE estar en ${targetLang}.
2. SECUENCIA DE PREGUNTAS: En cada opción del array "options", la Pregunta 1 DEBE pedir el Nombre del cliente (variable: 'nombre') y la Pregunta 2 DEBE pedir el Contexto o Motivo de la consulta (variable: 'contexto').
3. Genera entre 2 y 4 opciones bien diferenciadas acordes a la industria / descripción.
4. 'action' en cada opción debe ser 'case_and_assign'.
5. Devuelve ÚNICAMENTE el JSON sin explicaciones adicionales.`;

    const userPrompt = `Datos proporcionados por el usuario:
- Idioma solicitado: "${targetLang}"
- Nombre o idea: "${name || 'Sin especificar'}"
- Descripción / Contexto: "${description || 'Sin especificar'}"
- Rubro / Industria: "${industry || 'General'}"
- Instrucciones especiales: "${prompt || 'Genera una estructura completa y profesional con opciones de enrutamiento y preguntas de contexto claras'}"
${currentOptions.length > 0 ? `- Opciones actuales que ya tiene: ${JSON.stringify(currentOptions.map(o => ({ title: o.title, description: o.description })))}` : ''}

Por favor genera la configuración completa y optimizada en JSON en el idioma ${targetLang}:`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    if (!workspaceId) {
      return await this.chatCompletion({ messages, temperature: 0.7, maxTokens: 3500, jsonMode: true });
    }
    const platformAi = (await import('./platform-ai-router.service.js')).default;
    const assisted = await platformAi.completeJson({
      workspaceId,
      kind: 'department_suggest',
      messages,
      temperature: 0.7,
      maxTokens: 3500
    });
    return assisted.result;
  }

  /**
   * Refines a specific text (title, description, greeting, or question)
   */
  async refineText({ text, type = 'text', context = '', language = 'es', workspaceId = null }) {
    const systemPrompt = `Eres un redactor y especialista en copywriting para atención al cliente por WhatsApp y mensajería en SaaS.
Tu tarea es perfeccionar el texto proporcionado para que sea impecable, persuasivo, profesional y claro en el idioma especificado (${language}).
Devuelve ÚNICAMENTE un JSON con:
{
  "refined_text": "Texto mejorado aquí",
  "explanation": "Breve explicación de la mejora realizada"
}`;

    const userPrompt = `Tipo de texto: ${type}
Idioma: ${language}
Contexto: ${context || 'Atención comercial y soporte al cliente'}
Texto original a mejorar:
"${text}"`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    if (!workspaceId) {
      return await this.chatCompletion({ messages, temperature: 0.6, maxTokens: 600, jsonMode: true });
    }
    const platformAi = (await import('./platform-ai-router.service.js')).default;
    const assisted = await platformAi.completeJson({
      workspaceId,
      kind: 'refine_text',
      messages,
      temperature: 0.6,
      maxTokens: 600
    });
    return assisted.result;
  }
}

export default new DeepSeekService();

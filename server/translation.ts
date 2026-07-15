import type { Express, Request, Response } from 'express';

interface TranslationRouteOptions {
  apiUrl?: string;
  apiKey?: string;
  model: string;
}

interface TranslationRequestBody {
  text?: unknown;
  targetLanguage?: unknown;
  sourceLanguage?: unknown;
}

interface ChatCompletionPayload {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
}

const unavailableResponse = (response: Response): void => {
  response.status(503).json({
    code: 'AI_TRANSLATION_UNAVAILABLE',
    message: 'Remote translation is not configured. OneLive will use its preset demo translations.',
    fallback: 'demo-safe-mode',
  });
};

export const installTranslationRoute = (
  app: Express,
  options: TranslationRouteOptions,
): void => {
  app.post(
    '/api/translate',
    async (request: Request<unknown, unknown, TranslationRequestBody>, response: Response) => {
      if (!options.apiUrl || !options.apiKey) {
        unavailableResponse(response);
        return;
      }

      const text = typeof request.body?.text === 'string' ? request.body.text.trim() : '';
      const targetLanguage =
        typeof request.body?.targetLanguage === 'string'
          ? request.body.targetLanguage.trim()
          : '';
      const sourceLanguage =
        typeof request.body?.sourceLanguage === 'string'
          ? request.body.sourceLanguage.trim()
          : 'Chinese';

      if (!text || text.length > 4_000 || !targetLanguage || targetLanguage.length > 80) {
        response.status(400).json({
          code: 'INVALID_TRANSLATION_REQUEST',
          message: 'A short source text and target language are required.',
        });
        return;
      }

      const endpoint = options.apiUrl.endsWith('/chat/completions')
        ? options.apiUrl
        : `${options.apiUrl.replace(/\/$/, '')}/chat/completions`;

      try {
        const upstream = await fetch(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: options.model,
            temperature: 0.1,
            messages: [
              {
                role: 'system',
                content:
                  'You are a live-commerce translator. Return only the translated sentence; preserve product facts and do not add claims.',
              },
              {
                role: 'user',
                content: `Translate from ${sourceLanguage} to ${targetLanguage}:\n${text}`,
              },
            ],
          }),
          signal: AbortSignal.timeout(8_000),
        });

        if (!upstream.ok) {
          response.status(502).json({
            code: 'AI_TRANSLATION_FAILED',
            message: 'The translation provider did not complete the request. Use the preset translation.',
            fallback: 'demo-safe-mode',
          });
          return;
        }

        const payload = (await upstream.json()) as ChatCompletionPayload;
        const translation = payload.choices?.[0]?.message?.content;
        if (typeof translation !== 'string' || !translation.trim()) {
          response.status(502).json({
            code: 'AI_TRANSLATION_INVALID_RESPONSE',
            message: 'The translation provider returned no usable text. Use the preset translation.',
            fallback: 'demo-safe-mode',
          });
          return;
        }

        response.json({
          translation: translation.trim(),
          model: options.model,
          provenance: 'LIVE',
        });
      } catch {
        response.status(504).json({
          code: 'AI_TRANSLATION_TIMEOUT',
          message: 'Translation timed out. OneLive will continue with its preset translation.',
          fallback: 'demo-safe-mode',
        });
      }
    },
  );
};


// controllers/assistant.controller.ts
//
//   POST /ai/chat { mode, messages, context, capabilities }
//     → { reply, calls, problems, model }
//
// One assistant turn. `context` is the editor's project summary (the model
// sees clips by short ids c1, c2…); `capabilities` lists what the editor has
// (animation/transition ids, fonts…) so tools only offer real options. The
// model's tool calls are checked here; invalid ones go back to it once to be
// fixed, then (still failing) once to the stronger model. Only valid calls
// are returned: the editor shows them as a changeset to review. Metered per
// message (aiMessages), refunded if the model can't be reached.

import { Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthRequest } from '../types';
import { User } from '../models/User';
import { getEffectiveQuota } from '../config/quotas';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import { releaseUsage, reserveUsage, settleUsage } from '../services/usage.service';
import { getGeminiClient, type GeminiMessage } from '../services/ai/gemini';
import { checkCalls, MAX_CALLS_PER_REPLY, toolDeclarations, type AssistantCapabilities, type CheckedCall } from '../services/ai/editorTools';
import { ASK_MODE_NOTE, ASSISTANT_SYSTEM } from '../services/ai/assistantPrompt';

interface ChatBody {
  mode: 'ask' | 'edit';
  messages: GeminiMessage[];
  context: string;
  capabilities?: AssistantCapabilities;
}

/** The last user message carries the current project summary */
function withContext(messages: GeminiMessage[], context: string): GeminiMessage[] {
  const out = messages.map((m) => ({ ...m }));
  const last = out[out.length - 1];
  last.text = `PROJECT SUMMARY\n${context}\n\nREQUEST\n${last.text}`;
  return out;
}

export const chat = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const jobId = uuidv4();
  let reserved = false;
  try {
    const { mode, messages, context, capabilities = {} } = req.body as ChatBody;
    const user = await User.findById(req.userId);
    if (!user) throw ApiError.notFound('User not found');
    await reserveUsage(user._id, 'aiMessages', jobId, 1, getEffectiveQuota(user).maxAiMessages);
    reserved = true;

    const gemini = getGeminiClient();
    const system = mode === 'ask' ? `${ASSISTANT_SYSTEM}\n\n${ASK_MODE_NOTE}` : ASSISTANT_SYSTEM;
    const tools = mode === 'edit' ? toolDeclarations(capabilities) : undefined;
    let conversation = withContext(messages, context);

    let model = env.aiModel;
    let result = await gemini.generate({ model, system, messages: conversation, tools });
    let checked = checkCalls(result.calls.slice(0, MAX_CALLS_PER_REPLY), capabilities);
    let usage = { ...result.usage };

    // Invalid calls: show the model what was wrong, once with the same model, then the strong one
    for (const retryModel of [env.aiModel, env.aiModelStrong]) {
      if (!checked.problems.length) break;
      logger.info('Assistant calls rejected; retrying', { problems: checked.problems, model: retryModel });
      conversation = [
        ...conversation,
        { role: 'model', text: result.text || '(proposed tool calls)' },
        {
          role: 'user',
          text: `Some of your tool calls were invalid:\n- ${checked.problems.join('\n- ')}\nPropose the whole edit again with valid calls only.`,
        },
      ];
      model = retryModel;
      result = await gemini.generate({ model, system, messages: conversation, tools });
      checked = checkCalls(result.calls.slice(0, MAX_CALLS_PER_REPLY), capabilities);
      usage = { input: usage.input + result.usage.input, output: usage.output + result.usage.output };
    }

    await settleUsage(user._id, 'aiMessages', jobId, 1);
    logger.info('Assistant turn', { userId: String(user._id), mode, model, calls: checked.valid.length, problems: checked.problems.length, tokens: usage });
    const calls: CheckedCall[] = mode === 'edit' ? checked.valid : [];
    res.json({
      reply:
        result.text ||
        (calls.length
          ? `Here ${calls.length === 1 ? 'is 1 change' : `are ${calls.length} changes`} for you to review.`
          : "I couldn't work out an edit for that. Can you say it another way?"),
      calls,
      problems: checked.problems,
      model,
    });
  } catch (error) {
    if (reserved) {
      await releaseUsage('aiMessages', jobId, 'assistant_failed').catch(() => undefined);
    }
    next(error);
  }
};

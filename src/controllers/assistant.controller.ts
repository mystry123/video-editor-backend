// controllers/assistant.controller.ts
//
//   POST   /ai/chat { mode, messages, context, capabilities, planStep? }
//     → { reply, calls, problems, model }
//   GET    /ai/memory            the user's saved preferences
//   POST   /ai/memory { note }   remember one
//   DELETE /ai/memory/:id        forget one
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
import { ASK_MODE_NOTE, ASSISTANT_SYSTEM, PLAN_STEP_NOTE } from '../services/ai/assistantPrompt';

interface ChatBody {
  mode: 'ask' | 'edit';
  messages: GeminiMessage[];
  context: string;
  capabilities?: AssistantCapabilities;
  /** Carrying out a step of an approved plan: edit, don't plan again */
  planStep?: boolean;
}

export const MAX_MEMORY_NOTES = 30;

/** When the model sends tool calls with no words: say what came */
function fallbackReply(calls: CheckedCall[]): string {
  const edits = calls.filter((c) => c.name !== 'propose_plan');
  if (calls.some((c) => c.name === 'propose_plan')) return edits.length ? 'Here is a plan, plus some changes, for you to review.' : 'Here is a plan for you to review.';
  if (edits.length) return `Here ${edits.length === 1 ? 'is 1 change' : `are ${edits.length} changes`} for you to review.`;
  return "I couldn't work out an edit for that. Can you say it another way?";
}

/** The user's saved preferences, for the model's instructions */
function memoryBlock(user: any): string {
  const notes = (user.assistantMemory || []).map((m: any) => m.note).filter(Boolean);
  return notes.length ? `\n\nTHE USER'S SAVED PREFERENCES (follow them unless this request says otherwise):\n- ${notes.join('\n- ')}` : '';
}

const memoryView = (user: any) => (user.assistantMemory || []).map((m: any) => ({ id: m.id, note: m.note, createdAt: m.createdAt }));

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
    const { mode, messages, context, capabilities = {}, planStep = false } = req.body as ChatBody;
    const user = await User.findById(req.userId);
    if (!user) throw ApiError.notFound('User not found');
    await reserveUsage(user._id, 'aiMessages', jobId, 1, getEffectiveQuota(user).maxAiMessages);
    reserved = true;

    const gemini = getGeminiClient();
    const base = mode === 'ask' ? `${ASSISTANT_SYSTEM}\n\n${ASK_MODE_NOTE}` : ASSISTANT_SYSTEM;
    const system = `${base}${planStep ? `\n\n${PLAN_STEP_NOTE}` : ''}${memoryBlock(user)}`;
    const exclude = planStep ? ['propose_plan'] : [];
    const tools = mode === 'edit' ? toolDeclarations(capabilities, exclude) : undefined;
    let conversation = withContext(messages, context);

    let model = env.aiModel;
    let result = await gemini.generate({ model, system, messages: conversation, tools });
    let checked = checkCalls(result.calls.slice(0, MAX_CALLS_PER_REPLY), capabilities, exclude);
    let usage = { ...result.usage };

    // An edit request answered in words (e.g. a plan described instead of
    // proposed): ask once more for tool calls; a real answer stays an answer
    if (mode === 'edit' && !result.calls.length && result.text) {
      const nudged = await gemini.generate({
        model,
        system,
        tools,
        messages: [
          ...conversation,
          { role: 'model', text: result.text },
          {
            role: 'user',
            text: 'If that was meant to change the project, make it with tool calls now (edits, or propose_plan for a multi-step plan). If it was only an answer to a question, reply with the same answer and no tool calls.',
          },
        ],
      });
      usage = { input: usage.input + nudged.usage.input, output: usage.output + nudged.usage.output };
      if (nudged.calls.length) {
        result = { ...nudged, text: nudged.text || result.text };
        checked = checkCalls(result.calls.slice(0, MAX_CALLS_PER_REPLY), capabilities, exclude);
      }
    }

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
      checked = checkCalls(result.calls.slice(0, MAX_CALLS_PER_REPLY), capabilities, exclude);
      usage = { input: usage.input + result.usage.input, output: usage.output + result.usage.output };
    }

    await settleUsage(user._id, 'aiMessages', jobId, 1);
    logger.info('Assistant turn', { userId: String(user._id), mode, model, calls: checked.valid.length, problems: checked.problems.length, tokens: usage });
    const calls: CheckedCall[] = mode === 'edit' ? checked.valid : [];
    res.json({
      reply: result.text || fallbackReply(calls),
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

export const getMemory = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = await User.findById(req.userId).select('assistantMemory').lean();
    if (!user) throw ApiError.notFound('User not found');
    res.json({ memory: memoryView(user) });
  } catch (error) {
    next(error);
  }
};

export const addMemory = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const note = String((req.body as { note: string }).note).replace(/\s+/g, ' ').trim();
    const user = await User.findById(req.userId);
    if (!user) throw ApiError.notFound('User not found');
    const list = user.assistantMemory || [];
    if (!list.some((m) => m.note.toLowerCase() === note.toLowerCase())) {
      if (list.length >= MAX_MEMORY_NOTES) {
        throw ApiError.withCode(400, 'MEMORY_FULL', `The assistant can remember up to ${MAX_MEMORY_NOTES} things. Delete one first.`);
      }
      user.assistantMemory = [...list, { id: uuidv4(), note, createdAt: new Date() }];
      await user.save();
    }
    res.status(201).json({ memory: memoryView(user) });
  } catch (error) {
    next(error);
  }
};

export const deleteMemory = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    await User.updateOne({ _id: req.userId }, { $pull: { assistantMemory: { id: req.params.id } } });
    const user = await User.findById(req.userId).select('assistantMemory').lean();
    res.json({ memory: memoryView(user) });
  } catch (error) {
    next(error);
  }
};

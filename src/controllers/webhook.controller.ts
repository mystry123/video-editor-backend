// controllers/webhook.controller.ts

import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { Webhook } from '../models/Webhook';
import { WebhookLog } from '../models/WebhookLog';
import { User } from '../models/User';
import { deliverWebhook, getWebhookSigningSecret } from '../services/webhook.service';
import { generateWebhookSecret } from '../utils/helpers';
import { ApiError } from '../utils/ApiError';

// GET /webhooks/signing-secret - verifies X-Webhook-Signature on deliveries to
// a render's webhookUrl: HMAC-SHA256 of the JSON body with this secret.
export const getSigningSecret = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json({ secret: await getWebhookSigningSecret(req.userId!), algorithm: 'HMAC-SHA256', header: 'X-Webhook-Signature' });
  } catch (error) {
    next(error);
  }
};

export const createWebhook = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.userId!;
    const { name, url, events } = req.body;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const webhook = await Webhook.create({
      userId: user._id,
      name,
      url,
      secret: generateWebhookSecret(),
      events,
    });

    res.status(201).json(webhook);
  } catch (error) {
    next(error);
  }
};

export const listWebhooks = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const webhooks = await Webhook.find({ userId: user._id });

    res.json({ data: webhooks });
  } catch (error) {
    next(error);
  }
};

export const getWebhook = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const webhook = await Webhook.findOne({ _id: id, userId: user._id });
    if (!webhook) throw ApiError.notFound('Webhook not found');

    res.json(webhook);
  } catch (error) {
    next(error);
  }
};

export const updateWebhook = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    // Whitelisted fields only. Passing req.body straight through let a request
    // set userId (redirecting another account's events to this endpoint),
    // the signing secret, counters, or update operators.
    const updates: Record<string, unknown> = {};
    for (const field of ['name', 'url', 'events', 'isActive'] as const) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const webhook = await Webhook.findOneAndUpdate(
      { _id: id, userId: user._id },
      { $set: updates },
      { new: true }
    );

    if (!webhook) throw ApiError.notFound('Webhook not found');

    res.json(webhook);
  } catch (error) {
    next(error);
  }
};

export const deleteWebhook = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    await Webhook.deleteOne({ _id: id, userId: user._id });
    await WebhookLog.deleteMany({ webhookId: id });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

export const testWebhook = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const webhook = await Webhook.findOne({ _id: id, userId: user._id });
    if (!webhook) throw ApiError.notFound('Webhook not found');

    const result = await deliverWebhook(webhook._id.toString(), {
      event: 'test',
      timestamp: new Date().toISOString(),
      data: { message: 'This is a test webhook' },
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
};

export const getWebhookLogs = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const { page = '1', limit = '20' } = req.query;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const webhook = await Webhook.findOne({ _id: id, userId: user._id });
    if (!webhook) throw ApiError.notFound('Webhook not found');

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);

    const [logs, total] = await Promise.all([
      WebhookLog.find({ webhookId: id })
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      WebhookLog.countDocuments({ webhookId: id }),
    ]);

    res.json({
      data: logs,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    next(error);
  }
};
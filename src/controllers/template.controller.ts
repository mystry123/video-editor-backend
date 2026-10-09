import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { Template } from '../models/Template';
import { TemplateVersion } from '../models/TemplateVersion';
import { RenderJob } from '../models/RenderJob';
import { User } from '../models/User';
import { getEffectiveQuota } from '../config/quotas';
import { ensureShareTokens, publicRender } from '../services/renderOutput.service';
import {
  KEEP_VERSIONS,
  keepSnapshot,
  listVersionSummaries,
  snapshotTemplate,
  type SnapshotReason,
} from '../services/templateVersion.service';
import { ApiError } from '../utils/ApiError';

/** Snapshots GET /templates/:id/versions returns without ?limit. */
const DEFAULT_VERSION_LIST = 20;

export const createTemplate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.userId!;
    const { name = 'New Template', description = 'New Template Description', data = { project: {}, elements: [] }, tags = [], isPublic = false } = req.body;


    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const quota = getEffectiveQuota(user);
    const templateCount = await Template.countDocuments({ userId: user._id });

    if (quota.maxTemplates !== -1 && templateCount >= quota.maxTemplates) {
      throw ApiError.forbidden('Template quota exceeded');
    }

    const template = await Template.create({
      userId: user._id,
      name,
      description,
      data,
      tags,
      isPublic,
    });

    res.status(201).json(template);
  } catch (error) {
    next(error);
  }
};

export const getTemplate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const template = await Template.findOne({
      _id: id,
      $or: [{ userId: user._id }, { isPublic: true }],
    });

    if (!template) {
      throw ApiError.notFound('Template not found');
    }

    res.json(template);
  } catch (error) {
    next(error);
  }
};

export const updateTemplate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    // Only these fields can be changed by the owner. Spreading req.body let a
    // request set userId (moving the template to another account), version or
    // usage counters, or inject update operators.
    const updates: Record<string, unknown> = {};
    for (const field of ['name', 'description', 'data', 'tags', 'isPublic', 'thumbnail'] as const) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const template = await Template.findOne({ _id: id, userId: user._id });
    if (!template) {
      throw ApiError.notFound('Template not found or unauthorized');
    }

    // Another tab (or device) saved since this editor loaded: don't silently
    // overwrite it unless the user chose to.
    const baseVersion = req.body.baseVersion;
    const overwrite = req.body.overwrite === true;
    if (typeof baseVersion === 'number' && !overwrite && baseVersion !== template.version) {
      throw ApiError.withCode(409, 'VERSION_CONFLICT', 'This project was changed in another tab or device.', {
        currentVersion: template.version,
        baseVersion,
      });
    }

    // Version history: the state before this save, per the snapshot policy.
    const reason: SnapshotReason = req.body.snapshot === 'leave' ? 'leave' : 'autosave';
    await snapshotTemplate(template, user._id, reason);

    // Conditional on the version we checked, so two saves can't interleave.
    const updatedTemplate = await Template.findOneAndUpdate(
      { _id: id, userId: user._id, ...(overwrite ? {} : { version: template.version }) },
      { ...updates, $inc: { version: 1 } },
      { new: true }
    );
    if (!updatedTemplate) {
      throw ApiError.withCode(409, 'VERSION_CONFLICT', 'This project was changed in another tab or device.', {
        currentVersion: (await Template.findById(id).select('version').lean())?.version,
        baseVersion,
      });
    }

    // Autosave only needs the new version, not the whole template echoed back.
    if (req.query.return === 'minimal') {
      res.json({ id: updatedTemplate._id, version: updatedTemplate.version, updatedAt: updatedTemplate.updatedAt });
      return;
    }
    res.json(updatedTemplate);
  } catch (error) {
    next(error);
  }
};

export const listTemplates = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.userId!;
    const {
      page = '1',
      limit = '20',
      search,
      tags,
      isPublic,
      sortBy = 'updatedAt',
      sortOrder = 'desc',
    } = req.query;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);

    const query: any = {
      $or: [{ userId: user._id }, ...(isPublic === 'true' ? [{ isPublic: true }] : [])],
    };

    if (search) {
      query.$text = { $search: search as string };
    }

    if (tags) {
      query.tags = { $in: (tags as string).split(',') };
    }

    const [templates, total] = await Promise.all([
      Template.find(query)
        .sort({ [sortBy as string]: sortOrder === 'desc' ? -1 : 1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      Template.countDocuments(query),
    ]);

    res.json({
      data: templates,
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

export const deleteTemplate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const result = await Template.deleteOne({ _id: id, userId: user._id });

    if (result.deletedCount === 0) {
      throw ApiError.notFound('Template not found or unauthorized');
    }

    await TemplateVersion.deleteMany({ templateId: id });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

export const bulkDeleteTemplates = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.userId!;
    const { ids } = req.body;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    // Delete only the caller's templates, and only those templates' versions
    // (ids of other users' templates in the list are ignored).
    const owned = await Template.find({ _id: { $in: ids }, userId: user._id }).select('_id').lean();
    const ownedIds = owned.map((t) => t._id);
    const result = await Template.deleteMany({ _id: { $in: ownedIds }, userId: user._id });
    await TemplateVersion.deleteMany({ templateId: { $in: ownedIds } });

    res.json({ success: true, deleted: result.deletedCount });
  } catch (error) {
    next(error);
  }
};

export const getTemplateVersions = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const template = await Template.findOne({ _id: id, userId: user._id });
    if (!template) {
      throw ApiError.notFound('Template not found');
    }

    // ?limit (default 20, at most KEEP_VERSIONS); ?summary=true leaves out
    // each snapshot's data (megabytes) and adds `summary` instead.
    const limit = Math.min(Math.max(Number(req.query.limit ?? DEFAULT_VERSION_LIST), 1), KEEP_VERSIONS);
    if (req.query.summary === 'true') {
      const versions = await listVersionSummaries(template._id, limit);
      res.json({ currentVersion: template.version, versions });
      return;
    }

    const versions = await TemplateVersion.find({ templateId: template._id })
      .sort({ version: -1 })
      .limit(limit)
      .lean();

    res.json({
      currentVersion: template.version,
      versions,
    });
  } catch (error) {
    next(error);
  }
};

/** GET /templates/:id/versions/:version — one snapshot with its data. */
export const getTemplateVersion = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const version = Number(req.params.version);
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const template = await Template.findOne({ _id: id, userId: user._id }).select('version').lean();
    if (!template) {
      throw ApiError.notFound('Template not found');
    }

    const snapshot = await TemplateVersion.findOne({ templateId: template._id, version }).lean();
    if (!snapshot) {
      throw ApiError.withCode(404, 'VERSION_NOT_FOUND', 'This version is no longer in the history.');
    }

    res.json({ currentVersion: template.version, version: snapshot });
  } catch (error) {
    next(error);
  }
};

export const restoreVersion = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const version = Number(req.params.version);
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    // Ownership first, so other users' version numbers aren't probeable.
    const template = await Template.findOne({ _id: id, userId: user._id });
    if (!template) {
      throw ApiError.notFound('Template not found');
    }

    // Same lock as saves: the editor restores on top of the version it has
    // open; if another tab saved since, the user should see that first.
    const baseVersion = req.body?.baseVersion;
    if (typeof baseVersion === 'number' && baseVersion !== template.version) {
      throw ApiError.withCode(409, 'VERSION_CONFLICT', 'This project was changed in another tab or device.', {
        currentVersion: template.version,
        baseVersion,
      });
    }

    const snapshot = await TemplateVersion.findOne({ templateId: template._id, version }).lean();
    if (!snapshot) {
      throw ApiError.withCode(404, 'VERSION_NOT_FOUND', 'This version is no longer in the history.');
    }

    // Keep the state being replaced. Idempotent (a Render may already have
    // snapshotted this version), and if it can't be stored nothing is restored.
    await keepSnapshot(template, user._id, 'before-restore');

    // Conditional on the version we checked, so a save can't slip in between.
    const restored = await Template.findOneAndUpdate(
      { _id: template._id, userId: user._id, version: template.version },
      { data: snapshot.data, $inc: { version: 1 } },
      { new: true }
    );
    if (!restored) {
      throw ApiError.withCode(409, 'VERSION_CONFLICT', 'This project was changed in another tab or device.', {
        currentVersion: (await Template.findById(template._id).select('version').lean())?.version,
        baseVersion,
      });
    }

    // `success` stays for older clients. The project data isn't echoed back
    // (it can be megabytes): the editor reloads the template anyway.
    res.json({
      success: true,
      id: restored._id,
      version: restored.version,
      restoredFrom: version,
      updatedAt: restored.updatedAt,
    });
  } catch (error) {
    next(error);
  }
};

export const duplicateTemplate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const template = await Template.findOne({
      _id: id,
      $or: [{ userId: user._id }, { isPublic: true }],
    });

    if (!template) {
      throw ApiError.notFound('Template not found');
    }

    const duplicate = await Template.create({
      userId: user._id,
      name: `${template.name} (Copy)`,
      description: template.description,
      data: template.data,
      tags: template.tags,
      isPublic: false,
    });

    res.status(201).json(duplicate);
  } catch (error) {
    next(error);
  }
};

const RENDER_SORT_FIELDS = new Set(['createdAt', 'updatedAt', 'completedAt', 'status']);

export const getTemplateRenders = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const {
      page = '1',
      limit = '20',
      status,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = req.query;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    // Verify template exists and user has access
    const template = await Template.findOne({
      _id: id,
      $or: [{ userId: user._id }, { isPublic: true }],
    });

    if (!template) {
      throw ApiError.notFound('Template not found');
    }

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);

    // Build query for renders
    // Only the caller's own renders, even on a public template others use.
    const query: any = { templateId: id, userId: user._id };

    if (typeof status === 'string' && status) {
      query.status = status;
    }

    const [renders, total] = await Promise.all([
      RenderJob.find(query)
        .sort({ [RENDER_SORT_FIELDS.has(String(sortBy)) ? String(sortBy) : 'createdAt']: sortOrder === 'desc' ? -1 : 1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .select('-inputProps') // Exclude large inputProps for list view
        .lean(),
      RenderJob.countDocuments(query),
    ]);

    res.json({
      template: {
        id: template._id,
        name: template.name,
        description: template.description,
      },
      data: (await ensureShareTokens(renders)).map((render) => publicRender(render)),
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

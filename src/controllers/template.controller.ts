import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { Template } from '../models/Template';
import { TemplateVersion } from '../models/TemplateVersion';
import { RenderJob } from '../models/RenderJob';
import { User } from '../models/User';
import { getUserQuota } from '../config/quotas';
import { ApiError } from '../utils/ApiError';

export const createTemplate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.userId!;
    const { name = 'New Template', description = 'New Template Description', data = { project: {}, elements: [] }, tags = [], isPublic = true } = req.body;

    console.log(req.body);

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const quota = getUserQuota(user.role);
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
    const updates = req.body;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const template = await Template.findOne({ _id: id, userId: user._id });
    if (!template) {
      throw ApiError.notFound('Template not found or unauthorized');
    }

    // Save version history
    await TemplateVersion.create({
      templateId: template._id,
      version: template.version,
      data: template.data,
      createdBy: user._id,
    });

    console.log("Template updates",updates);

    const updatedTemplate = await Template.findByIdAndUpdate(
      id,
      {
        ...updates,
        $inc: { version: 1 },
      },
      { new: true }
    );

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

    const result = await Template.deleteMany({
      _id: { $in: ids },
      userId: user._id,
    });

    await TemplateVersion.deleteMany({ templateId: { $in: ids } });

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

    const versions = await TemplateVersion.find({ templateId: id })
      .sort({ version: -1 })
      .limit(20)
      .lean();

    res.json({
      currentVersion: template.version,
      versions,
    });
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
    const { id, version } = req.params;
    const userId = req.userId!;

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const templateVersion = await TemplateVersion.findOne({
      templateId: id,
      version: parseInt(version),
    });

    if (!templateVersion) {
      throw ApiError.notFound('Version not found');
    }

    const template = await Template.findOne({ _id: id, userId: user._id });
    if (!template) {
      throw ApiError.notFound('Template not found');
    }

    // Save current as new version before restoring
    await TemplateVersion.create({
      templateId: template._id,
      version: template.version,
      data: template.data,
      createdBy: user._id,
    });

    await Template.findByIdAndUpdate(id, {
      data: templateVersion.data,
      $inc: { version: 1 },
    });

    res.json({ success: true });
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
    const query: any = { templateId: id };

    if (status) {
      query.status = status;
    }

    const [renders, total] = await Promise.all([
      RenderJob.find(query)
        .sort({ [sortBy as string]: sortOrder === 'desc' ? -1 : 1 })
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
      data: renders,
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

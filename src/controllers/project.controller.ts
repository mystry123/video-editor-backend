import { Response, NextFunction } from 'express';
import { AuthRequest, PaginationQuery } from '../types';
import { RenderJob, IRenderJob, RenderStatus } from '../models/RenderJob';
import { ApiError } from '../utils/ApiError';
import { CaptionProject } from '../models';

// ============================================
// TYPES
// ============================================

interface ProjectQuery extends PaginationQuery {
  type?: "Template" | "CaptionProject";
  status?: RenderStatus;
  date?: string;
  search?: string;
  offset?: string;
}

interface ProjectResponse {
  _id: string;
  templateId?: string;
  outputFormat: string;
  resolution: string;
  fps: number;
  renderId?: string;
  outputUrl?: string;
  thumbnailUrl?: string;
  status: RenderStatus;
  progress: number;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  type?: "Template" | "CaptionProject";
}

interface PaginatedProjectsResponse {
  data: ProjectResponse[];
  offset: number;
}

// ============================================
// HELPERS
// ============================================

function formatProjectResponse(project: any): ProjectResponse {
  return {
    _id: project._id.toString(),
    templateId: project.presetId?.toString(), // Use presetId instead of templateId
    outputFormat: project.settings?.outputFormat || 'mp4',
    resolution: '1920x1080', // Default resolution for caption projects
    fps: 30, // Default fps for caption projects
    renderId: project.renderJobId?.toString(),
    outputUrl: project.outputUrl,
    thumbnailUrl: project.thumbnailUrl,
    status: project.status,
    progress: project.progress,
    error: project.error,
    startedAt: project.createdAt, // Use createdAt as startedAt
    completedAt: project.renderCompletedAt,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    type: 'CaptionProject', // Set type to CaptionProject
  };
}

function buildFilter(query: ProjectQuery, userId: string): any {
  const filter: any = { userId };

  // Status filter
  if (query.status) {
    filter.status = query.status;
  }

  // Type filter
  if (query.type) {
    filter.renderType = query.type;
  }

  // Date filter - support various date formats
  if (query.date) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    switch (query.date.toLowerCase()) {
      case 'today':
        filter.createdAt = {
          $gte: today,
          $lt: tomorrow,
        };
        break;
      case 'yesterday':
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        filter.createdAt = {
          $gte: yesterday,
          $lt: today,
        };
        break;
      case 'week':
        const weekAgo = new Date(today);
        weekAgo.setDate(weekAgo.getDate() - 7);
        filter.createdAt = {
          $gte: weekAgo,
        };
        break;
      case 'month':
        const monthAgo = new Date(today);
        monthAgo.setMonth(monthAgo.getMonth() - 1);
        filter.createdAt = {
          $gte: monthAgo,
        };
        break;
      default:
        // Try to parse as a specific date (YYYY-MM-DD)
        const parsedDate = new Date(query.date);
        if (!isNaN(parsedDate.getTime())) {
          const startDate = new Date(parsedDate);
          startDate.setHours(0, 0, 0, 0);
          const endDate = new Date(parsedDate);
          endDate.setHours(23, 59, 59, 999);
          filter.createdAt = {
            $gte: startDate,
            $lte: endDate,
          };
        }
    }
  }

  // Search filter - search in renderId, outputUrl, and error messages
  if (query.search) {
    const searchRegex = new RegExp(query.search, 'i');
    filter.$or = [
      { renderId: { $regex: searchRegex } },
      { outputUrl: { $regex: searchRegex } },
      { error: { $regex: searchRegex } },
      { renderType: { $regex: searchRegex } },
    ];
  }

  return filter;
}

function buildSortOptions(query: ProjectQuery): any {
  const sortBy = query.sortBy || 'updatedAt';
  const sortOrder = query.sortOrder === 'asc' ? 1 : -1;

  const sortOptions: any = { [sortBy]: sortOrder };

  // Add secondary sort by createdAt for consistent ordering
  if (sortBy !== 'createdAt') {
    sortOptions.createdAt = -1;
  }

  return sortOptions;
}

function getPaginationOptions(query: ProjectQuery): { page: number; limit: number; skip: number; offset: number } {
  const limit = Math.min(100, Math.max(1, parseInt(query.limit || '10'))); // Changed default from 20 to 10
  
  let page: number;
  let skip: number;
  let offset: number;

  if (query.offset !== undefined) {
    // Offset-based pagination
    offset = Math.max(0, parseInt(query.offset));
    skip = offset;
    page = Math.floor(skip / limit) + 1;
  } else {
    // Page-based pagination (default)
    page = Math.max(1, parseInt(query.page || '1'));
    skip = (page - 1) * limit;
    offset = skip;
  }

  return { page, limit, skip, offset };
}

// ============================================
// CONTROLLERS
// ============================================

// GET /projects - Get all render jobs with filtering, pagination, and search
export const getAll = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const query = req.query as ProjectQuery;
    const userId = req.userId!;

    console.log({query, userId});

    // Build filter, sort, and pagination options
    const filter = buildFilter(query, userId);
    const sortOptions = buildSortOptions(query);
    const { page, limit, skip, offset } = getPaginationOptions(query);

    // Execute queries in parallel
    const projects = await CaptionProject.find(filter)
      .sort(sortOptions)
      .skip(skip)
      .limit(limit)
      .lean();

    console.log({projects});  

    // Format response
    const formattedProjects = projects.map(formatProjectResponse);

    const response: PaginatedProjectsResponse = {
      data: formattedProjects,
      offset,
    };

    res.json(response);
  } catch (error) {
    next(error);
  }
};

// GET /projects/:id - Get a single project
export const getOne = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const project = await CaptionProject.findOne({ _id: id, userId });

    if (!project) {
      throw ApiError.notFound('Project not found');
    }

    res.json(formatProjectResponse(project));
  } catch (error) {
    next(error);
  }
};

// GET /projects/:id/status - Get project status
export const getStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const project = await RenderJob.findOne({ _id: id, userId }).select('status progress error startedAt completedAt');

    if (!project) {
      throw ApiError.notFound('Project not found');
    }

    res.json({
      status: project.status,
      progress: project.progress,
      error: project.error,
      startedAt: project.startedAt,
      completedAt: project.completedAt,
    });
  } catch (error) {
    next(error);
  }
};

// PATCH /projects/:id - Update project
export const update = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const updates = req.body;

    // Only allow updating certain fields
    const allowedUpdates = ['outputFormat', 'resolution', 'fps'];
    const actualUpdates: any = {};

    for (const key of allowedUpdates) {
      if (updates[key] !== undefined) {
        actualUpdates[key] = updates[key];
      }
    }

    if (Object.keys(actualUpdates).length === 0) {
      throw ApiError.badRequest('No valid fields to update');
    }

    const project = await RenderJob.findOneAndUpdate(
      { _id: id, userId },
      actualUpdates,
      { new: true, runValidators: true }
    );

    if (!project) {
      throw ApiError.notFound('Project not found');
    }

    res.json(formatProjectResponse(project));
  } catch (error) {
    next(error);
  }
};

// DELETE /projects/:id - Delete project
export const deleteProject = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const project = await RenderJob.findOneAndDelete({ _id: id, userId });

    if (!project) {
      throw ApiError.notFound('Project not found');
    }

    // TODO: Also delete associated files from S3 if needed
    // TODO: Cancel any ongoing renders

    res.json({ message: 'Project deleted successfully' });
  } catch (error) {
    next(error);
  }
};

// POST /projects/:id/cancel - Cancel project
export const cancel = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const project = await RenderJob.findOne({ _id: id, userId });

    if (!project) {
      throw ApiError.notFound('Project not found');
    }

    // Check if project can be cancelled
    if (!['pending', 'queued', 'rendering'].includes(project.status)) {
      throw ApiError.badRequest('Project cannot be cancelled in current status');
    }

    // Update status to cancelled
    const updatedProject = await RenderJob.findByIdAndUpdate(
      id,
      { 
        status: 'cancelled',
        completedAt: new Date(),
      },
      { new: true }
    );

    // TODO: Actually cancel the render job in Remotion Lambda
    // TODO: Clean up any resources

    res.json(formatProjectResponse(updatedProject!));
  } catch (error) {
    next(error);
  }
};

// ============================================
// SEARCH ENDPOINT (additional)
// ============================================

// GET /projects/search - Advanced search endpoint
export const search = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { q: searchQuery, ...otherQuery } = req.query as { q?: string } & ProjectQuery;
    const userId = req.userId!;

    if (!searchQuery) {
      throw ApiError.badRequest('Search query (q) is required');
    }

    // Add search to query
    const query = { ...otherQuery, search: searchQuery };

    // Use the same getAll logic but with search
    const filter = buildFilter(query, userId);
    const sortOptions = buildSortOptions(query);
    const { page, limit, skip, offset } = getPaginationOptions(query);

    const projects = await RenderJob.find(filter)
      .sort(sortOptions)
      .skip(skip)
      .limit(limit)
      .lean();

    const formattedProjects = projects.map(formatProjectResponse);

    const response: PaginatedProjectsResponse = {
      data: formattedProjects,
      offset,
    };

    res.json(response);
  } catch (error) {
    next(error);
  }
};
import { Request } from 'express';

export interface AuthRequest extends Request {
  userId?: string;
  user?: any;
  permissions?: string[];
  authMethod?: 'cookie' | 'api-key' | 'bearer';
}

export interface PaginationQuery {
  page?: string;
  limit?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface ProjectSettings {
  width: number;
  height: number;
  name: string;
  fps: number;
  duration: number;
  backgroundColor: string;
  outputFormat?: string;
  selectedVoice?: string;
}

export interface TemplateData {
  project: ProjectSettings;
  elements: any[];
}

export type UserRole = 'free' | 'pro' | 'team' | 'admin';

export type FileStatus = 'processing' | 'ready' | 'error' | 'deleted';

export type TranscriptionStatus = 'pending' | 'processing' | 'completed' | 'failed';

export type RenderStatus = 'pending' | 'queued' | 'rendering' | 'encoding' | 'completed' | 'failed' | 'cancelled';

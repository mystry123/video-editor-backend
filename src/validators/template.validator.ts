import { z } from 'zod';

export const createTemplateSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    data: z.object({
      project: z.object({
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        name: z.string().optional(),
        fps: z.number().positive().optional(),
        duration: z.number().positive().optional(),
        backgroundColor: z.string().optional(),
        outputFormat: z.string().optional(),
        selectedVoice: z.string().optional(),
      }).optional(),
      elements: z.array(z.any()).optional(),
    }),
    tags: z.array(z.string()).optional(),
    isPublic: z.boolean().optional(),
  }),
});

export const updateTemplateSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
    data: z.object({
      project: z.any().optional(),
      elements: z.array(z.any()).optional(),
    }).optional(),
    tags: z.array(z.string()).optional(),
    isPublic: z.boolean().optional(),
  }),
  params: z.object({
    id: z.string(),
  }),
});

export const listTemplatesSchema = z.object({
  query: z.object({
    page: z.string().optional(),
    limit: z.string().optional(),
    search: z.string().optional(),
    tags: z.string().optional(),
    isPublic: z.string().optional(),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
  }),
});

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
    /** Version the editor's state is based on; a different current version is a 409. */
    baseVersion: z.number().int().nonnegative().optional(),
    /** Save anyway over a newer version (after the user chose "Overwrite"). */
    overwrite: z.boolean().optional(),
    /** "leave": always keep a version-history snapshot of this point. */
    snapshot: z.enum(['leave']).optional(),
  }),
  params: z.object({
    id: z.string(),
  }),
});

const versionParams = z.object({
  id: z.string(),
  version: z.string().regex(/^\d+$/, 'Version must be a whole number.'),
});

export const listTemplateVersionsSchema = z.object({
  query: z.object({
    /** Newest N snapshots, 1–50 (default 20). */
    limit: z.string().regex(/^\d+$/, 'limit must be a whole number.').optional(),
    /** "true": leave out each snapshot's data and add a summary. */
    summary: z.enum(['true', 'false']).optional(),
  }),
});

export const getTemplateVersionSchema = z.object({
  params: versionParams,
});

export const restoreTemplateVersionSchema = z.object({
  body: z
    .object({
      /** Version the editor has open; a different current version is a 409. */
      baseVersion: z.number().int().nonnegative().optional(),
    })
    .optional(),
  params: versionParams,
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

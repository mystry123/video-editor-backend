import { env } from '../config/env';

const serverUrl = `${env.apiBaseUrl.replace(/\/$/, '')}/api/v1`;

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Shotline Render API',
    version: '1.0.0',
    description:
      'Render videos from saved templates. Authenticate with an API key created at /settings/api-keys in the Shotline app.',
  },
  servers: [{ url: serverUrl }],
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
      },
    },
    schemas: {
      RenderRequest: {
        type: 'object',
        required: ['templateId'],
        properties: {
          templateId: {
            type: 'string',
            description: 'The id of the template to render. Visible in the editor URL.',
          },
          variables: {
            type: 'object',
            description:
              'Per-call overrides keyed by element name. Pass a string to set the primary content of an element (text for text/caption, src for image/video/audio). Pass an object to deep-merge arbitrary properties.',
            additionalProperties: {
              oneOf: [
                { type: 'string' },
                { type: 'number' },
                { type: 'boolean' },
                { type: 'object' },
              ],
            },
            example: {
              headline: 'Hello world',
              logo: 'https://example.com/logo.png',
            },
          },
          webhookUrl: {
            type: 'string',
            format: 'uri',
            nullable: true,
            description: 'Optional URL to POST when the render completes.',
          },
        },
      },
      RenderJobAck: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', example: 'pending' },
          estimatedTime: { type: 'number', description: 'Seconds.' },
        },
      },
      RenderJobStatus: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: {
            type: 'string',
            enum: ['pending', 'queued', 'rendering', 'completed', 'failed', 'cancelled'],
          },
          progress: { type: 'number', minimum: 0, maximum: 100 },
          outputUrl: { type: 'string', format: 'uri', nullable: true },
          error: { type: 'string', nullable: true },
        },
      },
      Template: {
        type: 'object',
        properties: {
          _id: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string', nullable: true },
          thumbnail: { type: 'string', nullable: true },
          tags: { type: 'array', items: { type: 'string' } },
          isPublic: { type: 'boolean' },
          usageCount: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      ApiKey: {
        type: 'object',
        properties: {
          _id: { type: 'string' },
          name: { type: 'string' },
          keyPrefix: { type: 'string' },
          lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
          expiresAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
  },
  security: [{ ApiKeyAuth: [] }],
  paths: {
    '/render': {
      post: {
        summary: 'Start a render from a template',
        tags: ['Render'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/RenderRequest' } } },
        },
        responses: {
          '202': {
            description: 'Render queued',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/RenderJobAck' } } },
          },
          '400': { description: 'Invalid request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '401': { description: 'Missing or invalid credentials' },
          '404': { description: 'Template not found' },
          '429': { description: 'Rate limit or quota exceeded' },
        },
      },
    },
    '/render/{id}': {
      get: {
        summary: 'Get render status',
        tags: ['Render'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Current render status',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/RenderJobStatus' } } },
          },
          '404': { description: 'Render not found' },
        },
      },
    },
    '/render/{id}/progress': {
      get: {
        summary: 'Stream render progress (Server-Sent Events)',
        tags: ['Render'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'text/event-stream of status updates' } },
      },
    },
    '/templates': {
      get: {
        summary: 'List your templates',
        tags: ['Templates'],
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
          { name: 'search', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Paginated list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Template' } },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/templates/{id}': {
      get: {
        summary: 'Get a single template',
        tags: ['Templates'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Template', content: { 'application/json': { schema: { $ref: '#/components/schemas/Template' } } } },
          '404': { description: 'Not found' },
        },
      },
    },
    '/auth/api-keys': {
      get: {
        summary: 'List your API keys',
        tags: ['API Keys'],
        responses: {
          '200': {
            description: 'List',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ApiKey' } } } },
          },
        },
      },
      post: {
        summary: 'Create an API key (returns the secret once)',
        tags: ['API Keys'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string', example: 'My integration' },
                  expiresAt: { type: 'string', format: 'date-time', nullable: true },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Created — secret is included once and is not retrievable again',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/ApiKey' },
                    { type: 'object', properties: { key: { type: 'string', description: 'The plaintext API key. Store it securely.' } } },
                  ],
                },
              },
            },
          },
        },
      },
    },
    '/auth/api-keys/{id}': {
      delete: {
        summary: 'Revoke an API key',
        tags: ['API Keys'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '204': { description: 'Deleted' }, '404': { description: 'Not found' } },
      },
    },
  },
};

import { templates, labs } from '@shlab/engine';

const response = {
  200: { description: 'Sucesso' },
  400: { description: 'Dados inválidos' },
  401: { description: 'Sessão ausente ou expirada' },
  403: { description: 'CSRF/origem ou e-mail não verificado' },
  404: { description: 'Recurso não encontrado ou pertence a outro usuário' },
  409: { description: 'Conflito de revisão' },
  429: { description: 'Limite de requisições' },
};
const json = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  required: true,
  content: {
    'application/json': { schema: { type: 'object', additionalProperties: false, properties, required } },
  },
});
const str = { type: 'string' };
const op = (summary: string, body?: ReturnType<typeof json>, secured = false) => ({
  summary,
  responses: response,
  ...(body ? { requestBody: body } : {}),
  ...(secured ? { security: [{ session: [], csrf: [] }] } : {}),
});
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'shLab API',
    version: '0.1.0',
    description:
      'Mutations require an exact Origin header. Authenticated mutations also require X-CSRF-Token from /auth/me or /auth/login. Topologies use schemaVersion=1 with server-side domain validation.',
  },
  components: {
    securitySchemes: {
      session: { type: 'apiKey', in: 'cookie', name: 'shlab_session' },
      csrf: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token' },
      metrics: { type: 'http', scheme: 'bearer' },
    },
  },
  paths: {
    '/api/activity': { get: op('Private activity history with cursor pagination', undefined, true) },
    '/api/projects/{id}/visits': { parameters: [idParam], post: op('Record project visit', json({}), true) },
    '/api/live': { get: op('Process liveness') },
    '/api/ready': {
      get: {
        summary: 'SQL and notification readiness',
        responses: { 200: { description: 'Ready' }, 503: { description: 'Unavailable' } },
      },
    },
    '/api/health': {
      get: {
        summary: 'Compatibility readiness endpoint',
        responses: { 200: { description: 'Ready' }, 503: { description: 'Unavailable' } },
      },
    },
    '/api/metrics': {
      get: {
        summary: 'Prometheus metrics (disabled without METRICS_TOKEN)',
        security: [{ metrics: [] }],
        responses: {
          200: { description: 'Metrics', content: { 'text/plain': { schema: { type: 'string' } } } },
          401: { description: 'Invalid metrics token' },
          404: { description: 'Metrics disabled' },
        },
      },
    },
    '/api/auth/register': {
      post: op(
        'Register and send verification',
        json({
          name: str,
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 12, maxLength: 128 },
        })
      ),
    },
    '/api/auth/login': { post: op('Login and rotate session', json({ email: str, password: str })) },
    '/api/auth/me': { get: op('Current user and CSRF token', undefined, true) },
    '/api/auth/logout': { post: op('Revoke session', undefined, true) },
    '/api/auth/profile': {
      patch: op('Update own profile', json({ name: { type: 'string', minLength: 2, maxLength: 80 } }), true),
    },
    '/api/auth/sessions': { get: op('List own sessions without bearer tokens', undefined, true) },
    '/api/auth/sessions/{id}': {
      parameters: [idParam],
      delete: op('Revoke an owned session', undefined, true),
    },
    '/api/auth/sessions/revoke-others': { post: op('Revoke all other sessions', undefined, true) },
    '/api/auth/account': {
      delete: op(
        'Delete own account and related data after password confirmation',
        json({ password: str }),
        true
      ),
    },
    '/api/auth/verify-email': { post: op('Consume verification token', json({ token: str })) },
    '/api/auth/resend-verification': { post: op('Resend verification', json({ email: str })) },
    '/api/auth/forgot-password': { post: op('Request reset', json({ email: str })) },
    '/api/auth/reset-password': {
      post: op('Consume reset token and revoke sessions', json({ token: str, password: str })),
    },
    '/api/auth/change-password': {
      post: op('Change password and revoke sessions', json({ currentPassword: str, password: str }), true),
    },
    '/api/projects': {
      get: op('List own projects', undefined, true),
      post: op(
        'Create project',
        json(
          {
            name: str,
            template: { type: 'string', enum: templates.map((template) => template.id) },
            background: { type: 'string', enum: ['light', 'gray', 'dark'] },
            mode: { type: 'string', enum: ['free', 'guided', 'challenge'], default: 'free' },
            labId: {
              type: 'string',
              enum: labs.map((lab) => lab.id),
              description: 'Required for guided/challenge, omitted for free labs.',
            },
          },
          ['name']
        ),
        true
      ),
    },
    '/api/projects/{id}': {
      parameters: [idParam],
      get: op('Get own project', undefined, true),
      put: op(
        'Save with optimistic revision',
        json({
          name: str,
          revision: { type: 'integer', minimum: 1 },
          topology: {
            type: 'object',
            description:
              'Engine Snapshot v1, including optional DHCP pools/leases, DNS records/queries/cache and virtual timers. Validated against the shared engine model and referential invariants. See docs/database.md and docs/protocols.md.',
          },
        }),
        true
      ),
      delete: op('Delete own project', undefined, true),
    },
    '/api/projects/{id}/favorite': {
      parameters: [idParam],
      patch: op('Toggle favorite', json({ favorite: { type: 'boolean' } }), true),
    },
    '/api/labs': { get: op('List guided lab definitions', undefined, true) },
    '/api/projects/{id}/progress': {
      parameters: [idParam],
      get: op('Get latest evaluation and completion history', undefined, true),
    },
    '/api/projects/{id}/evaluate': {
      parameters: [idParam],
      post: op(
        'Evaluate the latest saved topology on an isolated engine with bounded work',
        json({}, []),
        true
      ),
    },
    '/api/learning/score': {
      get: op('Aggregate best network learning results for the current owner', undefined, true),
    },
    '/api/projects/{id}/challenge': {
      parameters: [idParam],
      get: op('Get declarative challenge and progress', undefined, true),
      put: op(
        'Save validated objectives and initial topology, invalidate old results',
        json({
          revision: { type: 'integer', minimum: 0 },
          projectRevision: { type: 'integer', minimum: 1 },
          definition: {
            type: 'object',
            description: 'ChallengeDefinition v1 with 1 to 16 typed network predicates; no executable code.',
          },
        }),
        true
      ),
    },
    '/api/projects/{id}/challenge/evaluate': {
      parameters: [idParam],
      post: op(
        'Evaluate saved topology with fresh simulated traffic',
        json({ revision: { type: 'integer', minimum: 1 } }),
        true
      ),
    },
    '/api/projects/{id}/challenge/reset': {
      parameters: [idParam],
      post: op(
        'Restore challenge baseline using optimistic revisions',
        json({ revision: { type: 'integer', minimum: 1 }, projectRevision: { type: 'integer', minimum: 1 } }),
        true
      ),
    },
    '/api/projects/{id}/tutorial': {
      parameters: [idParam],
      get: op('Get sequential network tutorial progress', undefined, true),
    },
    '/api/projects/{id}/tutorial/check': {
      parameters: [idParam],
      post: op(
        'Validate this step and all previous prerequisites',
        json({ step: { type: 'integer', minimum: 0, maximum: 4 } }),
        true
      ),
    },
    '/api/projects/{id}/snapshots': {
      parameters: [idParam],
      get: op('List versions', undefined, true),
      post: op('Snapshot latest saved topology', json({ label: str }), true),
    },
    '/api/projects/{id}/snapshots/{version}': {
      parameters: [
        idParam,
        { name: 'version', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      get: op('Get saved snapshot', undefined, true),
    },
    '/api/events': {
      get: op('Authenticated WebSocket: project.created / updated / deleted', undefined, true),
    },
  },
};

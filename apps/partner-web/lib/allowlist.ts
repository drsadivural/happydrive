/**
 * 企業ポータルの BFF が中継してよい API（最小権限）。/admin/* と認証系は含めない。
 */
import type { AllowRule } from '@happydrive/web-ui/bff/allowlist';

export const PARTNER_API_RULES: readonly AllowRule[] = [
  { methods: ['GET'], path: '/me' },
  { methods: ['GET'], path: '/skills/catalog' },
  { methods: ['POST'], path: '/organizations' },
  { methods: ['GET', 'PATCH'], path: '/organizations/{organizationId}' },
  { methods: ['GET'], path: '/organizations/{organizationId}/dashboard' },
  { methods: ['GET', 'POST'], path: '/organizations/{organizationId}/sites' },
  { methods: ['PUT', 'DELETE'], path: '/organizations/{organizationId}/sites/{siteId}' },
  { methods: ['GET', 'POST'], path: '/organizations/{organizationId}/members' },
  { methods: ['DELETE'], path: '/organizations/{organizationId}/members/{userId}' },
  { methods: ['GET', 'POST'], path: '/organizations/{organizationId}/jobs' },
  { methods: ['GET', 'PUT'], path: '/organizations/{organizationId}/jobs/{jobId}' },
  { methods: ['POST'], path: '/organizations/{organizationId}/jobs/{jobId}/submit' },
  { methods: ['POST'], path: '/organizations/{organizationId}/jobs/{jobId}/cancel' },
  { methods: ['GET'], path: '/organizations/{organizationId}/jobs/{jobId}/assignments' },
  { methods: ['GET'], path: '/organizations/{organizationId}/assignments' },
  { methods: ['GET'], path: '/organizations/{organizationId}/invoices' },
  { methods: ['GET'], path: '/assignments/{assignmentId}' },
  { methods: ['POST'], path: '/assignments/{assignmentId}/reservation' },
  { methods: ['POST'], path: '/assignments/{assignmentId}/review' },
  { methods: ['POST'], path: '/assignments/{assignmentId}/no-show' },
  { methods: ['GET'], path: '/assignments/{assignmentId}/live-location' },
  { methods: ['POST'], path: '/assignments/{assignmentId}/rating' },
  { methods: ['GET', 'POST'], path: '/assignments/{assignmentId}/messages' },
  { methods: ['GET'], path: '/evidence/{evidenceId}/url' },
  { methods: ['POST'], path: '/reports' },
];

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import YAML from 'yaml';
import $RefParser from '@apidevtools/json-schema-ref-parser';

const require = createRequire(import.meta.url);

export interface Operation {
  operationId: string;
  method: string;
  path: string; // fastify style, without /v1 prefix
  isPublic: boolean;
  requiresIdempotencyKey: boolean;
  schema: {
    params?: object;
    querystring?: object;
    headers?: object;
    body?: object;
  };
  binaryBody: boolean;
}

/** Loads packages/contracts/openapi.yaml (the source of truth) and derives Fastify route schemas from it. */
export async function loadOperations(): Promise<Operation[]> {
  const file = require.resolve('@happydrive/contracts/openapi.yaml');
  const doc = (await $RefParser.dereference(YAML.parse(readFileSync(file, 'utf8')))) as any;
  const ops: Operation[] = [];
  const globalSecurity = doc.security ?? [];
  for (const [path, item] of Object.entries<any>(doc.paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = item[method];
      if (!op) continue;
      const parameters: any[] = [...(item.parameters ?? []), ...(op.parameters ?? [])];
      const byIn = (loc: string) => parameters.filter((p) => p.in === loc);
      const toObj = (ps: any[], lower = false) =>
        ps.length
          ? {
              type: 'object',
              properties: Object.fromEntries(ps.map((p) => [lower ? p.name.toLowerCase() : p.name, p.schema])),
              required: ps.filter((p) => p.required).map((p) => (lower ? p.name.toLowerCase() : p.name)),
            }
          : undefined;
      const content = op.requestBody?.content ?? {};
      const jsonBody = content['application/json']?.schema;
      const binaryBody = !jsonBody && Object.keys(content).some((k) => k.startsWith('image/'));
      const headers = toObj(byIn('header'), true);
      const security = op.security ?? globalSecurity;
      ops.push({
        operationId: op.operationId,
        method: method.toUpperCase(),
        path: path.replace(/\{(\w+)\}/g, ':$1'),
        isPublic: Array.isArray(security) && security.length === 0,
        requiresIdempotencyKey: byIn('header').some((p) => p.name === 'Idempotency-Key' && p.required),
        schema: Object.fromEntries(
          Object.entries({
            params: toObj(byIn('path')),
            querystring: toObj(byIn('query')),
            headers,
            // Optional JSON bodies (e.g. DELETE /me) are validated in their handlers.
            body: jsonBody && op.requestBody?.required ? jsonBody : undefined,
          }).filter(([, v]) => v !== undefined),
        ),
        binaryBody,
      });
    }
  }
  return ops;
}

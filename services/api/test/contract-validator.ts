import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import YAML from 'yaml';
import $RefParser from '@apidevtools/json-schema-ref-parser';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const require = createRequire(import.meta.url);

export interface ContractValidator {
  spec: any;
  seen: Set<string>;
  validate(method: string, url: string, status: number, body: unknown): void;
}

let cached: Promise<ContractValidator> | undefined;

/** Validates every response status/body against packages/contracts/openapi.yaml; throws on any deviation. */
export function contractValidator(): Promise<ContractValidator> {
  cached ??= (async () => {
    const spec: any = await $RefParser.dereference(YAML.parse(readFileSync(require.resolve('@happydrive/contracts/openapi.yaml'), 'utf8')));
    const ajv = new (Ajv2020 as any)({ strict: false, allErrors: true });
    (addFormats as any)(ajv);
    const routes = Object.entries<any>(spec.paths).map(([tpl, item]) => ({ re: new RegExp(`^${tpl.replace(/\{[^}]+\}/g, '[^/]+')}$`), item }));
    const compiled = new Map<object, any>();
    const seen = new Set<string>();
    return {
      spec,
      seen,
      validate(method, url, status, body) {
        const path = url.split('?')[0]!;
        const route = routes.find((r) => r.re.test(path) && r.item[method.toLowerCase()]);
        if (!route) throw new Error(`no contract operation for ${method} ${path}`);
        const op = route.item[method.toLowerCase()];
        seen.add(op.operationId);
        if (status === 429 || status >= 500) return; // rate limiting / infrastructure errors are generic
        const resp = op.responses[String(status)] ?? (status >= 400 ? op.responses.default : undefined);
        if (!resp) throw new Error(`${op.operationId} returned undocumented status ${status}: ${JSON.stringify(body)}`);
        const schema = resp.content?.['application/json']?.schema;
        if (!schema || body === undefined) return;
        let v = compiled.get(schema);
        if (!v) compiled.set(schema, (v = ajv.compile(schema)));
        if (!v(JSON.parse(JSON.stringify(body)))) throw new Error(`${op.operationId} ${status} response violates contract: ${ajv.errorsText(v.errors)}`);
      },
    };
  })();
  return cached;
}

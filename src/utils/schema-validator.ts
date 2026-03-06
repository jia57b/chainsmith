/**
 * JSON Schema validation utility for RPC response/request validation.
 *
 * Uses ajv (draft-7) with a normalization layer to handle JSON Schema 2020-12
 * keywords (e.g. `prefixItems`) used in the test builder schemas.
 */

import Ajv, { ValidateFunction } from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: false });

// Cache compiled validators by schema JSON to avoid recompilation
const validatorCache = new Map<string, ValidateFunction>();

export interface SchemaValidationError {
    path: string;
    message: string;
    keyword: string;
    params: Record<string, unknown>;
}

export interface SchemaValidationResult {
    valid: boolean;
    errors: SchemaValidationError[];
}

/**
 * Normalize a JSON Schema from 2020-12 to Draft-7 compatible format.
 * Converts `prefixItems` (2020-12 tuple validation) to array-form `items` (draft-7).
 */
function normalizeSchema(schema: unknown): unknown {
    if (schema === null || schema === undefined || typeof schema !== 'object') {
        return schema;
    }

    if (Array.isArray(schema)) {
        return schema.map(normalizeSchema);
    }

    const src = schema as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(src)) {
        if (key === 'prefixItems') {
            result['items'] = normalizeSchema(value);
        } else {
            result[key] = normalizeSchema(value);
        }
    }

    return result;
}

function getValidator(schema: unknown): ValidateFunction {
    const cacheKey = JSON.stringify(schema);
    const cached = validatorCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const normalized = normalizeSchema(schema);
    const validate = ajv.compile(normalized as Record<string, unknown>);
    validatorCache.set(cacheKey, validate);
    return validate;
}

/**
 * Validate data against a JSON Schema.
 * Returns a structured result with error details on failure.
 */
export function validateSchema(data: unknown, schema: unknown): SchemaValidationResult {
    if (!schema) {
        return { valid: true, errors: [] };
    }

    try {
        const validate = getValidator(schema);
        const valid = validate(data);

        if (!valid && validate.errors) {
            const errors: SchemaValidationError[] = validate.errors.map(err => ({
                path: err.instancePath || '/',
                message: err.message ?? 'Unknown validation error',
                keyword: err.keyword,
                params: err.params as Record<string, unknown>,
            }));
            return { valid: false, errors };
        }

        return { valid: true, errors: [] };
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
            valid: false,
            errors: [
                {
                    path: '/',
                    message: `Schema compilation error: ${msg}`,
                    keyword: 'schema',
                    params: {},
                },
            ],
        };
    }
}

/**
 * Format validation errors into a human-readable multi-line string.
 */
export function formatValidationErrors(errors: SchemaValidationError[]): string {
    return errors.map(e => `  ${e.path}: ${e.message} [${e.keyword}]`).join('\n');
}

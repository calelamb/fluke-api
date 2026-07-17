import type { PublicErrorCode, SafeError } from '../contracts/index.js';

export type FailureKind =
  | 'authentication'
  | 'conflict'
  | 'database'
  | 'forbidden'
  | 'not-found'
  | 'provider'
  | 'rate-limit'
  | 'unexpected'
  | 'validation';

export interface FailureClassification {
  readonly body: SafeError;
  readonly kind: FailureKind;
  readonly statusCode: number;
}

interface ErrorLike {
  readonly code?: unknown;
  readonly name?: unknown;
  readonly statusCode?: unknown;
  readonly validation?: unknown;
}

interface PublicFailure {
  readonly code: PublicErrorCode;
  readonly kind: FailureKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly statusCode: number;
}

type PublicFailureTemplate = Omit<PublicFailure, 'statusCode'>;

const VALIDATION_FAILURE: PublicFailureTemplate = Object.freeze({
  code: 'VALIDATION_ERROR',
  kind: 'validation',
  message: 'The request is invalid.',
  retryable: false,
});

const INTERNAL_FAILURE: PublicFailureTemplate = Object.freeze({
  code: 'INTERNAL_ERROR',
  kind: 'unexpected',
  message: 'An unexpected error occurred.',
  retryable: false,
});

const EXACT_FAILURES: Readonly<Record<number, PublicFailureTemplate>> = Object.freeze({
  401: Object.freeze({
    code: 'UNAUTHORIZED',
    kind: 'authentication',
    message: 'Authentication is required.',
    retryable: false,
  }),
  403: Object.freeze({
    code: 'FORBIDDEN',
    kind: 'forbidden',
    message: 'This action is not allowed.',
    retryable: false,
  }),
  404: Object.freeze({
    code: 'NOT_FOUND',
    kind: 'not-found',
    message: 'The requested resource was not found.',
    retryable: false,
  }),
  409: Object.freeze({
    code: 'CONFLICT',
    kind: 'conflict',
    message: 'The request conflicts with the current resource state.',
    retryable: false,
  }),
  429: Object.freeze({
    code: 'RATE_LIMITED',
    kind: 'rate-limit',
    message: 'Too many requests. Try again later.',
    retryable: true,
  }),
  502: Object.freeze({
    code: 'UPSTREAM_UNAVAILABLE',
    kind: 'provider',
    message: 'A required service is temporarily unavailable.',
    retryable: true,
  }),
  503: Object.freeze({
    code: 'UPSTREAM_UNAVAILABLE',
    kind: 'provider',
    message: 'A required service is temporarily unavailable.',
    retryable: true,
  }),
  504: Object.freeze({
    code: 'UPSTREAM_UNAVAILABLE',
    kind: 'provider',
    message: 'A required service is temporarily unavailable.',
    retryable: true,
  }),
});

function errorLike(error: unknown): ErrorLike {
  return typeof error === 'object' && error !== null ? error : {};
}

function publicFailureForStatus(statusCode: number): PublicFailure {
  const exact = EXACT_FAILURES[statusCode];
  if (exact) {
    return { ...exact, statusCode };
  }
  if (statusCode >= 400 && statusCode < 500) {
    return { ...VALIDATION_FAILURE, statusCode };
  }

  return { ...INTERNAL_FAILURE, statusCode: 500 };
}

function withRequestId(failure: PublicFailure, requestId: string): FailureClassification {
  return {
    body: {
      code: failure.code,
      message: failure.message,
      requestId,
      retryable: failure.retryable,
    },
    kind: failure.kind,
    statusCode: failure.statusCode,
  };
}

export function classifyStatus(statusCode: number, requestId: string): FailureClassification {
  return withRequestId(publicFailureForStatus(statusCode), requestId);
}

export function classifyError(error: unknown, requestId: string): FailureClassification {
  const value = errorLike(error);
  const name = typeof value.name === 'string' ? value.name : '';
  const code = typeof value.code === 'string' ? value.code : '';
  const statusCode = typeof value.statusCode === 'number' ? value.statusCode : 500;

  if (Array.isArray(value.validation)) {
    return classifyStatus(400, requestId);
  }
  if (name.startsWith('PrismaClient') || /^P\d{4}$/u.test(code)) {
    const failure = publicFailureForStatus(503);
    return withRequestId({ ...failure, kind: 'database' }, requestId);
  }
  if (name === 'ProviderError' || code === 'PROVIDER_UNAVAILABLE') {
    return withRequestId(publicFailureForStatus(503), requestId);
  }

  return classifyStatus(statusCode, requestId);
}

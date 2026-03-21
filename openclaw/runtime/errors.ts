import { isRecord } from "./types.ts";

export type ErrorDetails = Record<string, unknown>;

type ApplicationErrorOptions = {
  code?: string;
  statusCode?: number;
  details?: ErrorDetails;
  retryable?: boolean;
  expose?: boolean;
  cause?: unknown;
};

export type ErrorPayload = {
  error: string;
  code: string;
  details?: ErrorDetails;
  retryable?: boolean;
};

export class ApplicationError extends Error {
  code: string;
  statusCode: number;
  details?: ErrorDetails;
  retryable: boolean;
  expose: boolean;
  override cause?: unknown;

  constructor(message: string, options: ApplicationErrorOptions = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code ?? "INTERNAL_ERROR";
    this.statusCode = options.statusCode ?? 500;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
    this.expose = options.expose ?? this.statusCode < 500;
    this.cause = options.cause;

    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class ValidationError extends ApplicationError {
  constructor(message: string, details?: ErrorDetails) {
    super(message, {
      code: "VALIDATION_ERROR",
      statusCode: 400,
      details
    });
  }
}

export class NotFoundError extends ApplicationError {
  constructor(message: string, details?: ErrorDetails) {
    super(message, {
      code: "NOT_FOUND",
      statusCode: 404,
      details
    });
  }
}

export class ForbiddenError extends ApplicationError {
  constructor(message: string, details?: ErrorDetails) {
    super(message, {
      code: "FORBIDDEN",
      statusCode: 403,
      details
    });
  }
}

export class ConfigurationError extends ApplicationError {
  constructor(message: string, details?: ErrorDetails) {
    super(message, {
      code: "CONFIGURATION_ERROR",
      statusCode: 500,
      details,
      expose: true
    });
  }
}

type ExternalServiceErrorOptions = {
  service: string;
  statusCode?: number;
  details?: ErrorDetails;
  retryable?: boolean;
  expose?: boolean;
  cause?: unknown;
};

export class ExternalServiceError extends ApplicationError {
  service: string;

  constructor(message: string, options: ExternalServiceErrorOptions) {
    super(message, {
      code: "EXTERNAL_SERVICE_ERROR",
      statusCode: options.statusCode ?? 502,
      details: {
        service: options.service,
        ...(options.details ?? {})
      },
      retryable: options.retryable ?? true,
      expose: options.expose ?? true,
      cause: options.cause
    });
    this.service = options.service;
  }
}

export class RequestTimeoutError extends ExternalServiceError {
  constructor(message: string, options: Omit<ExternalServiceErrorOptions, "statusCode">) {
    super(message, {
      ...options,
      statusCode: 504,
      retryable: true
    });
  }
}

export class DataIntegrityError extends ApplicationError {
  constructor(message: string, details?: ErrorDetails, cause?: unknown) {
    super(message, {
      code: "DATA_INTEGRITY_ERROR",
      statusCode: 500,
      details,
      expose: true,
      cause
    });
  }
}

export function toApplicationError(
  error: unknown,
  fallbackMessage = "Unexpected error.",
): ApplicationError {
  if (error instanceof ApplicationError) {
    return error;
  }

  if (error instanceof SyntaxError) {
    return new ValidationError(error.message);
  }

  if (error instanceof Error) {
    return new ApplicationError(error.message || fallbackMessage, {
      cause: error
    });
  }

  return new ApplicationError(fallbackMessage, {
    details: {
      value: stringifyUnknown(error)
    }
  });
}

export function toErrorPayload(error: unknown): ErrorPayload {
  const applicationError = toApplicationError(error);

  return {
    error: applicationError.expose ? applicationError.message : "Internal server error.",
    code: applicationError.code,
    ...(applicationError.details ? { details: applicationError.details } : {}),
    ...(applicationError.retryable ? { retryable: true } : {})
  };
}

export function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

export function extractResponseSnippet(value: string, limit = 280): string | undefined {
  const trimmed = value.trim();

  if (!trimmed) {
    return undefined;
  }

  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed;
}

export function stringifyUnknown(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (isRecord(error)) {
    try {
      return JSON.stringify(error);
    } catch {
      return "[object]";
    }
  }

  return String(error);
}

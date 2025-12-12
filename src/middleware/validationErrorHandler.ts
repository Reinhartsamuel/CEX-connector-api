import type { Context } from "hono";

/**
 * Custom error handler for Zod validation errors
 * Transforms raw Zod errors into user-friendly format
 */
export const validationErrorHandler = (result: any, c: Context) => {
  if (!result.success) {
    const errors = result.error.issues.map((issue: any) => ({
      field: issue.path.join('.'),
      message: issue.message,
      code: issue.code
    }));

    return c.json({
      success: false,
      error: {
        type: "VALIDATION_ERROR",
        message: "Invalid request data",
        details: errors
      }
    }, 400);
  }
};

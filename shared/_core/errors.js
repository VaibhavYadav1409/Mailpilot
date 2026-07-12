"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotFoundError = exports.ForbiddenError = exports.UnauthorizedError = exports.BadRequestError = exports.HttpError = void 0;
/**
 * Base HTTP error class with status code.
 * Throw this from route handlers to send specific HTTP errors.
 */
class HttpError extends Error {
    statusCode;
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
        this.name = "HttpError";
    }
}
exports.HttpError = HttpError;
// Convenience constructors
const BadRequestError = (msg) => new HttpError(400, msg);
exports.BadRequestError = BadRequestError;
const UnauthorizedError = (msg) => new HttpError(401, msg);
exports.UnauthorizedError = UnauthorizedError;
const ForbiddenError = (msg) => new HttpError(403, msg);
exports.ForbiddenError = ForbiddenError;
const NotFoundError = (msg) => new HttpError(404, msg);
exports.NotFoundError = NotFoundError;
//# sourceMappingURL=errors.js.map
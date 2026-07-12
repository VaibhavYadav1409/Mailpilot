"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.REFRESH_TOKEN_EXPIRES_MS = exports.JWT_ACCESS_EXPIRES_IN = exports.ROLE_RANK = exports.FORBIDDEN_ERR_MSG = exports.NOT_ADMIN_ERR_MSG = exports.UNAUTHED_ERR_MSG = exports.AXIOS_TIMEOUT_MS = exports.ONE_YEAR_MS = exports.COOKIE_NAME = void 0;
exports.COOKIE_NAME = "app_session_id";
exports.ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
exports.AXIOS_TIMEOUT_MS = 30_000;
exports.UNAUTHED_ERR_MSG = 'Please login (10001)';
exports.NOT_ADMIN_ERR_MSG = 'You do not have required permission (10002)';
exports.FORBIDDEN_ERR_MSG = 'You do not have required permission (10003)';
// Higher number = more senior. Used to check "can user A act on/assign role B".
exports.ROLE_RANK = {
    CEO: 5,
    COO: 4,
    ADMIN: 3,
    MANAGER: 2,
    EMPLOYEE: 1,
};
// jsonwebtoken `expiresIn` value for access tokens.
exports.JWT_ACCESS_EXPIRES_IN = "15m";
// Refresh token session lifetime, in milliseconds.
exports.REFRESH_TOKEN_EXPIRES_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
//# sourceMappingURL=const.js.map
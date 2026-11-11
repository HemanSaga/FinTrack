import type { Request, Response, NextFunction } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { ZodError } from 'zod';
import { User, type UserDocument } from '../models/index.js';
import { env, allowedOrigins } from '../config/env.js';
import { ApiError } from '../utils/core.js';
declare global {
  namespace Express {
    interface Request {
      account: UserDocument;
    }
  }
}
export const cookieName = 'ft_session';
const cookieOptions = {
  httpOnly: true,
  secure: env.production,
  sameSite: 'lax' as const,
  path: '/',
};
export function setSession(res: Response, user: UserDocument) {
  const token = jwt.sign({ sub: String(user._id), version: user.sessionVersion }, env.jwtSecret, {
    expiresIn: '7d',
    algorithm: 'HS256',
    issuer: 'fintrack',
    audience: 'fintrack-web',
  });
  res.cookie(cookieName, token, { ...cookieOptions, maxAge: 7 * 24 * 60 * 60 * 1000 });
}
export function clearSession(res: Response) {
  res.clearCookie(cookieName, cookieOptions);
}
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const token: unknown = req.cookies?.[cookieName];
  if (typeof token !== 'string')
    throw new ApiError(401, 'Please sign in to your workspace.', 'UNAUTHENTICATED');
  let payload: JwtPayload;
  try {
    const decoded = jwt.verify(token, env.jwtSecret, {
      algorithms: ['HS256'],
      issuer: 'fintrack',
      audience: 'fintrack-web',
    });
    if (typeof decoded === 'string') throw new Error();
    payload = decoded;
  } catch {
    throw new ApiError(401, 'Your session has expired. Please sign in again.', 'UNAUTHENTICATED');
  }
  const user = await User.findById(payload.sub).select('+sessionVersion');
  if (!user || user.sessionVersion !== payload.version)
    throw new ApiError(401, 'Please sign in again.', 'UNAUTHENTICATED');
  req.account = user;
  next();
}
export function checkOrigin(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('Origin');
  if (origin && !allowedOrigins.has(origin))
    return next(
      new ApiError(403, 'This request came from an untrusted origin.', 'ORIGIN_REJECTED'),
    );
  if (req.get('Sec-Fetch-Site') === 'cross-site')
    return next(new ApiError(403, 'Cross-site requests are not allowed.'));
  if (!req.is('application/json') && Number(req.get('Content-Length') || 0) > 0)
    return next(new ApiError(415, 'Send requests as application/json.'));
  next();
}
export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof ZodError)
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: error.issues[0]?.message || 'Please check your input.',
        fields: error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      },
    });
  if (error instanceof ApiError)
    return res
      .status(error.status)
      .json({ success: false, error: { code: error.code, message: error.message } });
  if (typeof error === 'object' && error && 'code' in error && error.code === 11000)
    return res.status(409).json({
      success: false,
      error: {
        code: 'DUPLICATE',
        message: 'That email or active bucket name is already in use.',
      },
    });
  if (error instanceof SyntaxError && 'body' in error)
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_JSON', message: 'The request body is not valid JSON.' },
    });
  console.error('Request failed:', error instanceof Error ? error.message : 'Unknown error');
  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'We couldn’t complete that request. Please try again.',
    },
  });
}

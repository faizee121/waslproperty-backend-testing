import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { loginRateLimiter, registerRateLimiter } from '../../middlewares/authRateLimit.js';
import { login, logout, refresh, register } from './auth.controller.js';

export const authRouter = Router();

authRouter.post('/register', registerRateLimiter, asyncHandler(register));
authRouter.post('/login', loginRateLimiter, asyncHandler(login));
authRouter.post('/refresh', asyncHandler(refresh));
authRouter.post('/logout', asyncHandler(logout));

import { Router } from 'express';
const router: Router = Router();
import { requireAuth, optionalAuth, requireCookieAuth } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import * as authController from '../controllers/auth.controller';
import {
  signupSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
  updateProfileSchema,
  createApiKeySchema,
  oauthTokenSchema,
} from '../validators/auth.validator';

// ============================================
// PUBLIC ROUTES (No authentication required)
// ============================================

// Local authentication
router.post('/signup', validate(signupSchema), authController.signup);
router.post('/login', validate(loginSchema), authController.login);
router.post('/refresh', authController.refresh);
router.post('/forgot-password', validate(forgotPasswordSchema), authController.forgotPassword);
router.post('/reset-password', validate(resetPasswordSchema), authController.resetPassword);

// Session status (works with or without auth)
router.get('/status', optionalAuth, authController.getStatus);

// Google OAuth
router.get('/google', authController.googleAuth);
router.get('/google/callback', authController.googleCallback);
router.post('/google/token', validate(oauthTokenSchema), authController.googleToken);

// Apple OAuth
router.get('/apple', authController.appleAuth);
router.post('/apple/callback', authController.appleCallback); // Apple uses POST
router.post('/apple/token', validate(oauthTokenSchema), authController.appleToken);

// Facebook OAuth
router.get('/facebook', authController.facebookAuth);
router.get('/facebook/callback', authController.facebookCallback);
router.post('/facebook/token', validate(oauthTokenSchema), authController.facebookToken);

// ============================================
// PROTECTED ROUTES (Authentication required)
// ============================================

// Session management
router.post('/logout', requireAuth, authController.logout);
router.post('/logout-all', requireAuth, authController.logoutAll);

// Profile management
router.get('/me', requireAuth, authController.getMe);
router.put('/me', requireAuth, validate(updateProfileSchema), authController.updateMe);
router.delete('/me', requireAuth, authController.deleteMe);

// Password management
router.post('/change-password', requireAuth, validate(changePasswordSchema), authController.changePassword);
router.post('/set-password', requireAuth, authController.setPassword);

// OAuth account linking (cookie auth only - browser operation)
router.post('/link/:provider', requireCookieAuth, validate(oauthTokenSchema), authController.linkOAuthAccount);
router.delete('/unlink/:provider', requireCookieAuth, authController.unlinkOAuthAccount);

// API Keys (for programmatic access)
router.post('/api-keys', requireAuth, validate(createApiKeySchema), authController.createApiKey);
router.get('/api-keys', requireAuth, authController.listApiKeys);
router.delete('/api-keys/:id', requireAuth, authController.deleteApiKey);

export default router;

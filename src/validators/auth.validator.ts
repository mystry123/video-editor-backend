import { z } from 'zod';

// Password validation regex
const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/;
const passwordMessage = 'Password must contain at least one uppercase letter, one lowercase letter, and one number';

export const signupSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address'),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(passwordRegex, passwordMessage),
    name: z.string().min(2, 'Name must be at least 2 characters').max(100).optional(),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(1, 'Password is required'),
  }),
});

export const forgotPasswordSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address'),
  }),
});

export const resetPasswordSchema = z.object({
  body: z.object({
    token: z.string().min(1, 'Reset token is required'),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(passwordRegex, passwordMessage),
  }),
});

export const changePasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(passwordRegex, passwordMessage),
  }),
});

export const refreshTokenSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(1, 'Refresh token is required'),
  }),
});

export const oauthTokenSchema = z.object({
  body: z.object({
    idToken: z.string().optional(),
    accessToken: z.string().optional(),
    code: z.string().optional(),
    // Apple specific
    user: z.object({
      name: z.object({
        firstName: z.string().optional(),
        lastName: z.string().optional(),
      }).optional(),
    }).optional(),
  }).refine(
    (data) => data.idToken || data.accessToken || data.code,
    { message: 'Either idToken, accessToken, or code is required' }
  ),
});

export const updateProfileSchema = z.object({
  body: z.object({
    name: z.string().min(2).max(100).optional(),
    avatarUrl: z.string().url().optional().or(z.literal('')),
  }),
});

export const createApiKeySchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(100),
    permissions: z.array(z.enum(['read', 'write', 'delete', 'admin'])).optional(),
    expiresAt: z.string().datetime().optional(),
  }),
});

import mongoose, { Schema, Document, Types } from 'mongoose';
import bcrypt from 'bcryptjs';
import { UserRole } from '../types';

// OAuth Provider types
export type OAuthProvider = 'google' | 'apple' | 'facebook';

export interface IOAuthAccount {
  provider: OAuthProvider;
  providerId: string;
  email?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date;
}

export interface IUser extends Document {
  _id: Types.ObjectId;
  email: string;
  password?: string; // Optional for OAuth users
  name?: string;
  avatarUrl?: string;
  role: UserRole;
  storageUsed: number;
  
  // Auth related
  isVerified: boolean;
  authProvider: 'local' | OAuthProvider; // Primary auth method
  oauthAccounts: IOAuthAccount[]; // Linked OAuth accounts
  
  // Password reset
  resetPasswordToken?: string;
  resetPasswordExpires?: Date;
  
  // Refresh tokens (for token rotation)
  refreshTokens: string[];
  
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  
  // Methods
  comparePassword(candidatePassword: string): Promise<boolean>;
  hasOAuthProvider(provider: OAuthProvider): boolean;
}

const OAuthAccountSchema = new Schema<IOAuthAccount>(
  {
    provider: { 
      type: String, 
      enum: ['google', 'apple', 'facebook'], 
      required: true 
    },
    providerId: { type: String, required: true },
    email: { type: String },
    accessToken: { type: String, select: false },
    refreshToken: { type: String, select: false },
    expiresAt: { type: Date },
  },
  { _id: false }
);

const UserSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    password: {
      type: String,
      minlength: 8,
      select: false, // Don't include password in queries by default
    },
    name: { type: String, trim: true },
    avatarUrl: { type: String },
    role: {
      type: String,
      enum: ['free', 'pro', 'team', 'admin'],
      default: 'free',
    },
    storageUsed: { type: Number, default: 0 },
    
    // Auth
    isVerified: { type: Boolean, default: false },
    authProvider: {
      type: String,
      enum: ['local', 'google', 'apple', 'facebook'],
      default: 'local',
    },
    oauthAccounts: [OAuthAccountSchema],
    
    // Password reset
    resetPasswordToken: { type: String, select: false },
    resetPasswordExpires: { type: Date, select: false },
    
    // Refresh tokens (store hashed)
    refreshTokens: { type: [String], select: false, default: [] },
    
    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

// Indexes
UserSchema.index({ 'oauthAccounts.provider': 1, 'oauthAccounts.providerId': 1 });

// Hash password before saving
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();

  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error: any) {
    next(error);
  }
});

// Compare password method
UserSchema.methods.comparePassword = async function (candidatePassword: string): Promise<boolean> {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

// Check if user has OAuth provider linked
UserSchema.methods.hasOAuthProvider = function (provider: OAuthProvider): boolean {
  return this.oauthAccounts.some((acc: IOAuthAccount) => acc.provider === provider);
};

export const User = mongoose.model<IUser>('User', UserSchema);

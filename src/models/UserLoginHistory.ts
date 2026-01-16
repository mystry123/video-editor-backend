import mongoose, { Schema, Document, Types, Model } from 'mongoose';

// ============================================================================
// Types
// ============================================================================

export interface ILoginMetadata {
  ip: string;
  userAgent: string;
  timestamp: Date;
  device: string;
  location?: {
    country?: string;
    city?: string;
    latitude?: number;
    longitude?: number;
  } | null;
  success: boolean;
  failureReason?: string;
  loginType: 'password' | 'oauth_google' | 'oauth_apple' | 'oauth_facebook' | 'signup';
}

export interface IUserLoginHistory extends Document {
  userId: Types.ObjectId;
  loginEvents: ILoginMetadata[];
  createdAt: Date;
  updatedAt: Date;
}

export interface IUserLoginHistoryModel extends Model<IUserLoginHistory> {
  findByUserId(userId: string): Promise<IUserLoginHistory | null>;
  addLoginEvent(userId: string, metadata: ILoginMetadata): Promise<void>;
  getRecentLogins(userId: string, limit?: number): Promise<ILoginMetadata[]>;
  getLoginStats(userId: string): Promise<{
    totalLogins: number;
    successfulLogins: number;
    failedLogins: number;
    uniqueIPs: number;
    devices: string[];
    locations: string[];
  }>;
}

// ============================================================================
// Schema
// ============================================================================

const LoginMetadataSchema = new Schema<ILoginMetadata>(
  {
    ip: { type: String, required: true },
    userAgent: { type: String, required: true },
    timestamp: { type: Date, required: true },
    device: { type: String, required: true },
    location: {
      country: { type: String },
      city: { type: String },
      latitude: { type: Number },
      longitude: { type: Number },
    },
    success: { type: Boolean, required: true, default: true },
    failureReason: { type: String },
    loginType: { 
      type: String, 
      enum: ['password', 'oauth_google', 'oauth_apple', 'oauth_facebook', 'signup'],
      required: true 
    },
  },
  { _id: false }
);

const UserLoginHistorySchema = new Schema<IUserLoginHistory, IUserLoginHistoryModel>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
      unique: true,
    },
    loginEvents: {
      type: [LoginMetadataSchema],
      default: [],
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ============================================================================
// Indexes
// ============================================================================

UserLoginHistorySchema.index({ userId: 1, 'loginEvents.timestamp': -1 });
UserLoginHistorySchema.index({ 'loginEvents.timestamp': -1 });
UserLoginHistorySchema.index({ 'loginEvents.ip': 1 });
UserLoginHistorySchema.index({ 'loginEvents.device': 1 });

// ============================================================================
// Virtuals
// ============================================================================

UserLoginHistorySchema.virtual('recentLogins', {
  ref: 'UserLoginHistory',
  localField: 'userId',
  foreignField: 'userId',
  justOne: false,
});

// ============================================================================
// Static Methods
// ============================================================================

UserLoginHistorySchema.statics.findByUserId = async function(userId: string): Promise<IUserLoginHistory | null> {
  return this.findOne({ userId }).sort({ 'loginEvents.timestamp': -1 });
};

UserLoginHistorySchema.statics.addLoginEvent = async function(
  userId: string, 
  metadata: ILoginMetadata
): Promise<void> {
  await this.findOneAndUpdate(
    { userId },
    { 
      $push: { 
        loginEvents: { 
          $each: [metadata], 
          $position: 0, // Add to beginning
          $slice: 50 // Keep only last 50 events
        } 
      },
      $setOnInsert: { userId }
    },
    { upsert: true, new: true }
  );
};

UserLoginHistorySchema.statics.getRecentLogins = async function(
  userId: string, 
  limit: number = 10
): Promise<ILoginMetadata[]> {
  const history = await this.findOne({ userId });
  if (!history) return [];
  
  return history.loginEvents
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, limit);
};

UserLoginHistorySchema.statics.getLoginStats = async function(userId: string) {
  const history = await this.findOne({ userId });
  if (!history) {
    return {
      totalLogins: 0,
      successfulLogins: 0,
      failedLogins: 0,
      uniqueIPs: 0,
      devices: [],
      locations: [],
    };
  }

  const events = history.loginEvents;
  const successfulLogins = events.filter(e => e.success).length;
  const failedLogins = events.filter(e => !e.success).length;
  const uniqueIPs = new Set(events.map(e => e.ip)).size;
  const devices = [...new Set(events.map(e => e.device))];
  const locations = [...new Set(events.map(e => e.location?.country || 'Unknown').filter(Boolean))];

  return {
    totalLogins: events.length,
    successfulLogins,
    failedLogins,
    uniqueIPs,
    devices,
    locations,
  };
};

// ============================================================================
// Model
// ============================================================================

export const UserLoginHistory = mongoose.model<IUserLoginHistory, IUserLoginHistoryModel>(
  'UserLoginHistory',
  UserLoginHistorySchema
);

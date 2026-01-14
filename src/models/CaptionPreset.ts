import mongoose, { Schema, Document, Types, Model } from 'mongoose';

// ============================================================================
// Types - Matching Frontend CaptionPreset Interface
// ============================================================================

/**
 * Highlight style for the currently spoken word
 */
export type HighlightStyle = 
  | 'none'
  | 'color'        // Change text color
  | 'background'   // Add background color
  | 'scale'        // Scale up the word
  | 'glow'         // Add glow effect
  | 'underline';   // Underline the word

/**
 * Display mode for captions
 */
export type DisplayMode = 'word' | 'line' | 'tiktok' | 'karaoke';

/**
 * Caption styles - text appearance
 */
export interface ICaptionStyles {
  // Font
  fontFamily: string;
  fontWeight: number;
  fontStyle?: 'normal' | 'italic';
  
  // Colors
  fillColor: string;              // Main text color
  highlightColor: string;         // Active word color
  inactiveColor?: string;         // Already spoken words
  inactiveOpacity?: number;       // Opacity for inactive words (0-1)
  upcomingColor?: string;         // Future words color
  upcomingOpacity?: number;       // Opacity for upcoming words (0-1)
  
  // Highlight
  highlightStyle: HighlightStyle;
  highlightBackgroundColor?: string;  // For background highlight style
  highlightScale?: number;            // For scale highlight style (e.g., 1.2)
  
  // Stroke (outline)
  strokeEnabled?: boolean;
  strokeColor?: string;
  strokeWidth?: number;
  strokeOpacity?: number;
  
  // Shadow
  shadowEnabled?: boolean;
  shadowColor?: string;
  shadowOpacity?: number;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
  shadowBlur?: number;
  
  // Background box
  backgroundColor?: string;
  backgroundXPadding?: number;     // Horizontal padding as percentage
  backgroundYPadding?: number;     // Vertical padding as percentage
  backgroundBorderRadius?: number; // Border radius in pixels
  
  // Display
  displayMode: DisplayMode;
  lineHeight?: number;
}

/**
 * Preview styles for the preset card in UI
 */
export interface IPreviewStyles {
  fontFamily: string;
  textColor: string;
  highlightColor: string;
  strokeColor?: string;
  strokeWidth?: number;
  backgroundColor?: string;
  backgroundPadding?: number;
  backgroundRadius?: number;
  italic?: boolean;
  fontWeight?: number;
  textShadow?: string;
  gradient?: string;
}

/**
 * Main CaptionPreset document interface
 */
export interface ICaptionPreset extends Document {
  _id: Types.ObjectId;
  
  // Ownership
  userId?: Types.ObjectId;    // null for system presets
  
  // Basic info
  name: string;
  description?: string;
  thumbnail?: string;         // Preview image URL
  category?: string;          // e.g., 'bold-impact', 'modern-sans', 'neon-glow'
  tags: string[];
  
  // Flags
  isSystem: boolean;          // Built-in preset (not editable by users)
  isPublic: boolean;          // Visible to other users
  isDefault?: boolean;        // Default preset for new projects
  
  // Actual caption styling
  styles: ICaptionStyles;
  
  // Preview styling for UI cards
  previewStyles: IPreviewStyles;
  
  // Stats
  usageCount: number;
  
  createdAt: Date;
  updatedAt: Date;
}

export interface ICaptionPresetModel extends Model<ICaptionPreset> {
  findSystemPresets(): Promise<ICaptionPreset[]>;
  findByCategory(category: string): Promise<ICaptionPreset[]>;
  findUserPresets(userId: string): Promise<ICaptionPreset[]>;
  findAvailableForUser(userId: string): Promise<ICaptionPreset[]>;
  incrementUsage(presetId: string): Promise<void>;
  getDefault(): Promise<ICaptionPreset | null>;
}

// ============================================================================
// Schema
// ============================================================================

const CaptionStylesSchema = new Schema<ICaptionStyles>(
  {
    // Font
    fontFamily: { type: String, required: true, default: 'Inter' },
    fontWeight: { type: Number, required: true, default: 700 },
    fontStyle: { 
      type: String, 
      enum: ['normal', 'italic'], 
      default: 'normal' 
    },
    
    // Colors
    fillColor: { type: String, required: true, default: '#FFFFFF' },
    highlightColor: { type: String, required: true, default: '#FFFF00' },
    inactiveColor: { type: String },
    inactiveOpacity: { type: Number, min: 0, max: 1, default: 1 },
    upcomingColor: { type: String },
    upcomingOpacity: { type: Number, min: 0, max: 1 },
    
    // Highlight
    highlightStyle: {
      type: String,
      enum: ['none', 'color', 'background', 'scale', 'glow', 'underline'],
      default: 'color',
    },
    highlightBackgroundColor: { type: String },
    highlightScale: { type: Number },
    
    // Stroke
    strokeEnabled: { type: Boolean, default: false },
    strokeColor: { type: String, default: '#000000' },
    strokeWidth: { type: Number, default: 0 },
    strokeOpacity: { type: Number, min: 0, max: 1, default: 1 },
    
    // Shadow
    shadowEnabled: { type: Boolean, default: false },
    shadowColor: { type: String, default: '#000000' },
    shadowOpacity: { type: Number, min: 0, max: 1, default: 0.5 },
    shadowOffsetX: { type: Number, default: 0 },
    shadowOffsetY: { type: Number, default: 2 },
    shadowBlur: { type: Number, default: 4 },
    
    // Background
    backgroundColor: { type: String },
    backgroundXPadding: { type: Number, default: 10 },
    backgroundYPadding: { type: Number, default: 5 },
    backgroundBorderRadius: { type: Number, default: 10 },
    
    // Display
    displayMode: {
      type: String,
      enum: ['word', 'line', 'tiktok', 'karaoke'],
      default: 'line',
    },
    lineHeight: { type: Number, default: 1 },
  },
  { _id: false }
);

const PreviewStylesSchema = new Schema<IPreviewStyles>(
  {
    fontFamily: { type: String, required: true },
    textColor: { type: String, required: true },
    highlightColor: { type: String, required: true },
    strokeColor: { type: String },
    strokeWidth: { type: Number },
    backgroundColor: { type: String },
    backgroundPadding: { type: Number },
    backgroundRadius: { type: Number },
    italic: { type: Boolean },
    fontWeight: { type: Number },
    textShadow: { type: String },
    gradient: { type: String },
  },
  { _id: false }
);

const CaptionPresetSchema = new Schema<ICaptionPreset, ICaptionPresetModel>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    
    name: { 
      type: String, 
      required: true,
      trim: true,
      maxlength: 100,
    },
    description: { 
      type: String,
      trim: true,
      maxlength: 500,
    },
    thumbnail: { type: String },
    category: { 
      type: String,
      index: true,
    },
    tags: {
      type: [String],
      default: [],
    },
    
    isSystem: { type: Boolean, default: false, index: true },
    isPublic: { type: Boolean, default: false },
    isDefault: { type: Boolean, default: false },
    
    styles: {
      type: CaptionStylesSchema,
      required: true,
    },
    
    previewStyles: {
      type: PreviewStylesSchema,
      required: true,
    },
    
    usageCount: { type: Number, default: 0 },
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

CaptionPresetSchema.index({ isSystem: 1, usageCount: -1 });
CaptionPresetSchema.index({ userId: 1, createdAt: -1 });
CaptionPresetSchema.index({ category: 1, isSystem: 1 });
CaptionPresetSchema.index({ tags: 1 });
CaptionPresetSchema.index({ name: 'text', description: 'text', tags: 'text' });

// ============================================================================
// Statics
// ============================================================================

CaptionPresetSchema.statics.findSystemPresets = function() {
  return this.find({ isSystem: true }).sort({ usageCount: -1 });
};

CaptionPresetSchema.statics.findByCategory = function(category: string) {
  return this.find({ 
    category, 
    $or: [{ isSystem: true }, { isPublic: true }] 
  }).sort({ usageCount: -1 });
};

CaptionPresetSchema.statics.findUserPresets = function(userId: string) {
  return this.find({ 
    userId: new Types.ObjectId(userId), 
    isSystem: false 
  }).sort({ createdAt: -1 });
};

CaptionPresetSchema.statics.findAvailableForUser = function(userId: string) {
  return this.find({
    $or: [
      { isSystem: true },
      { userId: new Types.ObjectId(userId) },
      { isPublic: true },
    ],
  }).sort({ isSystem: -1, usageCount: -1 });
};

CaptionPresetSchema.statics.incrementUsage = async function(presetId: string) {
  await this.findByIdAndUpdate(presetId, { $inc: { usageCount: 1 } });
};

CaptionPresetSchema.statics.getDefault = function() {
  return this.findOne({ isDefault: true, isSystem: true });
};

// ============================================================================
// Export
// ============================================================================

export const CaptionPreset = mongoose.model<ICaptionPreset, ICaptionPresetModel>(
  'CaptionPreset',
  CaptionPresetSchema
);
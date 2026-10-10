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
export type DisplayMode = 'word' | 'line' | 'tiktok' | 'karaoke' | 'static';

/**
 * Caption styles - text appearance
 */
export interface ICaptionStyles {
  // Layout
  wordsPerLine?: number;
  linesPerPage?: number;
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
  slug?: string;              // Stable key of a system preset (the seed upserts by it)
  isPublic: boolean;          // Visible to other users
  isDefault?: boolean;        // Default preset for new projects
  
  // Actual caption styling
  styles: ICaptionStyles;
  /** Version of the style format in `styles` (schemas/captionStyle) */
  schemaVersion?: number;
  
  // Preview styling for UI cards
  previewStyles?: IPreviewStyles;
  
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
    slug: { type: String },
    isPublic: { type: Boolean, default: false },
    isDefault: { type: Boolean, default: false },
    
    // The caption style, validated by schemas/captionStyle before every save
    // (a fixed sub-schema here silently dropped any setting it didn't list,
    // e.g. text case or animations). Existing documents keep their stored
    // values; new settings need no migration.
    styles: {
      type: Schema.Types.Mixed,
      required: true,
    },
    /** Version of the style format in `styles` (schemas/captionStyle) */
    schemaVersion: { type: Number, default: 1 },

    // Card decoration from before cards were drawn from `styles`; optional
    previewStyles: {
      type: PreviewStylesSchema,
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
CaptionPresetSchema.index({ slug: 1 }, { unique: true, partialFilterExpression: { slug: { $type: 'string' } } });
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
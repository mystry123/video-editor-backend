// ============================================================================
// Composition Types - Matching Frontend Editor Structure
// ============================================================================

import { CaptionSettings } from '../models/Caption';

/**
 * Project settings for the composition
 */
export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  duration: number;
  name?: string;
  backgroundColor?: string;
  outputFormat?: "mp4" | "webm" | "mov";
}

/**
 * Base element properties shared by all element types
 */
export interface BaseElement {
  id: string;
  type: string;
  name?: string;
  track: number;
  time: number;
  duration: number;
  x: string | number;
  y: string | number;
  width: string | number;
  height: string | number;
  xAnchor?: number;
  yAnchor?: number;
  opacity?: number;
  visible?: boolean;
  locked?: boolean;
  zIndex?: number;
}

/**
 * Video element
 */
export interface VideoElement extends BaseElement {
  type: "video";
  source: string;
  fileId?: string;
  volume?: number;
  offset?: number;
  fit?: "contain" | "cover" | "fill";
}

/**
 * Audio element
 */
export interface AudioElement extends BaseElement {
  type: "audio";
  source: string;
  fileId?: string;
  volume?: number;
  offset?: number;
}

/**
 * Caption word with timing
 */
export interface CaptionWord {
  word: string;
  startMs: number;
  endMs: number;
}

/**
 * Transcription data for captions
 */
export interface TranscriptionData {
  words: CaptionWord[];
  language?: string;
}

/**
 * Caption element - matches frontend CaptionElement
 */
export interface CaptionElement extends BaseElement {
  type: "caption";
  sourceElementId?: string;

  // Transcription data
  transcription: TranscriptionData;

  // Display settings
  displayMode: "word" | "line" | "tiktok" | "karaoke";
  wordsPerLine: number;
  linesPerPage: number;

  // Text styling (vmin-based)
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  fontStyle?: "normal" | "italic";
  lineHeight: number;
  letterSpacing?: number;

  // Colors
  fillColor: string;
  highlightStyle:
    | "none"
    | "color"
    | "background"
    | "scale"
    | "glow"
    | "underline";
  highlightColor: string;
  highlightBackgroundColor?: string;
  highlightScale?: number;
  inactiveColor?: string;
  inactiveOpacity?: number;
  upcomingColor?: string;
  upcomingOpacity?: number;

  // Stroke
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
  backgroundXPadding?: number;
  backgroundYPadding?: number;
  backgroundBorderRadius?: number;

  // Text alignment
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
}

/**
 * Any element type
 */
export type AnyElement = VideoElement | AudioElement | CaptionElement;

/**
 * Full composition structure
 */
export interface Composition {
  project: ProjectSettings;
  elements: AnyElement[];
}

// ============================================================================
// Input Types for Caption Generation
// ============================================================================

/**
 * Video metadata extracted from source
 */
export interface VideoMetadata {
  width: number;
  height: number;
  duration: number;
  fps?: number;
}

/**
 * Input for caption generation service - ID-based (primary method)
 * Service will fetch file and transcription from database
 */
export interface CaptionGenerationInput {
  // File ID to fetch video info from database (required)
  fileId: string;

  // Transcription ID to fetch words from database (required)
  transcriptionId: string;

  // Preset to apply (optional - uses default if not provided)
  presetId?: string;

  // Override settings (optional)
  settings?: CaptionSettings;

  // Project name (optional)
  name?: string;
}

/**
 * Alternative input with direct data (for internal use or when data is already loaded)
 */
export interface CaptionGenerationDirectInput {
  // Video source (direct)
  videoUrl: string;
  videoFileId?: string;
  videoMetadata: VideoMetadata;

  // Transcription (direct)
  transcription: TranscriptionData;

  // Preset
  presetId?: string;
  preset?: {
    styles: any;
    previewStyles?: any;
  };

  // Settings
  settings?: CaptionSettings;

  // Project name
  name?: string;
}

/**
 * Output from caption generation service
 */
export interface CaptionGenerationOutput {
  composition: Composition;
  metadata: {
    fileId: string;
    transcriptionId: string;
    videoWidth: number;
    videoHeight: number;
    videoDuration: number;
    wordCount: number;
    presetId?: string;
    presetName?: string;
    isPortrait: boolean;
  };
}

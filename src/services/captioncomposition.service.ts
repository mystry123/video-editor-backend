import { v4 as uuidv4 } from 'uuid';
import { Types } from 'mongoose';
import {
  Composition,
  ProjectSettings,
  VideoElement,
  CaptionElement,
  CaptionWord,
  TranscriptionData,
  CaptionGenerationInput,
  CaptionGenerationOutput,
  CaptionGenerationDirectInput,
  VideoMetadata,
} from '../types/composition'
import { CaptionSettings } from '../models/Caption';
import { CaptionPreset, ICaptionStyles } from '../models/CaptionPreset';
import { File, IFile } from '../models/File';
import { Transcription, ITranscription, ITranscriptionWord } from '../models/Transcription';

// ============================================================================
// Caption Composition Service
// ============================================================================

/**
 * Service for generating caption compositions
 * Can be used via API endpoint or internally by other services
 */
export class CaptionCompositionService {
  
  /**
   * Generate a complete composition with video + captions
   * Fetches file and transcription data from database using IDs
   * 
   * @param input - fileId, transcriptionId, preset, and settings
   * @returns Composition JSON ready for rendering
   */
  static async generate(input: CaptionGenerationInput): Promise<CaptionGenerationOutput> {
    const {
      fileId,
      transcriptionId,
      presetId,
      settings,
      name,
    } = input;

    // =========================================================================
    // 1. Fetch File from Database
    // =========================================================================
    
    const file = await File.findById(fileId);
    if (!file) {
      throw new Error(`File not found: ${fileId}`);
    }

    if (file.status !== 'ready') {
      throw new Error(`File is not ready. Status: ${file.status}`);
    }

    if (!file.cdnUrl) {
      throw new Error('File does not have a CDN URL');
    }

    // =========================================================================
    // 2. Fetch Transcription from Database
    // =========================================================================
    
    const transcription = await Transcription.findById(transcriptionId);
    if (!transcription) {
      throw new Error(`Transcription not found: ${transcriptionId}`);
    }

    if (transcription.status !== 'completed') {
      throw new Error(`Transcription is not completed. Status: ${transcription.status}`);
    }

    if (!transcription.words || transcription.words.length === 0) {
      throw new Error('Transcription has no words');
    }

    // =========================================================================
    // 3. Extract Video Metadata
    // =========================================================================
    
    const videoMetadata: VideoMetadata = {
      width: file.metadata?.width || 1920,
      height: file.metadata?.height || 1080,
      duration: file.metadata?.duration || 60,
      fps: 30,
    };

    // =========================================================================
    // 4. Convert Transcription Words to Caption Format
    // =========================================================================
    
    const captionWords: CaptionWord[] = transcription.words
      .filter((w: ITranscriptionWord) => w.type === 'word')
      .map((w: ITranscriptionWord) => ({
        word: w.text,
        startMs: Math.round(w.start * 1000),  // Convert seconds to ms
        endMs: Math.round(w.end * 1000),
      }));

    const transcriptionData: TranscriptionData = {
      words: captionWords,
      language: transcription.language || 'en',
    };

    // =========================================================================
    // 5. Generate Composition using Direct Method
    // =========================================================================
    
    const directInput: CaptionGenerationDirectInput = {
      videoUrl: file.cdnUrl,
      videoFileId: fileId,
      videoMetadata,
      transcription: transcriptionData,
      presetId,
      settings,
      name: name || file.originalName || 'Captioned Video',
    };

    const result = await CaptionCompositionService.generateDirect(directInput);

    // Add IDs to metadata
    return {
      composition: result.composition,
      metadata: {
        ...result.metadata,
        fileId,
        transcriptionId,
      },
    };
  }

  /**
   * Generate composition with direct data (internal use or when data is pre-loaded)
   */
  static async generateDirect(input: CaptionGenerationDirectInput): Promise<CaptionGenerationOutput> {
    const {
      videoUrl,
      videoFileId,
      videoMetadata,
      transcription,
      presetId,
      preset,
      settings,
      name = 'Captioned Video',
    } = input;

    const { width, height, duration, fps = 30 } = videoMetadata;
    const isPortrait = height > width;

    // =========================================================================
    // 1. Get Preset Styles
    // =========================================================================
    
    let presetStyles: ICaptionStyles;
    let presetName: string | undefined;
    
    if (preset?.styles) {
      presetStyles = preset.styles;
    } else if (presetId) {
      const dbPreset = await CaptionPreset.findById(presetId);
      if (!dbPreset) {
        throw new Error(`Preset not found: ${presetId}`);
      }
      presetStyles = dbPreset.styles;
      presetName = dbPreset.name;
      await CaptionPreset.incrementUsage(presetId);
    } else {
      const defaultPreset = await CaptionPreset.getDefault();
      if (defaultPreset) {
        presetStyles = defaultPreset.styles;
        presetName = defaultPreset.name;
      } else {
        presetStyles = CaptionCompositionService.getDefaultStyles();
      }
    }

    // =========================================================================
    // 2. Calculate Caption Settings
    // =========================================================================
    
    const captionSettings = CaptionCompositionService.calculateCaptionSettings(
      width,
      height,
      isPortrait,
      settings
    );

    // =========================================================================
    // 3. Create Project Settings
    // =========================================================================
    
    const project: ProjectSettings = {
      width,
      height,
      fps,
      duration,
      name,
      backgroundColor: '#000000',
      outputFormat: settings?.outputFormat || 'mp4',
    };

    // =========================================================================
    // 4. Create Video Element
    // =========================================================================
    
    const videoElement: VideoElement = {
      id: uuidv4(),
      type: 'video',
      name: 'Source Video',
      source: videoUrl,
      fileId: videoFileId,
      track: 1,
      time: 0,
      duration,
      x: '50%',
      y: '50%',
      width: '100%',
      height: '100%',
      xAnchor: 50,
      yAnchor: 50,
      opacity: 1,
      visible: true,
      volume: 100,
      fit: 'contain',
    };

    // =========================================================================
    // 5. Create Caption Element
    // =========================================================================
    
    const lastWord = transcription.words[transcription.words.length - 1];
    const captionDuration = lastWord ? lastWord.endMs / 1000 : duration;

    const captionElement: CaptionElement = {
      id: uuidv4(),
      type: 'caption',
      name: 'Captions',
      sourceElementId: videoElement.id,
      track: 2,
      time: 0,
      duration: Math.min(captionDuration, duration),
      
      // Position & dimensions
      x: '50%',
      y: captionSettings.yPosition,
      width: `${captionSettings.widthPercent}%`,
      height: `${captionSettings.heightPercent}%`,
      xAnchor: 50,
      yAnchor: 50,
      opacity: 1,
      visible: true,
      
      // Transcription
      transcription,
      
      // Display settings
      displayMode: presetStyles.displayMode || 'line',
      wordsPerLine: captionSettings.wordsPerLine,
      linesPerPage: captionSettings.linesPerPage,
      
      // Text styling from preset
      fontSize: settings?.fontSize || captionSettings.fontSize,
      fontFamily: presetStyles.fontFamily,
      fontWeight: presetStyles.fontWeight,
      fontStyle: presetStyles.fontStyle,
      lineHeight: presetStyles.lineHeight || 1.2,
      letterSpacing: 0,
      
      // Colors from preset or settings
      fillColor: presetStyles.fillColor,
      highlightStyle: presetStyles.highlightStyle,
      highlightColor: settings?.highlightColor || presetStyles.highlightColor,
      highlightBackgroundColor: presetStyles.highlightBackgroundColor,
      highlightScale: presetStyles.highlightScale,
      inactiveColor: settings?.inactiveColor || presetStyles.inactiveColor,
      inactiveOpacity: settings?.inactiveOpacity ?? presetStyles.inactiveOpacity,
      upcomingColor: settings?.upcomingColor || presetStyles.upcomingColor,
      upcomingOpacity: settings?.upcomingOpacity ?? presetStyles.upcomingOpacity,
      
      // Stroke from preset
      strokeEnabled: presetStyles.strokeEnabled,
      strokeColor: presetStyles.strokeColor,
      strokeWidth: presetStyles.strokeWidth,
      strokeOpacity: presetStyles.strokeOpacity,
      
      // Shadow from preset
      shadowEnabled: presetStyles.shadowEnabled,
      shadowColor: presetStyles.shadowColor,
      shadowOpacity: presetStyles.shadowOpacity,
      shadowOffsetX: presetStyles.shadowOffsetX,
      shadowOffsetY: presetStyles.shadowOffsetY,
      shadowBlur: presetStyles.shadowBlur,
      
      // Background from preset or settings
      backgroundColor: settings?.backgroundColor || presetStyles.backgroundColor,
      backgroundXPadding: settings?.backgroundXPadding ?? presetStyles.backgroundXPadding,
      backgroundYPadding: settings?.backgroundYPadding ?? presetStyles.backgroundYPadding,
      backgroundBorderRadius: settings?.backgroundBorderRadius ?? presetStyles.backgroundBorderRadius,
      
      // Alignment
      textAlign: 'center',
      verticalAlign: 'middle',
    };

    // =========================================================================
    // 6. Build Final Composition
    // =========================================================================
    
    const composition: Composition = {
      project,
      elements: [videoElement, captionElement],
    };

    return {
      composition,
      metadata: {
        fileId: videoFileId || '',
        transcriptionId: '',
        videoWidth: width,
        videoHeight: height,
        videoDuration: duration,
        wordCount: transcription.words.length,
        presetId,
        presetName,
        isPortrait,
      },
    };
  }

  /**
   * Apply a preset to an existing composition
   */
  static async applyPreset(
    composition: Composition,
    presetId: string
  ): Promise<Composition> {
    const preset = await CaptionPreset.findById(presetId);
    if (!preset) {
      throw new Error(`Preset not found: ${presetId}`);
    }

    const styles = preset.styles;

    const updatedElements = composition.elements.map(el => {
      if (el.type !== 'caption') return el;

      const caption = el as CaptionElement;
      return {
        ...caption,
        fontFamily: styles.fontFamily,
        fontWeight: styles.fontWeight,
        fontStyle: styles.fontStyle,
        fillColor: styles.fillColor,
        highlightStyle: styles.highlightStyle,
        highlightColor: styles.highlightColor,
        highlightBackgroundColor: styles.highlightBackgroundColor,
        inactiveColor: styles.inactiveColor,
        inactiveOpacity: styles.inactiveOpacity,
        strokeEnabled: styles.strokeEnabled,
        strokeColor: styles.strokeColor,
        strokeWidth: styles.strokeWidth,
        strokeOpacity: styles.strokeOpacity,
        shadowEnabled: styles.shadowEnabled,
        shadowColor: styles.shadowColor,
        shadowOpacity: styles.shadowOpacity,
        shadowOffsetX: styles.shadowOffsetX,
        shadowOffsetY: styles.shadowOffsetY,
        shadowBlur: styles.shadowBlur,
        backgroundColor: styles.backgroundColor,
        backgroundXPadding: styles.backgroundXPadding,
        backgroundYPadding: styles.backgroundYPadding,
        backgroundBorderRadius: styles.backgroundBorderRadius,
        displayMode: styles.displayMode || caption.displayMode,
        lineHeight: styles.lineHeight || caption.lineHeight,
      } as CaptionElement;
    });

    await CaptionPreset.incrementUsage(presetId);

    return {
      ...composition,
      elements: updatedElements,
    };
  }

  /**
   * Update captions with new transcription (by transcription ID)
   */
  static async updateCaptionsById(
    composition: Composition,
    transcriptionId: string,
    presetId?: string
  ): Promise<Composition> {
    const transcription = await Transcription.findById(transcriptionId);
    if (!transcription) {
      throw new Error(`Transcription not found: ${transcriptionId}`);
    }

    if (transcription.status !== 'completed') {
      throw new Error(`Transcription is not completed. Status: ${transcription.status}`);
    }

    const captionWords: CaptionWord[] = transcription.words!
      .filter((w: ITranscriptionWord) => w.type === 'word')
      .map((w: ITranscriptionWord) => ({
        word: w.text,
        startMs: Math.round(w.start * 1000),
        endMs: Math.round(w.end * 1000),
      }));

    const transcriptionData: TranscriptionData = {
      words: captionWords,
      language: transcription.language || 'en',
    };

    return CaptionCompositionService.updateCaptions(composition, transcriptionData, presetId);
  }

  /**
   * Update captions with direct transcription data
   */
  static async updateCaptions(
    composition: Composition,
    transcription: TranscriptionData,
    presetId?: string
  ): Promise<Composition> {
    const captionIndex = composition.elements.findIndex(el => el.type === 'caption');
    if (captionIndex === -1) {
      throw new Error('No caption element found in composition');
    }

    let presetStyles: ICaptionStyles | undefined;
    if (presetId) {
      const preset = await CaptionPreset.findById(presetId);
      if (preset) {
        presetStyles = preset.styles;
      }
    }

    const existingCaption = composition.elements[captionIndex] as CaptionElement;
    const updatedCaption: CaptionElement = {
      ...existingCaption,
      transcription,
      ...(presetStyles && {
        fontFamily: presetStyles.fontFamily,
        fontWeight: presetStyles.fontWeight,
        fillColor: presetStyles.fillColor,
        highlightStyle: presetStyles.highlightStyle,
        highlightColor: presetStyles.highlightColor,
        strokeEnabled: presetStyles.strokeEnabled,
        strokeColor: presetStyles.strokeColor,
        strokeWidth: presetStyles.strokeWidth,
        shadowEnabled: presetStyles.shadowEnabled,
        shadowColor: presetStyles.shadowColor,
        shadowBlur: presetStyles.shadowBlur,
        backgroundColor: presetStyles.backgroundColor,
        backgroundBorderRadius: presetStyles.backgroundBorderRadius,
      }),
    };

    const updatedElements = [...composition.elements];
    updatedElements[captionIndex] = updatedCaption;

    return {
      ...composition,
      elements: updatedElements,
    };
  }

  /**
   * Calculate optimal caption settings based on video dimensions
   */
  private static calculateCaptionSettings(
    width: number,
    height: number,
    isPortrait: boolean,
    overrides: Partial<CaptionSettings> = {}
  ): {
    fontSize: number;
    wordsPerLine: number;
    linesPerPage: number;
    widthPercent: number;
    heightPercent: number;
    yPosition: string;
    highlightColor: string;
    inactiveColor: string;
    upcomingColor: string;
    inactiveOpacity: number;
    upcomingOpacity: number;
    backgroundColor?: string;
    backgroundXPadding: number;
    backgroundYPadding: number;
    backgroundBorderRadius: number;
  } {
    const baseSettings = isPortrait
      ? {
          fontSize: 5.5,
          wordsPerLine: 4,
          linesPerPage: 2,
          widthPercent: 90,
          heightPercent: 15,
          yPosition: '85%',
        }
      : {
          fontSize: 4,
          wordsPerLine: 6,
          linesPerPage: 2,
          widthPercent: 80,
          heightPercent: 20,
          yPosition: '88%',
        };

    let yPosition = baseSettings.yPosition;
    if (overrides.position) {
      switch (overrides.position) {
        case 'top':
          yPosition = '15%';
          break;
        case 'center':
          yPosition = '50%';
          break;
        case 'bottom':
          yPosition = isPortrait ? '85%' : '88%';
          break;
      }
    }

    return {
      fontSize: overrides.fontSize || baseSettings.fontSize,
      wordsPerLine: overrides.wordsPerLine || baseSettings.wordsPerLine,
      linesPerPage: overrides.linesPerPage || baseSettings.linesPerPage,
      widthPercent: baseSettings.widthPercent,
      heightPercent: baseSettings.heightPercent,
      yPosition,
      highlightColor: overrides.highlightColor || "#FFFF00",
      inactiveColor: overrides.inactiveColor || "#FFFFFF",
      upcomingColor: overrides.upcomingColor || "#FFFFFF",
      inactiveOpacity: overrides.inactiveOpacity ?? 0.6,
      upcomingOpacity: overrides.upcomingOpacity ?? 0.3,
      backgroundColor: overrides.backgroundColor,
      backgroundXPadding: overrides.backgroundXPadding ?? 10,
      backgroundYPadding: overrides.backgroundYPadding ?? 5,
      backgroundBorderRadius: overrides.backgroundBorderRadius ?? 10,
    };
  }

  /**
   * Get default caption styles
   */
  private static getDefaultStyles(): ICaptionStyles {
    return {
      fontFamily: 'Inter',
      fontWeight: 700,
      fillColor: '#FFFFFF',
      highlightStyle: 'color',
      highlightColor: '#FFFF00',
      inactiveColor: '#FFFFFF',
      inactiveOpacity: 0.6,
      strokeEnabled: true,
      strokeColor: '#000000',
      strokeWidth: 3,
      strokeOpacity: 1,
      displayMode: 'line',
      lineHeight: 1.2,
    };
  }

  /**
   * Validate composition structure
   */
  static validateComposition(composition: Composition): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!composition.project) {
      errors.push('Missing project settings');
    } else {
      if (!composition.project.width || composition.project.width <= 0) {
        errors.push('Invalid project width');
      }
      if (!composition.project.height || composition.project.height <= 0) {
        errors.push('Invalid project height');
      }
      if (!composition.project.duration || composition.project.duration <= 0) {
        errors.push('Invalid project duration');
      }
    }

    if (!composition.elements || !Array.isArray(composition.elements)) {
      errors.push('Missing or invalid elements array');
    } else {
      const hasVideo = composition.elements.some(el => el.type === 'video');
      if (!hasVideo) {
        errors.push('Composition must have at least one video element');
      }

      composition.elements.forEach((el, index) => {
        if (!el.id) errors.push(`Element ${index} missing id`);
        if (!el.type) errors.push(`Element ${index} missing type`);
        if (el.type === 'caption') {
          const caption = el as CaptionElement;
          if (!caption.transcription?.words?.length) {
            errors.push(`Caption element ${index} missing transcription words`);
          }
        }
      });
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Export composition as JSON
   */
  static toJSON(composition: Composition): string {
    return JSON.stringify(composition, null, 2);
  }

  /**
   * Parse composition from JSON
   */
  static fromJSON(json: string): Composition {
    const parsed = JSON.parse(json);
    const validation = CaptionCompositionService.validateComposition(parsed);
    if (!validation.valid) {
      throw new Error(`Invalid composition: ${validation.errors.join(', ')}`);
    }
    return parsed;
  }
}
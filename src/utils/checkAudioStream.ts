import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

interface TranscriptionValidation {
  canTranscribe: boolean;
  reason?: string;
  audioInfo?: {
    hasAudio: boolean;
    codec: string;
    channels: number;
    sampleRate: number;
    duration: number;
    bitRate: number;
  };
}

export async function canTranscribe(url: string): Promise<TranscriptionValidation> {
  try {
    // 1. Check if file has audio stream and get audio details
    const { stdout } = await execAsync(
      `ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,channels,sample_rate,duration,bit_rate -show_entries format=duration -of json "${url}"`
    );
    
    const data = JSON.parse(stdout);
    
    // No audio stream found
    if (!data.streams || data.streams.length === 0) {
      return {
        canTranscribe: false,
        reason: 'No audio stream found. File is silent.',
      };
    }
    
    const audio = data.streams[0];
    const duration = parseFloat(audio.duration || data.format?.duration || '0');
    const sampleRate = parseInt(audio.sample_rate || '0', 10);
    const channels = parseInt(audio.channels || '0', 10);
    const bitRate = parseInt(audio.bit_rate || '0', 10);
    
    // 2. Check minimum duration (at least 0.5 seconds)
    if (duration < 0.5) {
      return {
        canTranscribe: false,
        reason: `Audio too short (${duration.toFixed(2)}s). Minimum 0.5 seconds required.`,
      };
    }
    
    // 3. Check maximum duration (e.g., 4 hours limit for most transcription services)
    const maxDuration = 4 * 60 * 60; // 4 hours in seconds
    if (duration > maxDuration) {
      return {
        canTranscribe: false,
        reason: `Audio too long (${(duration / 3600).toFixed(2)} hours). Maximum 4 hours allowed.`,
      };
    }
    
    // 4. Check sample rate (most transcription services need at least 8kHz)
    if (sampleRate > 0 && sampleRate < 8000) {
      return {
        canTranscribe: false,
        reason: `Sample rate too low (${sampleRate}Hz). Minimum 8000Hz required for good transcription.`,
      };
    }
    
    // 5. Check if audio has actual content (not just silence)
    const hasSpeech = await detectAudioContent(url);
    if (!hasSpeech) {
      return {
        canTranscribe: false,
        reason: 'Audio appears to be silent or contains no detectable speech.',
      };
    }
    
    return {
      canTranscribe: true,
      audioInfo: {
        hasAudio: true,
        codec: audio.codec_name,
        channels,
        sampleRate,
        duration,
        bitRate,
      },
    };
    
  } catch (error) {
    console.error('Error validating transcription:', error);
    return {
      canTranscribe: false,
      reason: 'Failed to analyze audio. File may be corrupted or inaccessible.',
    };
  }
}

/**
 * Detect if audio has actual content (not silence)
 * Uses ffmpeg to measure volume levels
 */
export async function detectAudioContent(url: string): Promise<boolean> {
  try {
    // Analyze first 30 seconds for audio content
    const { stderr } = await execAsync(
      `ffmpeg -t 30 -i "${url}" -af "volumedetect" -f null - 2>&1`
    );
    
    // Parse mean_volume from output
    // Example: mean_volume: -25.0 dB
    const meanVolumeMatch = stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/);
    
    if (meanVolumeMatch) {
      const meanVolume = parseFloat(meanVolumeMatch[1]);
      
      // If mean volume is below -60dB, it's essentially silence
      // Typical speech is between -20dB to -40dB
      if (meanVolume < -55) {
        return false; // Too quiet, likely silence
      }
      return true;
    }
    
    // If we can't detect volume, assume it has content
    return true;
    
  } catch (error) {
    console.error('Error detecting audio content:', error);
    // If detection fails, assume it has content and let transcription handle it
    return true;
  }
}
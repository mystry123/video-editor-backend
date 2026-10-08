// services/renderInput.service.ts
//
// What a render receives: the template's {project, elements}, with request
// variables applied, checked before anything is queued or sent to Lambda.
// Every problem found is reported with the element it's about, so the editor
// can say "Image 'Logo' is still uploading" instead of a render failing later.

import { ApiError } from '../utils/ApiError';
import { deepMerge } from '../utils/helpers';
import { assertPublicUrl } from '../utils/safeRequest';

/** Element types whose `source` the renderer (Chrome in Lambda) fetches. */
const MEDIA_ELEMENT_TYPES = new Set(['image', 'video', 'audio', 'gif', 'lottie']);
/** Other URL fields a media element may carry. */
const EXTRA_URL_FIELDS = ['src', 'url', 'poster'];

/** Output formats the render pipeline supports (see CODEC_BY_FORMAT in render.service). */
export const SUPPORTED_OUTPUT_FORMATS = new Set(['mp4', 'webm', 'gif']);

const MAX_DIMENSION = 7680; // 8K wide
const MAX_DURATION_SECONDS = 4 * 60 * 60;
const MAX_FPS = 120;

export interface RenderInputIssue {
  /** Element id, when the issue is about an element. */
  elementId?: string;
  /** Human-readable element label: its name, or its type and position. */
  element?: string;
  message: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPublicMediaUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    assertPublicUrl(value);
    return true;
  } catch {
    return false;
  }
}

function label(element: any, index: number): string {
  if (typeof element?.name === 'string' && element.name.trim()) return `"${element.name.trim()}"`;
  const type = typeof element?.type === 'string' ? element.type : 'element';
  return `${type.charAt(0).toUpperCase()}${type.slice(1)} #${index + 1}`;
}

function describeBadUrl(value: string): string {
  if (value.startsWith('blob:')) return 'is still uploading (it only exists in this browser). Wait for the upload to finish, then render again.';
  if (value.startsWith('data:')) return 'is embedded data, not an uploaded file. Upload it, then render again.';
  return 'has a media link the renderer can\'t reach. Replace it with an uploaded file.';
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

function applyToElement(element: any, override: unknown, name: string): any {
  if (isPlainObject(override)) {
    // Object overrides can set any field, so check the URLs they produce.
    const merged = deepMerge(element, override);
    if (MEDIA_ELEMENT_TYPES.has(merged.type)) {
      for (const field of ['source', ...EXTRA_URL_FIELDS]) {
        const value = merged[field];
        if (value !== undefined && value !== null && value !== '' && !isPublicMediaUrl(value)) {
          throw ApiError.withCode(400, 'INVALID_MEDIA_URL', `variables.${name}: "${field}" must be a public http(s) URL.`);
        }
      }
    }
    return merged;
  }
  const type: string = element.type;
  if (type === 'text' || type === 'caption') return { ...element, text: String(override) };
  if (MEDIA_ELEMENT_TYPES.has(type)) {
    if (!isPublicMediaUrl(override)) {
      throw ApiError.withCode(400, 'INVALID_MEDIA_URL', `variables.${name}: media override must be a public http(s) URL.`);
    }
    // The composition reads `source` for every media type.
    return { ...element, source: override };
  }
  return { ...element, value: override };
}

/**
 * Applies `variables` to elements by element name, including elements nested
 * in compositions. Returns the new elements and the variable names that
 * matched no element (reported back as warnings).
 */
export function applyVariables(
  elements: unknown,
  variables: Record<string, unknown> | undefined
): { elements: any[]; unmatched: string[] } {
  const list = Array.isArray(elements) ? elements : [];
  if (!variables || Object.keys(variables).length === 0) return { elements: list, unmatched: [] };

  const matched = new Set<string>();
  const walk = (items: any[]): any[] =>
    items.map((element) => {
      if (!isPlainObject(element)) return element;
      let next: any = element;
      const name = typeof element.name === 'string' ? element.name : undefined;
      if (name && Object.prototype.hasOwnProperty.call(variables, name)) {
        matched.add(name);
        next = applyToElement(element, variables[name], name);
      }
      if (Array.isArray(next.elements)) next = { ...next, elements: walk(next.elements) };
      return next;
    });

  const result = walk(list);
  return { elements: result, unmatched: Object.keys(variables).filter((key) => !matched.has(key)) };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function checkElements(items: unknown[], issues: RenderInputIssue[]): void {
  items.forEach((element: any, index) => {
    if (!isPlainObject(element)) {
      issues.push({ element: `Element #${index + 1}`, message: 'is not a valid element.' });
      return;
    }
    const who = label(element, index);
    const elementId = typeof element.id === 'string' ? element.id : undefined;

    if (MEDIA_ELEMENT_TYPES.has(element.type as string)) {
      const inline = element.type === 'lottie' && isPlainObject(element.animationData);
      const source = element.source;
      if (!inline) {
        if (typeof source !== 'string' || source.trim() === '') {
          issues.push({ elementId, element: who, message: 'has no media. Add a file or remove the element.' });
        } else if (!isPublicMediaUrl(source)) {
          issues.push({ elementId, element: who, message: describeBadUrl(source) });
        }
      }
      for (const field of EXTRA_URL_FIELDS) {
        const value = element[field];
        if (typeof value === 'string' && value !== '' && !isPublicMediaUrl(value)) {
          issues.push({ elementId, element: who, message: describeBadUrl(value) });
        }
      }
    }

    if (Array.isArray(element.elements)) checkElements(element.elements, issues);
  });
}

/**
 * Checks a render's input. Throws 422 INVALID_RENDER_INPUT listing every
 * problem (the message names the first; `details` has them all).
 */
export function validateRenderInput(inputProps: any): void {
  const issues: RenderInputIssue[] = [];
  const project = isPlainObject(inputProps?.project) ? inputProps.project : {};

  const outputFormat = (project.outputFormat as string) || 'mp4';
  if (!SUPPORTED_OUTPUT_FORMATS.has(outputFormat)) {
    throw ApiError.withCode(422, 'UNSUPPORTED_OUTPUT_FORMAT', `Exporting as ${outputFormat} isn't supported yet. Choose MP4, WebM or GIF.`);
  }

  const duration = Number(project.duration);
  const width = Number(project.width);
  const height = Number(project.height);
  const fps = project.fps === undefined ? 30 : Number(project.fps);
  if (!(duration > 0) || !(width > 0) || !(height > 0)) {
    throw ApiError.withCode(422, 'EMPTY_PROJECT', 'This project has no duration or size set. Add content to the timeline and try again.');
  }
  if (duration > MAX_DURATION_SECONDS) {
    issues.push({ message: `The video is longer than ${MAX_DURATION_SECONDS / 3600} hours, the longest we can render.` });
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    issues.push({ message: `The project is larger than ${MAX_DIMENSION}px, the largest size we can render.` });
  }
  if (!(fps > 0) || fps > MAX_FPS) {
    issues.push({ message: `The frame rate must be between 1 and ${MAX_FPS} fps.` });
  }

  const elements = Array.isArray(inputProps?.elements) ? inputProps.elements : [];
  if (elements.length === 0) {
    throw ApiError.withCode(422, 'EMPTY_PROJECT', 'The timeline is empty. Add something to render.');
  }
  checkElements(elements, issues);

  if (issues.length > 0) {
    const first = issues[0];
    const more = issues.length > 1 ? ` (and ${issues.length - 1} more problem${issues.length > 2 ? 's' : ''})` : '';
    throw ApiError.withCode(
      422,
      'INVALID_RENDER_INPUT',
      `${first.element ? `${first.element} ` : ''}${first.message}${more}`,
      issues
    );
  }
}

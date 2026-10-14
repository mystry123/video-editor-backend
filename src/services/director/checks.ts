// services/director/checks.ts
//
// Hard checks on a compiled edit, before anyone looks at it: things that are
// simply wrong (overlapping clips on a track, text past the end, titles in
// the app-button zones of a tall frame, an empty edit). The review loop sends
// these back to the crew; here they are listed in plain words.

import { clipLength, type CompiledEdit } from './compile';

export function editProblems(edit: CompiledEdit): string[] {
  const problems: string[] = [];
  const { project, elements } = edit;
  const duration = Number(project.duration) || 0;
  if (!elements.length) problems.push('The edit is empty.');
  const tall = Number(project.height) > Number(project.width);

  // Clips on one track must not overlap unless the later one has a transition
  const byTrack = new Map<number, Array<Record<string, any>>>();
  for (const e of elements) (byTrack.get(Number(e.track)) ?? byTrack.set(Number(e.track), []).get(Number(e.track))!).push(e);
  for (const [track, list] of byTrack) {
    const sorted = [...list].sort((a, b) => a.time - b.time);
    for (let i = 1; i < sorted.length; i++) {
      const prevEnd = sorted[i - 1].time + clipLength(sorted[i - 1]);
      const overlap = prevEnd - sorted[i].time;
      if (overlap > 0.01 && !(sorted[i].transition && overlap <= sorted[i].transition.duration + 0.01)) {
        problems.push(`Track ${track}: "${sorted[i].name}" starts ${overlap.toFixed(2)}s before "${sorted[i - 1].name}" ends.`);
      }
    }
  }

  // Gaps in the cut show black
  const cut = (edit.groups.cut ?? []).map((id) => elements.find((e) => e.id === id)!).filter(Boolean).sort((a, b) => a.time - b.time);
  for (let i = 1; i < cut.length; i++) {
    const gap = cut[i].time - (cut[i - 1].time + clipLength(cut[i - 1]));
    if (gap > 0.05) problems.push(`There is ${gap.toFixed(2)}s of black between clips ${i} and ${i + 1}.`);
  }

  for (const e of elements) {
    const end = e.time + clipLength(e);
    if (e.time < -0.001) problems.push(`"${e.name}" starts before the edit.`);
    if (end > duration + 0.05) problems.push(`"${e.name}" runs past the end.`);
    if ((e.type === 'video' || e.type === 'audio') && !e.loop && e.trimDuration !== undefined && e.trimStart + e.trimDuration > Number(e.duration) + 0.05) {
      problems.push(`"${e.name}" plays past the end of its file.`);
    }
    if (e.type === 'text' && tall) {
      const y = parseFloat(String(e.y));
      if (y < 12 || y > 82) problems.push(`Title "${e.text}" sits where app buttons cover it (y ${y}%).`);
    }
  }
  return problems;
}

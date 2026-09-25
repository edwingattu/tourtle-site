import { supabase } from './auth.js';

// Optimized media helpers for Photo/Video + Voice
export function pickPhotoMime() {
  if (typeof document === 'undefined') return 'image/jpeg';
  const c = document.createElement('canvas');
  return c.toDataURL('image/webp').startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg';
}

export function pickVideoMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const cands = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  for (const m of cands) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

export function pickAudioMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'];
  for (const m of cands) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

export async function compressPhoto(fileOrBlob, maxEdge = 1600) {
  const blob = fileOrBlob instanceof Blob ? fileOrBlob : new Blob([fileOrBlob]);
  const mime = pickPhotoMime();
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const out = await new Promise((r) => canvas.toBlob(r, mime, 0.78));
    return out || blob;
  } catch {
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function uploadMedia(path, blob, contentType) {
  const { data, error } = await supabase.storage.from('tourtle-media').upload(path, blob, {
    contentType: contentType || blob.type || 'application/octet-stream',
    upsert: true,
    cacheControl: '3600',
  });
  if (error) throw error;
  const { data: pub } = supabase.storage.from('tourtle-media').getPublicUrl(path);
  return pub?.publicUrl || data.path;
}

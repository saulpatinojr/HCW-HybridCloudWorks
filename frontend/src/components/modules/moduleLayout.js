// Layout helpers shared by the inline article modules: how wide a module is
// and which side it sits on, and the embed address of a YouTube link.

export function getYouTubeEmbedUrl(input = '') {
  const raw = String(input || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, '');
    let videoId = '';

    if (host === 'youtube.com' || host === 'm.youtube.com') {
      if (url.pathname === '/watch') {
        videoId = url.searchParams.get('v') || '';
      } else if (url.pathname.startsWith('/shorts/')) {
        videoId = url.pathname.split('/')[2] || '';
      } else if (url.pathname.startsWith('/embed/')) {
        videoId = url.pathname.split('/')[2] || '';
      }
    } else if (host === 'youtu.be') {
      videoId = url.pathname.replace('/', '');
    }

    if (!videoId) return '';
    return `https://www.youtube.com/embed/${videoId}`;
  } catch {
    return '';
  }
}

export function getModuleLayoutClass(align = 'left', paired = false) {
  if (paired) {
    return 'w-full max-w-none';
  }

  if (align === 'right') {
    return 'ml-auto max-w-[28rem]';
  }

  if (align === 'all') {
    return 'w-full';
  }

  return 'mr-auto max-w-[28rem]';
}

export function getPictureFrameClass(align = 'left', paired = false) {
  if (paired) {
    return 'w-full max-w-none';
  }

  if (align === 'all') {
    return 'w-full';
  }

  return 'w-full max-w-[28rem]';
}

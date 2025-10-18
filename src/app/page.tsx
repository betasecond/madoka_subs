'use client'

import NoSSRWrapper from './NoSSRWrapper';
import dynamic from 'next/dynamic';

const FFmpegPanel = dynamic(() => import('@/components/FFmpegPanel'), {
  ssr: false,
  loading: () => (
    <div className="min-h-screen bg-neutral-950 text-white grid place-items-center">
      <p className="text-sm text-white/60">FFmpeg 模块加载中…</p>
    </div>
  ),
});

export default function Page() {
  return (
    <NoSSRWrapper>
      <FFmpegPanel />
    </NoSSRWrapper>
  );
}


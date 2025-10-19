'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { format } from 'date-fns';
import { nanoid } from 'nanoid';

import { useFFmpegClient, type FFmpegInstance, type FFmpegResources } from '@/hooks/useFFmpegClient';

type StepKey =
  | 'init'
  | 'select'
  | 'metadata'
  | 'subtitle'
  | 'audio'
  | 'upload'
  | 'asr'
  | 'translate'
  | 'done';

type StepState = {
  key: StepKey;
  label: string;
  startedAt?: number;
  finishedAt?: number;
  extra?: Record<string, string | number>;
};

const steps: StepState[] = [
  { key: 'init', label: '初始化 FFmpeg' },
  { key: 'select', label: '选择视频' },
  { key: 'metadata', label: '解析元信息' },
  { key: 'subtitle', label: '解析内嵌字幕' },
  { key: 'audio', label: '提取音频' },
  { key: 'upload', label: '上传音频' },
  { key: 'asr', label: '语音转写' },
  { key: 'translate', label: '字幕翻译' },
  { key: 'done', label: '完成' },
];

type StageLog = {
  id: string;
  stage: StepKey;
  message: string;
  level: 'info' | 'warn' | 'error';
  timestamp: number;
};

type MetaInfo = {
  duration?: number;
  format?: string;
  videoCodec?: string;
  audioCodec?: string;
};

type SubtitleResult =
  | { hasEmbedded: true; srt: string }
  | { hasEmbedded: false; srt?: undefined };

const useSteps = () => {
  const [progress, setProgress] = useState<StepState[]>(() => steps.map((step) => ({ ...step })));

  const start = useCallback((key: StepKey, extra?: StepState['extra']) => {
    setProgress((prev) =>
      prev.map((step) =>
        step.key === key
          ? { ...step, startedAt: Date.now(), finishedAt: undefined, extra }
          : step
      )
    );
  }, []);

  const finish = useCallback((key: StepKey, extra?: StepState['extra']) => {
    setProgress((prev) =>
      prev.map((step) =>
        step.key === key ? { ...step, finishedAt: Date.now(), extra } : step
      )
    );
  }, []);

  const reset = useCallback(() => {
    setProgress(steps.map((step) => ({ ...step, startedAt: undefined, finishedAt: undefined, extra: undefined })));
  }, []);

  return { progress, start, finish, reset };
};

const useLogger = () => {
  const [logs, setLogs] = useState<StageLog[]>([]);

  const push = useCallback((stage: StepKey, message: string, level: StageLog['level'] = 'info') => {
    setLogs((prev) => [
      ...prev,
      { id: nanoid(), stage, message, level, timestamp: Date.now() },
    ]);
  }, []);

  const clear = useCallback(() => setLogs([]), []);

  return { logs, push, clear };
};

const runAndCollectLogs = async (
  ffmpeg: FFmpegInstance,
  args: string[],
  { allowNonZero, onLog }: { allowNonZero?: boolean; onLog?: (message: string) => void } = {}
) => {
  let output = '';
  const handler = ({ message }: { message: string }) => {
    output += `${message}\n`;
    onLog?.(message);
  };
  ffmpeg.on('log', handler);
  let exitCode = 0;
  try {
    exitCode = await ffmpeg.exec(args);
    if (exitCode !== 0 && !allowNonZero) {
      throw new Error(`FFmpeg 运行失败，退出码 ${exitCode}`);
    }
    return { output, exitCode };
  } finally {
    ffmpeg.off('log', handler);
  }
};

const parseDuration = (duration?: number) => {
  if (!duration) return '未知';
  const minutes = Math.floor(duration / 60);
  const seconds = Math.floor(duration % 60);
  return `${minutes} 分 ${seconds} 秒`;
};

const formatLogTime = (timestamp: number) => format(timestamp, 'HH:mm:ss');

export default function FFmpegPanel() {
  const videoInputRef = useRef<HTMLInputElement>(null);
  const resourcesRef = useRef<FFmpegResources | null>(null);
  const { load, reset: resetFfmpegClient, isLoaded } = useFFmpegClient();
  const { progress, start, finish, reset } = useSteps();
  const { logs, push, clear } = useLogger();
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoName, setVideoName] = useState('');
  const [metaInfo, setMetaInfo] = useState<MetaInfo>({});
  const [extractedSrt, setExtractedSrt] = useState('');
  const [translatedSrt, setTranslatedSrt] = useState('');
  const [fontSize, setFontSize] = useState(16);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const isDark = theme === 'dark';
  const rootClasses = isDark ? 'min-h-screen bg-neutral-950 text-white' : 'min-h-screen bg-white text-neutral-900';
  const headerClasses = isDark ? 'border-b border-white/10 bg-black/40 backdrop-blur' : 'border-b border-black/10 bg-white/70 backdrop-blur';
  const cardClasses = isDark ? 'rounded-xl border border-white/10 bg-white/5 p-6' : 'rounded-xl border border-black/10 bg-black/5 p-6';
  const buttonPrimaryClasses = isDark
    ? 'rounded bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:bg-white/20'
    : 'rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:bg-black/20';
  const headerButtonClass = isDark
    ? 'rounded border border-white/20 px-3 py-1 hover:border-white'
    : 'rounded border border-black/20 px-3 py-1 hover:border-black';
  const ASR_LANGUAGE_OPTIONS = useMemo(
    () => [
      { label: '自动检测（中/英及常见方言）', value: 'auto' },
      { label: '英语 en-US', value: 'en-US' },
      { label: '日语 ja-JP', value: 'ja-JP' },
      { label: '印尼语 id-ID', value: 'id-ID' },
      { label: '西班牙语 es-MX', value: 'es-MX' },
      { label: '葡萄牙语 pt-BR', value: 'pt-BR' },
      { label: '德语 de-DE', value: 'de-DE' },
      { label: '法语 fr-FR', value: 'fr-FR' },
      { label: '韩语 ko-KR', value: 'ko-KR' },
      { label: '菲律宾语 fil-PH', value: 'fil-PH' },
      { label: '马来语 ms-MY', value: 'ms-MY' },
      { label: '泰语 th-TH', value: 'th-TH' },
      { label: '阿拉伯语 ar-SA', value: 'ar-SA' },
    ],
    []
  );
  const [asrLanguage, setAsrLanguage] = useState<string>('auto');
  const TRANSLATE_LANGUAGE_OPTIONS = useMemo(
    () => [
      { label: '中文 zh-CN', value: 'zh-CN' },
      { label: '英文 en-US', value: 'en-US' },
      { label: '日语 ja-JP', value: 'ja-JP' },
      { label: '韩语 ko-KR', value: 'ko-KR' },
      { label: '法语 fr-FR', value: 'fr-FR' },
      { label: '西班牙语 es-MX', value: 'es-MX' },
      { label: '葡萄牙语 pt-BR', value: 'pt-BR' },
      { label: '德语 de-DE', value: 'de-DE' },
      { label: '印尼语 id-ID', value: 'id-ID' },
      { label: '马来语 ms-MY', value: 'ms-MY' },
      { label: '泰语 th-TH', value: 'th-TH' },
      { label: '阿拉伯语 ar-SA', value: 'ar-SA' },
    ],
    []
  );
  const [targetLanguage, setTargetLanguage] = useState<string>('zh-CN');

  const uploadMutation = useMutation<{ key: string }, Error, FormData>({
    mutationFn: async (form) => {
      const response = await fetch('/api/upload', {
        method: 'POST',
        body: form,
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      return (await response.json()) as { key: string };
    },
  });

  const asrSubmitMutation = useMutation<{ jobId: string }, Error, { key: string; language?: string }>({
    mutationFn: async (input) => {
      const response = await fetch('/api/asr/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      return (await response.json()) as { jobId: string };
    },
  });

  const translateMutation = useMutation<{ srt: string }, Error, { srt: string; targetLanguage?: string; note?: string }>({
    mutationFn: async (input) => {
      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(input),
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      return (await response.json()) as { srt: string };
    },
  });

  const logStage = useCallback(
    (stage: StepKey, message: string, level: StageLog['level'] = 'info') => {
      push(stage, message, level);
    },
    [push]
  );

  const resetAll = useCallback(() => {
    reset();
    clear();
    setMetaInfo({});
    setVideoFile(null);
    setVideoName('');
    setExtractedSrt('');
    setTranslatedSrt('');
  }, [reset, clear]);

  const handleVideoSelect = useCallback(
    (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      resetAll();
      const file = fileList[0];
      setVideoFile(file);
      setVideoName(file.name.replace(/\.[^.]+$/, ''));
      logStage('select', `选择文件: ${file.name}`);
    },
    [resetAll, logStage]
  );

  const ensureFfmpeg = useCallback(async () => {
    const cached = resourcesRef.current;
    if (cached && cached.ffmpeg.loaded) {
      return cached;
    }

    start('init', { status: cached ? 'reloading' : 'loading' });
    logStage('init', cached ? '重新加载 FFmpeg 核心…' : '开始加载 FFmpeg 核心文件…');

    try {
      const resources = await load((message) => {
        logStage('init', message);
      });
      resourcesRef.current = resources;
      finish('init', { status: 'ready' });
      logStage('init', 'FFmpeg 已准备就绪');
      return resources;
    } catch (error) {
      const message = (error as Error).message ?? '未知错误';
      logStage('init', `FFmpeg 初始化失败: ${message}`, 'error');
      finish('init', { status: 'failed' });
      throw error;
    }
  }, [finish, load, logStage, start]);

  useEffect(() => {
    let cancelled = false;
    ensureFfmpeg().catch(() => {
      if (!cancelled) {
        // 初始化错误已在 ensureFfmpeg 内部记录日志
      }
    });
    return () => {
      cancelled = true;
      resourcesRef.current = null;
      resetFfmpegClient();
    };
  }, [ensureFfmpeg, resetFfmpegClient]);

  const reloadFFmpeg = useCallback(async () => {
    resourcesRef.current = null;
    resetFfmpegClient();
    await ensureFfmpeg();
  }, [ensureFfmpeg, resetFfmpegClient]);

  const parseMetadata = useCallback(async (ffmpeg: FFmpegInstance, filename: string) => {
    const { output } = await runAndCollectLogs(ffmpeg, ['-i', filename, '-hide_banner'], {
      allowNonZero: true,
      onLog: (message) => logStage('metadata', message),
    });

    const durationMatch = output.match(/Duration: (\d{2}:\d{2}:\d{2}\.\d{2})/);
    const formatMatch = output.match(/Input #0, (.+?),/);
    const videoCodecMatch = output.match(/Video: ([^,]+)/);
    const audioCodecMatch = output.match(/Audio: ([^,]+)/);

    return {
      duration: durationMatch
        ? durationMatch[1].split(':').reduce((acc, value, index) => {
            const time = parseFloat(value);
            return acc + time * Math.pow(60, 2 - index);
          }, 0)
        : undefined,
      format: formatMatch ? formatMatch[1] : undefined,
      videoCodec: videoCodecMatch ? videoCodecMatch[1] : undefined,
      audioCodec: audioCodecMatch ? audioCodecMatch[1] : undefined,
    } satisfies MetaInfo;
  }, []);

  const extractSubtitles = useCallback(async (ffmpeg: FFmpegInstance, filename: string) => {
    const { output: detectLogs } = await runAndCollectLogs(ffmpeg, ['-i', filename], {
      allowNonZero: true,
      onLog: (message) => logStage('subtitle', message),
    }).catch(() => ({ output: '' }));

    const hasSubtitle = /Stream #0:\d+(?:\((.*?)\))?: Subtitle/.test(detectLogs);
    if (!hasSubtitle) {
      return { hasEmbedded: false } satisfies SubtitleResult;
    }

    const outputName = 'embedded_subs.srt';
    const { exitCode } = await runAndCollectLogs(ffmpeg, ['-i', filename, '-map', '0:s:0', outputName], {
      allowNonZero: false,
      onLog: (message) => logStage('subtitle', message),
    });

    if (exitCode !== 0) {
      throw new Error('提取内嵌字幕失败');
    }

    const data = (await ffmpeg.readFile(outputName)) as Uint8Array;
    return {
      hasEmbedded: true,
      srt: new TextDecoder().decode(data),
    } satisfies SubtitleResult;
  }, []);

  const extractAudio = useCallback(async (ffmpeg: FFmpegInstance, filename: string) => {
    const outputName = 'output_audio.m4a';
    const { exitCode } = await runAndCollectLogs(ffmpeg, ['-i', filename, '-vn', '-acodec', 'copy', outputName], {
      allowNonZero: false,
      onLog: (message) => logStage('audio', message),
    });
    if (exitCode !== 0) {
      throw new Error('提取音频失败');
    }
    const rawAudioData = (await ffmpeg.readFile(outputName)) as Uint8Array;
    const audioData = new Uint8Array(rawAudioData);
    return new Blob([audioData.buffer], { type: 'audio/mp4' });
  }, []);

  const runPipeline = useCallback(async () => {
    const resources = await ensureFfmpeg().catch((error) => {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      logStage('init', `FFmpeg 初始化失败: ${message}`, 'error');
      return null;
    });
    if (!resources || !resources.ffmpeg || !resources.ffmpeg.loaded) {
      logStage('init', 'FFmpeg 尚未加载完成，请稍后再试', 'warn');
      return;
    }

    const video = videoFile;
    if (!video) {
      logStage('select', '请先选择视频文件', 'warn');
      videoInputRef.current?.focus();
      return;
    }

    clear();
    reset();

    start('select');
    finish('select', {
      filename: video.name,
      size: `${(video.size / (1024 * 1024)).toFixed(2)} MB`,
    });

    const { ffmpeg, fetchFile } = resources;

    start('metadata');
    await ffmpeg.writeFile(video.name, await fetchFile(video));
    const meta = await parseMetadata(ffmpeg, video.name);
    setMetaInfo(meta);
    finish('metadata', {
      duration: meta.duration ? parseDuration(meta.duration) : '',
      format: meta.format ?? '',
    });

    start('subtitle');
    const subtitleResult = await extractSubtitles(ffmpeg, video.name).catch((error) => {
      logStage('subtitle', `提取字幕失败: ${(error as Error).message}`, 'error');
      return { hasEmbedded: false } satisfies SubtitleResult;
    });

    if (subtitleResult.hasEmbedded) {
      setExtractedSrt(subtitleResult.srt);
      logStage('subtitle', '检测到内嵌字幕，已提取。');
      finish('subtitle', { found: 'yes' });
    } else {
      logStage('subtitle', '未检测到内嵌字幕，准备调用 ASR。', 'warn');
      finish('subtitle', { found: 'no' });
    }

    let currentSrt = subtitleResult.hasEmbedded ? subtitleResult.srt : '';

    if (!currentSrt) {
      start('audio');
      const audioBlob = await extractAudio(ffmpeg, video.name);
      finish('audio', {
        type: audioBlob.type,
        size: `${(audioBlob.size / (1024 * 1024)).toFixed(2)} MB`,
      });

      start('upload');
      const form = new FormData();
      form.append('file', audioBlob, `${videoName}.m4a`);
      const uploadResult = await uploadMutation.mutateAsync(form);
      finish('upload', { key: uploadResult.key });

      start('asr');
      const selectedLanguageCode = asrLanguage === 'auto' ? undefined : asrLanguage;
      const { jobId } = await asrSubmitMutation.mutateAsync({ key: uploadResult.key, language: selectedLanguageCode });
      logStage('asr', `任务已提交，jobId: ${jobId}`);
      let srtFromAsr = '';
      const maxAttempts = 30;
      for (let i = 1; i <= maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, Math.min(10000, 1000 * i)));
        const res = await fetch(`/api/asr/${encodeURIComponent(jobId)}`);
        if (!res.ok) {
          logStage('asr', `查询失败(${i}/${maxAttempts}): ${res.status}`, 'warn');
          continue;
        }
        const data = (await res.json()) as { status: 'processing' | 'completed' | 'failed'; srt?: string; message?: string };
        if (data.status === 'processing') {
          logStage('asr', `处理中(${i}/${maxAttempts})…`);
          continue;
        }
        if (data.status === 'failed') {
          throw new Error(data.message || 'ASR 任务失败');
        }
        if (data.status === 'completed' && data.srt) {
          srtFromAsr = data.srt;
          break;
        }
      }
      if (!srtFromAsr) {
        throw new Error('ASR 轮询超时，未获取到结果');
      }
      setExtractedSrt(srtFromAsr);
      currentSrt = srtFromAsr;
      finish('asr');
    }

    if (!currentSrt) {
      throw new Error('未获取到任何字幕文本');
    }

    start('translate');
    const translation = await translateMutation.mutateAsync({
      srt: currentSrt,
      targetLanguage,
      note: translationNote.trim() || undefined,
    });
    setTranslatedSrt(translation.srt);
    finish('translate');

    finish('done');
  }, [
    videoFile,
    videoName,
    clear,
    reset,
    start,
    finish,
    logStage,
    parseMetadata,
    extractSubtitles,
    extractAudio,
    uploadMutation,
    asrSubmitMutation,
    translateMutation,
    ensureFfmpeg,
  ]);

  const previewSrt = useMemo(() => translatedSrt || extractedSrt, [translatedSrt, extractedSrt]);
  const [translationNote, setTranslationNote] = useState('');

  return (
    <div className={rootClasses}>
      <header className={headerClasses}>
        <div className="mx-auto flex max-w-5xl flex-col gap-2 px-6 py-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Madoka Subs</h1>
            <p className={isDark ? 'text-sm text-white/60' : 'text-sm text-neutral-600'}>浏览器端 FFmpeg + Cloudflare R2 + ASR + 大模型翻译 一站式字幕工作流</p>
          </div>
          <div className={isDark ? 'flex items-center gap-3 text-sm text-white/70' : 'flex items-center gap-3 text-sm text-neutral-700'}>
            <span>FFmpeg wasm {isLoaded ? '已加载' : '待加载'}</span>
            <button
              className={headerButtonClass}
              onClick={() => {
                reloadFFmpeg().catch((error) => {
                  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
                  logStage('init', `重新加载 FFmpeg 失败: ${message}`, 'error');
                });
              }}
            >
              重置 FFmpeg
            </button>
            <button
              className={headerButtonClass}
              onClick={() => setTheme(isDark ? 'light' : 'dark')}
            >
              {isDark ? '切换日间' : '切换夜间'}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-5xl gap-6 px-6 py-10 lg:grid-cols-[2fr_1fr]">
        <section className="space-y-6">
          <div className={cardClasses}>
            <h2 className="text-lg font-semibold">1. 上传视频</h2>
            <p className={isDark ? 'mt-1 text-sm text-white/60' : 'mt-1 text-sm text-neutral-600'}>选择本地视频文件，系统将自动解析并抽取字幕。</p>
            <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center">
              <input
                ref={videoInputRef}
                type="file"
                accept="video/*"
                onChange={(event) => handleVideoSelect(event.target.files)}
                className="text-sm"
              />
              <div className="flex items-center gap-2 text-sm">
                <label className="text-white/60">识别语言</label>
                <select
                  className="rounded border border-white/20 bg-black/40 px-2 py-1"
                  value={asrLanguage}
                  onChange={(e) => setAsrLanguage(e.target.value)}
                >
                  {ASR_LANGUAGE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <label className="text-white/60">目标语言</label>
                <select
                  className="rounded border border-white/20 bg-black/40 px-2 py-1"
                  value={targetLanguage}
                  onChange={(e) => setTargetLanguage(e.target.value)}
                >
                  {TRANSLATE_LANGUAGE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <label className="text-white/60">翻译备注</label>
                <input
                  className="rounded border border-white/20 bg-black/40 px-2 py-1"
                  placeholder="可选：人物/场景背景、术语偏好等"
                  value={translationNote}
                  onChange={(e) => setTranslationNote(e.target.value)}
                />
              </div>
              <button
                onClick={runPipeline}
                className={buttonPrimaryClasses}
                disabled={uploadMutation.isPending || asrSubmitMutation.isPending || translateMutation.isPending}
              >
                开始处理
              </button>
              <button
                onClick={resetAll}
                className="text-sm text-white/60 hover:text-white"
              >
                重置
              </button>
            </div>
            {videoFile && (
              <div className="mt-4 rounded bg-black/40 p-4 text-sm text-white/70">
                <p>文件名: {videoFile.name}</p>
                <p>大小: {(videoFile.size / (1024 * 1024)).toFixed(2)} MB</p>
              </div>
            )}
          </div>

          <div className={cardClasses}>
            <h2 className="text-lg font-semibold">2. 处理进度</h2>
            <div className="mt-4 space-y-3">
              {progress.map((step) => {
                const isActive = !!step.startedAt && !step.finishedAt;
                const isCompleted = !!step.finishedAt;
                const duration =
                  step.startedAt && step.finishedAt
                    ? `${((step.finishedAt - step.startedAt) / 1000).toFixed(1)}s`
                    : step.startedAt && !step.finishedAt
                    ? `${((Date.now() - step.startedAt) / 1000).toFixed(1)}s`
                    : '';
                return (
                  <div
                    key={step.key}
                    className="flex items-start justify-between rounded-lg border border-white/10 bg-black/40 px-4 py-3 text-sm"
                  >
                    <div>
                      <p className="font-medium">
                        {step.label}
                        {isActive && <span className="ml-2 animate-pulse text-xs text-blue-300">进行中…</span>}
                        {isCompleted && <span className="ml-2 text-xs text-emerald-300">完成</span>}
                      </p>
                      {step.extra && (
                        <div className="mt-1 space-y-1 text-xs text-white/60">
                          {Object.entries(step.extra).map(([key, value]) => (
                            <div key={key}>{key}: {value}</div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="text-xs text-white/50">{duration}</div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className={cardClasses}>
            <h2 className="text-lg font-semibold">3. 元信息</h2>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm text-white/70">
              <div>
                <dt className="text-xs text-white/40">视频格式</dt>
                <dd>{metaInfo.format ?? '未知'}</dd>
              </div>
              <div>
                <dt className="text-xs text-white/40">时长</dt>
                <dd>{parseDuration(metaInfo.duration)}</dd>
              </div>
              <div>
                <dt className="text-xs text-white/40">视频编码</dt>
                <dd>{metaInfo.videoCodec ?? '未知'}</dd>
              </div>
              <div>
                <dt className="text-xs text-white/40">音频编码</dt>
                <dd>{metaInfo.audioCodec ?? '未知'}</dd>
              </div>
            </dl>
          </div>

          <div className={cardClasses}>
            <h2 className="text-lg font-semibold">4. 字幕预览</h2>
            <div className="mt-4 flex items-center gap-3 text-sm">
              <label className="text-white/60">字号</label>
              <input
                type="range"
                min="12"
                max="32"
                value={fontSize}
                onChange={(event) => setFontSize(Number(event.target.value))}
              />
              <span>{fontSize}px</span>
            </div>
            <div className="mt-4 max-h-80 overflow-y-auto rounded border border-white/10 bg-black/60 p-4" style={{ fontSize }}>
              <pre className="whitespace-pre-wrap text-white/90">
                {previewSrt || '暂无字幕内容'}
              </pre>
            </div>
            {previewSrt && (
              <div className="mt-4 flex items-center gap-3">
                <button
                  className="rounded bg-blue-500 px-4 py-2 text-white hover:bg-blue-600"
                  onClick={() => {
                    const blob = new Blob([previewSrt], { type: 'text/plain;charset=utf-8' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `${videoName || 'subtitle'}.srt`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  下载字幕
                </button>
                <span className="text-sm text-white/60">下载文件名会根据视频名称生成</span>
              </div>
            )}
          </div>
        </section>

        <aside className="space-y-6">
          <div className="rounded-xl border border-white/10 bg-white/5 p-6">
            <h2 className="text-lg font-semibold">调试日志</h2>
            <div className="mt-4 max-h-[480px] overflow-y-auto space-y-2 text-xs">
              {logs.map((log) => (
                <div
                  key={log.id}
                  className="rounded border border-white/10 bg-black/50 p-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-white/60">{log.stage}</span>
                    <span className="text-white/40">{formatLogTime(log.timestamp)}</span>
                  </div>
                  <p
                    className={
                      log.level === 'error'
                        ? 'mt-1 text-red-300'
                        : log.level === 'warn'
                        ? 'mt-1 text-yellow-300'
                        : 'mt-1 text-white/80'
                    }
                  >
                    {log.message}
                  </p>
                </div>
              ))}
              {logs.length === 0 && <p className="text-white/40">暂无日志。</p>}
            </div>
          </div>

          <div className={cardClasses + (isDark ? ' text-sm text-white/70' : ' text-sm text-neutral-700')}>
            <h2 className={isDark ? 'text-lg font-semibold text-white' : 'text-lg font-semibold text-neutral-900'}>使用说明</h2>
            <ul className="mt-3 space-y-2 list-disc pl-4">
              <li>确保浏览器支持 WebAssembly，并允许使用本地文件。</li>
              <li>FFmpeg 初始化可能需要数秒，日志面板会实时更新。</li>
              <li>若视频自带字幕，将优先提取，不会重复调用 ASR。</li>
              <li>音频上传至 Cloudflare R2 后，会自动触发 ASR 和翻译流程。</li>
            </ul>
          </div>
        </aside>
      </main>
    </div>
  );
}


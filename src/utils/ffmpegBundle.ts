type FFmpegCtor = typeof import('@ffmpeg/ffmpeg').FFmpeg;
type FFmpegInstance = InstanceType<FFmpegCtor>;
type FFmpegUtils = typeof import('@ffmpeg/util');

type FFmpegBundle = {
  FFmpeg: FFmpegCtor;
  utils: FFmpegUtils;
};

let bundlePromise: Promise<FFmpegBundle> | null = null;

export const getFFmpegBundle = async (): Promise<FFmpegBundle> => {
  if (!bundlePromise) {
    bundlePromise = (async () => {
      const [ffmpegModule, utilModule] = await Promise.all([
        import('@ffmpeg/ffmpeg'),
        import('@ffmpeg/util'),
      ]);

      return {
        FFmpeg: ffmpegModule.FFmpeg,
        utils: utilModule,
      } as FFmpegBundle;
    })();
  }

  return bundlePromise;
};

export type { FFmpegInstance };


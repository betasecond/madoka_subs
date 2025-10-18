export type LogCallback = (payload: { message: string }) => void;

export type FFmpegInstance = {
  loaded: boolean;
  load(config: { coreURL: string; wasmURL: string }): Promise<boolean>;
  exec(args: string[]): Promise<number>;
  writeFile(path: string, data: Uint8Array | string): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array | string>;
  on(event: "log", callback: LogCallback): void;
  off(event: "log", callback: LogCallback): void;
  terminate(): void;
};

export type FFmpegModule = new () => FFmpegInstance;

export type FFmpegUtils = {
  fetchFile: (input: File | string) => Promise<Uint8Array>;
  toBlobURL: (url: string, mimeType: string) => Promise<string>;
};

export type FFmpegBundle = {
  FFmpegModule: FFmpegModule;
  utils: FFmpegUtils;
};

export const loadFFmpegModules = async (): Promise<FFmpegBundle> => {
  const [{ FFmpeg }, { fetchFile, toBlobURL }] = await Promise.all([
    import("@ffmpeg/ffmpeg"),
    import("@ffmpeg/util"),
  ]);

  return {
    FFmpegModule: FFmpeg as FFmpegModule,
    utils: {
      fetchFile,
      toBlobURL,
    },
  };
};


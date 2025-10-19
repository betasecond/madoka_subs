'use client'

import { useCallback, useRef, useState } from 'react';
import type { FFmpegInstance } from '@/utils/ffmpegBundle';
import { getFFmpegBundle } from '@/utils/ffmpegBundle';

const remoteBaseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
const localFallbackBaseURL = '/ffmpeg';
// 优先使用用户提供的外部 WASM 源，避免受本地 25MB 限制与静态资源路由影响
const externalWasmURL = 'https://assets.madokasubs.xyz/ffmpeg-core.wasm';

const formatError = (error: unknown) => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

type LogCallback = (payload: { message: string }) => void;

type LoadedResources = {
  ffmpeg: FFmpegInstance;
  fetchFile: typeof import('@ffmpeg/util').fetchFile;
  toBlobURL: typeof import('@ffmpeg/util').toBlobURL;
};

export type FFmpegResources = LoadedResources;

export const useFFmpegClient = () => {
  const resourcesRef = useRef<LoadedResources | null>(null);
  const logHandlerRef = useRef<LogCallback | null>(null);
  const [isLoaded, setLoaded] = useState(false);

  const load = useCallback(async (onLog?: (message: string) => void) => {
    const emit = (message: string) => {
      if (onLog) {
        onLog(`[FFmpeg] ${message}`);
      }
    };

    emit('执行初始化前环境检查');

    if (typeof window === 'undefined') {
      const error = new Error('当前环境缺少 window，无法加载 FFmpeg');
      emit('检测到非浏览器环境');
      throw error;
    }

    if (!('WebAssembly' in window)) {
      const error = new Error('浏览器不支持 WebAssembly');
      emit('浏览器不支持 WebAssembly');
      throw error;
    }

    if (!resourcesRef.current) {
      emit('加载 @ffmpeg/ffmpeg 与 @ffmpeg/util 模块');
      const { FFmpeg, utils } = await getFFmpegBundle().catch((error) => {
        emit(`动态导入模块失败: ${formatError(error)}`);
        throw error;
      });
      const ffmpeg = new FFmpeg();
      resourcesRef.current = {
       ffmpeg,
       fetchFile: utils.fetchFile,
       toBlobURL: utils.toBlobURL,
      };
      emit('模块加载完成，创建 FFmpeg 实例');
    }

    const { ffmpeg, toBlobURL } = resourcesRef.current;

    if (onLog) {
      if (logHandlerRef.current) {
        ffmpeg.off('log', logHandlerRef.current);
      }
      const handler: LogCallback = ({ message }) => onLog(message);
      logHandlerRef.current = handler;
      ffmpeg.on('log', handler);
    }

    if (!ffmpeg.loaded) {
      emit('开始下载 FFmpeg 核心文件');
      const loadJSFromBase = async (baseURL: string) => {
        emit(`尝试从 ${baseURL} 下载 JS 与 Worker`);
        const results = await Promise.all([
          toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
          toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, 'text/javascript'),
        ]);
        emit(`从 ${baseURL} 下载 JS 与 Worker 成功`);
        return results as [string, string];
      };

      let coreURL: string;
      let wasmURL: string;
      let workerURL: string;

      try {
        [coreURL, workerURL] = await loadJSFromBase(remoteBaseURL);
      } catch (remoteError) {
        emit(`从远端下载 JS/Worker 失败: ${formatError(remoteError)}，尝试使用本地镜像`);
        try {
          [coreURL, workerURL] = await loadJSFromBase(localFallbackBaseURL);
        } catch (localError) {
          emit(`本地镜像 JS/Worker 加载失败: ${formatError(localError)}`);
          throw localError;
        }
      }

      // 优先从外部独立域加载 WASM，避免本地 404/HTML 响应导致 "magic word" 错误
      try {
        emit(`尝试从外部地址加载 WASM: ${externalWasmURL}`);
        wasmURL = await toBlobURL(externalWasmURL, 'application/wasm');
        emit('外部 WASM 加载成功');
      } catch (externalError) {
        emit(`外部 WASM 加载失败: ${formatError(externalError)}，回退尝试从远端获取`);
        try {
          wasmURL = await toBlobURL(`${remoteBaseURL}/ffmpeg-core.wasm`, 'application/wasm');
          emit('从远端回退加载 WASM 成功');
        } catch (remoteWasmError) {
          emit(`远端 WASM 加载失败: ${formatError(remoteWasmError)}，尝试本地镜像`);
          try {
            wasmURL = await toBlobURL(`${localFallbackBaseURL}/ffmpeg-core.wasm`, 'application/wasm');
            emit('从本地镜像加载 WASM 成功');
          } catch (localWasmError) {
            emit(`本地 WASM 加载失败: ${formatError(localWasmError)}`);
            throw localWasmError;
          }
        }
      }

      try {
        await ffmpeg.load({ coreURL, wasmURL, workerURL });
        emit('FFmpeg 核心加载成功');
      } catch (error) {
        emit(`FFmpeg.load 执行失败: ${formatError(error)}`);
        throw error;
      }
      setLoaded(true);
    } else {
      setLoaded(true);
      emit('复用已有的 FFmpeg 实例');
    }

    return resourcesRef.current;
  }, []);

  const reset = useCallback(() => {
    const resources = resourcesRef.current;
    if (resources) {
      const { ffmpeg } = resources;
      if (logHandlerRef.current) {
        ffmpeg.off('log', logHandlerRef.current);
        logHandlerRef.current = null;
      }
      ffmpeg.terminate();
      resourcesRef.current = null;
    }
    setLoaded(false);
  }, []);

  return { load, reset, isLoaded };
};

export type { FFmpegInstance };


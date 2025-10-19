import { NextRequest, NextResponse } from "next/server";
import pRetry, { AbortError } from "p-retry";

const SUBMIT_ENDPOINT = "submit";
const QUERY_ENDPOINT = "query";

import { getCloudflareContext } from "@opennextjs/cloudflare";

type SubmitResponse = {
  id: string;
  message: string;
};

type QueryResponse = {
  id: string;
  status: string;
  message: string;
  data?: { srt: string };
};

const SUBMIT_HEADERS = {
  "content-type": "application/json",
};

const withBearer = (token: string) => `Bearer ${token}`;

const DEFAULT_OPTIONS = {
  use_itn: "True",
  use_capitalize: "True",
  max_lines: 1,
  words_per_line: 15,
};

type SignedUrlBucket = CloudflareEnv["AUDIO_BUCKET"] & {
  createSignedUrl: (options: { key: string; expiration?: number }) => Promise<string>;
};

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { key, language } = body as { key?: string; language?: string };

  if (!key) {
    return NextResponse.json({ error: "缺少音频标识" }, { status: 400 });
  }

  const { env } = getCloudflareContext();

  const audioObject = await env.AUDIO_BUCKET.get(key);
  if (!audioObject || !audioObject.httpMetadata?.contentType || !audioObject.body) {
    return NextResponse.json({ error: "音频对象不存在" }, { status: 404 });
  }

  const audioBucket = env.AUDIO_BUCKET as SignedUrlBucket;
  if (typeof audioBucket.createSignedUrl !== "function") {
    throw new Error("当前 R2 Bucket 不支持生成签名地址");
  }

  const signedUrl = await audioBucket.createSignedUrl({
    key,
    expiration: 60 * 60, // 1 hour
  });

  const submitUrl = new URL(
    `${env.ASR_BASE_URL.replace(/\/$/, "")}/${SUBMIT_ENDPOINT}`
  );
  const submitParams = new URLSearchParams({
    appid: env.ASR_APP_ID,
    language: language ?? "zh-CN",
  });
  Object.entries(DEFAULT_OPTIONS).forEach(([key, value]) => {
    submitParams.set(key, String(value));
  });
  submitUrl.search = submitParams.toString();

  const submitResponse = await fetch(submitUrl, {
    method: "POST",
    headers: {
      ...SUBMIT_HEADERS,
      Authorization: withBearer(env.ASR_ACCESS_TOKEN),
    },
    body: JSON.stringify({
      url: signedUrl,
    }),
  });

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    return NextResponse.json(
      { error: "ASR 提交失败", detail: errorText },
      { status: submitResponse.status }
    );
  }

  const submitResult = (await submitResponse.json()) as SubmitResponse;

  if (submitResult.message !== "Success") {
    return NextResponse.json(
      { error: "ASR 返回异常", detail: submitResult },
      { status: 500 }
    );
  }

  const jobId = submitResult.id;

  const queryUrl = `${env.ASR_BASE_URL.replace(/\/$/, "")}/${QUERY_ENDPOINT}`;
  const params = new URLSearchParams({
    appid: env.ASR_APP_ID,
    id: jobId,
  });

  const data = await pRetry(
    async () => {
      const response = await fetch(`${queryUrl}?${params.toString()}`, {
        headers: {
          Authorization: withBearer(env.ASR_ACCESS_TOKEN),
        },
      });

      if (!response.ok) {
        throw new AbortError(
          `ASR 查询失败: ${response.status} ${await response.text()}`
        );
      }

      const result = (await response.json()) as QueryResponse;

      if (result.status === "SUCCESS" && result.data?.srt) {
        return result.data.srt;
      }

      if (result.status === "FAILED") {
        throw new AbortError(`ASR 任务失败: ${result.message}`);
      }

      throw new Error(`ASR 未完成: ${result.status}`);
    },
    {
      retries: 10,
      factor: 1.5,
      minTimeout: 2000,
      maxTimeout: 10000,
    }
  );

  return NextResponse.json({ srt: data }, { status: 200 });
}


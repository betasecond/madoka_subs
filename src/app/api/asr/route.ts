import { NextRequest, NextResponse } from "next/server";
import pRetry from "p-retry";

const SUBMIT_ENDPOINT = "submit";
const QUERY_ENDPOINT = "query";

const getEnv = ({ request }: { request: Request }) => {
  const cfEnv = (request as unknown as { env?: CloudflareEnv }).env;
  if (cfEnv) return cfEnv;
  const fallback = (globalThis as unknown as { __env__?: CloudflareEnv }).__env__;
  if (!fallback) {
    throw new Error("Cloudflare 环境变量未注入");
  }
  return fallback;
};

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

const withBearer = (token: string) => `Bearer; ${token}`;

const DEFAULT_OPTIONS = {
  use_itn: "True",
  use_capitalize: "True",
  max_lines: 1,
  words_per_line: 15,
};

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { key, language } = body as { key?: string; language?: string };

  if (!key) {
    return NextResponse.json({ error: "缺少音频标识" }, { status: 400 });
  }

  const env = getEnv({ request });

  const audioObject = await env.AUDIO_BUCKET.get(key);
  if (!audioObject || !audioObject.httpMetadata?.contentType || !audioObject.body) {
    return NextResponse.json({ error: "音频对象不存在" }, { status: 404 });
  }

  const signedUrl = await env.AUDIO_BUCKET.createSignedUrl({
    key,
    expiration: 60 * 60, // 1 hour
  });

  const submitUrl = new URL(
    `${env.ASR_BASE_URL.replace(/\/$/, "")}/${SUBMIT_ENDPOINT}`
  );
  submitUrl.search = new URLSearchParams({
    appid: env.ASR_APP_ID,
    language: language ?? "zh-CN",
    ...DEFAULT_OPTIONS,
  }).toString();

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
        throw new pRetry.AbortError(
          `ASR 查询失败: ${response.status} ${await response.text()}`
        );
      }

      const result = (await response.json()) as QueryResponse;

      if (result.status === "SUCCESS" && result.data?.srt) {
        return result.data.srt;
      }

      if (result.status === "FAILED") {
        throw new pRetry.AbortError(`ASR 任务失败: ${result.message}`);
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


import { NextResponse } from "next/server";

const envGetter = ({ request }: { request: Request }) => {
  const cfEnv = (request as unknown as { env?: CloudflareEnv }).env;
  if (cfEnv) {
    return cfEnv;
  }
  const fallback = (globalThis as unknown as { __env__?: CloudflareEnv }).__env__;
  if (!fallback) {
    throw new Error("Cloudflare 环境变量未注入");
  }
  return fallback;
};

export async function GET(
  request: Request,
  context: { params: Promise<{ key: string }> }
) {
  const { key } = await context.params;
  if (!key) {
    return NextResponse.json(
      { error: "缺少音频标识" },
      { status: 400 }
    );
  }

  const env = envGetter({ request });

  try {
    const object = await env.AUDIO_BUCKET.get(key);

    if (!object || !object.body) {
      return new Response(null, { status: 404 });
    }

    const headers = new Headers();
    if (object.httpMetadata?.contentType) {
      headers.set("content-type", object.httpMetadata.contentType);
    } else {
      headers.set("content-type", "application/octet-stream");
    }
    headers.set("content-length", object.size.toString());
    if (object.httpEtag) {
      headers.set("etag", object.httpEtag);
    }

    return new Response(object.body, {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error("读取 R2 音频失败", error);
    return NextResponse.json(
      { error: "读取音频失败" },
      { status: 500 }
    );
  }
}


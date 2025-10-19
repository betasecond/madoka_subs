import { NextRequest, NextResponse } from "next/server";

const getEnv = ({ request }: { request: NextRequest }) => {
  const cfEnv = (request as unknown as { env?: CloudflareEnv }).env;
  if (cfEnv) return cfEnv;
  const fallback = (globalThis as unknown as { __env__?: CloudflareEnv }).__env__;
  if (!fallback) {
    throw new Error("Cloudflare 环境变量未注入");
  }
  return fallback;
};

const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2GB

export async function POST(request: NextRequest) {
  const body = await request.formData();
  const file = body.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "缺少文件" },
      { status: 400 }
    );
  }

  if (file.size === 0) {
    return NextResponse.json(
      { error: "文件为空" },
      { status: 400 }
    );
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: "文件超出大小限制" },
      { status: 413 }
    );
  }

  const extension = file.name.split(".").pop() ?? "bin";
  const objectKey = `${crypto.randomUUID()}.${extension}`;

  const bodyStream = file.stream();

  const env = getEnv({ request });

  await env.AUDIO_BUCKET.put(objectKey, bodyStream, {
    httpMetadata: { contentType: file.type ?? "application/octet-stream" },
  });

  return NextResponse.json({ key: objectKey }, { status: 200 });
}


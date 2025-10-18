import { NextRequest, NextResponse } from "next/server";

const getEnv = ({ request }: { request: Request }) => {
  const cfEnv = (request as unknown as { env?: CloudflareEnv }).env;
  if (cfEnv) return cfEnv;
  const fallback = (globalThis as unknown as { __env__?: CloudflareEnv }).__env__;
  if (!fallback) {
    throw new Error("Cloudflare 环境变量未注入");
  }
  return fallback;
};

type TranslateMessage = {
  role: "user";
  content: Array<
    | {
        type: "text";
        text: string;
      }
  >;
};

type TranslateRequest = {
  model: string;
  messages: TranslateMessage[];
};

type TranslateResponse = {
  choices: Array<{
    message: {
      content: Array<
        | {
            type: "text";
            text: string;
          }
      >;
    };
  }>;
};

const buildPrompt = ({
  original,
  language,
}: {
  original: string;
  language: string;
}) => `你是一名专业字幕翻译。请按照以下要求把提供的原始 SRT 字幕翻译成 ${language}：
- 保留 SRT 编号与时间轴
- 翻译文本时确保语义准确且自然
- 如有必要，可适度润色

原始 SRT 内容：
${original}`;

export async function POST(request: NextRequest) {
  const env = getEnv({ request });

  const body = (await request.json()) as {
    srt?: string;
    targetLanguage?: string;
  };

  if (!body.srt) {
    return NextResponse.json({ error: "缺少 SRT 内容" }, { status: 400 });
  }

  const targetLanguage = body.targetLanguage ?? "zh-CN";

  const payload: TranslateRequest = {
    model: env.LLM_MODEL,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: buildPrompt({ original: body.srt, language: targetLanguage }),
          },
        ],
      },
    ],
  };

  const response = await fetch(env.LLM_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${env.LLM_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const detail = await response.text();
    return NextResponse.json(
      { error: "翻译请求失败", detail },
      { status: response.status }
    );
  }

  const result = (await response.json()) as TranslateResponse;

  const text = result.choices
    .flatMap((choice) => choice.message.content)
    .map((content) => content.type === "text" ? content.text : "")
    .join("\n")
    .trim();

  return NextResponse.json({ srt: text }, { status: 200 });
}


1.目标 是能够解析用户上传的视频的元信息

2.能用ffmpeg解析出用户的字幕 跳转到4 如果没有字幕 就用ffmpeg读取音频 跳转到3

3.调用第三方服务商提供的ASR 拿到srt

4.把srt文件处理 发给大模型提供商 得到翻译后的文本

5.把翻译后的文本处理成srt/ast等格式 同时提供一些便利 比如一键调字号等

6.提供预览 可以直接复制 和 提供下载 下载的名字应当是元信息读出来的视频名字作为name

这些视频在翻译好的文本就绪后就会被删掉 因此预期可能同时只会存在qps*视频大小的存储

---


## 技术栈

- React 19 + TypeScript
- Next.js 15（SSR）
- FFmpeg.wasm 0.12.6
- @ffmpeg/util




### SSR 使用要点

- 仅在客户端初始化 FFmpeg：在使用 FFmpeg 的页面或组件顶部添加 'use client'，避免在服务端环境触发 WebAssembly 与 window 访问错误。
- 动态禁用 SSR：将需要访问浏览器 API 的内容通过动态组件禁用 SSR，确保只在客户端渲染。
- 使用 @ffmpeg/util 的 toBlobURL 从 CDN（如 unpkg）拉取 ffmpeg-core.js/ffmpeg-core.wasm，规避 CORS 与 MIME 类型问题。
- 不要在 Server Components / Route Handlers 内直接使用 FFmpeg。

示例：

```typescript
// NoSSRWrapper.tsx
import dynamic from 'next/dynamic'
import React from 'react'
const NoSSRWrapper = (props) => (<React.Fragment>{props.children}</React.Fragment>)
export default dynamic(() => Promise.resolve(NoSSRWrapper), { ssr: false })
```

```typescript
// app/page.tsx
'use client'
import NoSSRWrapper from './NoSSRWrapper'
import Home from './Home'
export default function Page() {
  return <NoSSRWrapper><Home /></NoSSRWrapper>
}
```

### 遇到的问题和解决方案

#### 问题 1: 加载过程无反馈
**现象**: 点击加载按钮后长时间无响应，控制台无日志输出
**解决**: 添加详细的调试日志和进度显示

#### 问题 2: TypeScript 类型错误
**现象**: `Property 'buffer' does not exist on type 'FileData'`
**解决**: 正确处理 FFmpeg 返回的 FileData 类型
```typescript
// 修复前
const url = URL.createObjectURL(new Blob([data.buffer], { type: 'audio/mp3' }));

// 修复后
const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'audio/mp3' }));
```

#### 问题 3: 初始化阶段耗时过长
**现象**: 在"初始化 FFmpeg"阶段停止很久
**解决**: 添加详细的初始化监控，包括：
- 浏览器兼容性检查
- 内存使用情况监控
- 实时计时器显示
- 每秒进度更新

### 核心实现

#### FFmpeg 加载过程
```typescript
const load = async () => {
  // 1. 浏览器兼容性检查
  if (!window.WebAssembly) {
    throw new Error('浏览器不支持 WebAssembly');
  }
  
  // 2. 下载核心文件
  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
  const coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript');
  const wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm');
  
  // 3. 初始化 FFmpeg (最耗时的步骤)
  await ffmpeg.load({ coreURL, wasmURL });
};
```

#### 音频提取过程
```typescript
const extractAudio = async () => {
  // 1. 写入视频文件
  await ffmpeg.writeFile('input.mp4', await fetchFile(videoFile));
  
  // 2. 执行 FFmpeg 命令
  await ffmpeg.exec(['-i', 'input.mp4', '-vn', '-acodec', 'copy', 'output.mp3']);
  
  // 3. 读取输出文件
  const data = await ffmpeg.readFile('output.mp3');
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'audio/mp3' }));
};
```

### 5. 调试功能

项目包含详细的调试日志：

- **加载阶段**: 显示下载进度和文件大小
- **初始化阶段**: 实时计时器和内存使用监控
- **处理阶段**: 每个步骤的详细状态
- **错误处理**: 完整的错误信息和堆栈跟踪

打开浏览器开发者工具的 Console 标签页可以看到完整的执行日志。


---
音频文件可以先传cf的r2 然后再作为参数传给ASR服务


--- 
需要调用的ASR服务

import time

import requests

base_url = 'https://openspeech.bytedance.com/api/v1/vc'
appid = ""
access_token = ""

language = 'zh-CN'
file_url = ''


def log_time(func):
    def wrapper(*args, **kw):
        begin_time = time.time()
        func(*args, **kw)
        print('total cost time = {time}'.format(time=time.time() - begin_time))
    return wrapper


@log_time
def main():
    response = requests.post(
                 '{base_url}/submit'.format(base_url=base_url),
                 params=dict(
                     appid=appid,
                     language=language,
                     use_itn='True',
                     use_capitalize='True',
                     max_lines=1,
                     words_per_line=15,
                 ),
                 json={
                    'url': file_url,
                 },
                 headers={
                    'content-type': 'application/json',
                    'Authorization': 'Bearer; {}'.format(access_token)
                 }
             )
    print('submit response = {}'.format(response.text))
    assert(response.status_code == 200)
    assert(response.json()['message'] == 'Success')

    job_id = response.json()['id']
    response = requests.get(
            '{base_url}/query'.format(base_url=base_url),
            params=dict(
                appid=appid,
                id=job_id,
            ),
            headers={
               'Authorization': 'Bearer; {}'.format(access_token)
            }
    )
    print('query response = {}'.format(response.json()))
    assert(response.status_code == 200)

if __name__ == '__main__':
    main()



--- 
需要调用的大模型接口
curl https://ark.cn-beijing.volces.com/api/v3/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -d $'{
    "model": "ep-20251017224124-hv6f6",
    "messages": [
        {
            "content": [
                {
                    "image_url": {
                        "url": "https://ark-project.tos-cn-beijing.ivolces.com/images/view.jpeg"
                    },
                    "type": "image_url"
                },
                {
                    "text": "图片主要讲了什么?",
                    "type": "text"
                }
            ],
            "role": "user"
        }
    ]
}'
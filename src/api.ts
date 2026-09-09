import AsyncStorage from 'expo-sqlite/kv-store'
import EventSource, { EventSourceListener } from 'react-native-sse'
import { API_BASE } from './config'

const TOKEN_KEY = 'agent_token'
const USER_KEY = 'agent_user'

export interface AuthUser {
  username: string
  nickname: string
}

// 未登录/登录过期回调（登录态失效时，由 App 订阅并跳回登录页）
type UnauthorizedHandler = () => void
let unauthorizedHandler: UnauthorizedHandler | null = null
export function onUnauthorized(handler: UnauthorizedHandler) {
  unauthorizedHandler = handler
}
function fireUnauthorized() {
  const h = unauthorizedHandler
  if (h) h()
}

export async function getToken(): Promise<string> {
  return (await AsyncStorage.getItem(TOKEN_KEY)) || ''
}

export async function saveAuth(token: string, user: AuthUser): Promise<void> {
  await AsyncStorage.multiSet([
    [TOKEN_KEY, token],
    [USER_KEY, JSON.stringify(user)],
  ])
}

export async function getStoredUser(): Promise<AuthUser | null> {
  try {
    const raw = await AsyncStorage.getItem(USER_KEY)
    return raw ? (JSON.parse(raw) as AuthUser) : null
  } catch {
    return null
  }
}

export async function clearAuth(): Promise<void> {
  await AsyncStorage.multiRemove([TOKEN_KEY, USER_KEY])
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export interface ApiOptions {
  method?: string
  body?: any
}

/** 统一请求方法：自动携带 Bearer token，统一错误处理 */
export async function api<T = any>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {}
  const token = await getToken()
  if (token) headers['Authorization'] = 'Bearer ' + token

  let body: string | FormData | undefined
  if (options.body instanceof FormData) {
    // RN fetch 识别 FormData 后自动生成 multipart boundary，绝不能手动设 Content-Type
    body = options.body
  } else if (options.body && typeof options.body !== 'string') {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }

  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: options.method || 'GET',
      headers,
      body,
    })
  } catch {
    throw new ApiError('网络连接失败', 0)
  }

  const data = await res.json().catch(() => ({} as any))

  if (res.status === 401) {
    fireUnauthorized()
    throw new ApiError(data.message || '登录已过期，请重新登录', 401)
  }
  if (!res.ok) {
    throw new ApiError(data.message || `请求失败 (${res.status})`, res.status)
  }
  return data as T
}

export interface StreamHandle {
  close: () => void
}

/**
 * 流式对话（SSE）：POST /api/chat/stream 逐 token 推送
 * 使用 react-native-sse。服务端 SSE 格式：token 走默认 event（data: 行），
 * 结束前发 event: memory，最后 data: [DONE]。
 * 注意：此库的 headers 必须是静态对象（内部 Object.entries 遍历），故先取 token 再建连接。
 */
export async function streamChat(
  message: string,
  handlers: {
    onToken: (token: string) => void
    onDone?: () => void
    onError?: (err: ApiError) => void
  },
): Promise<StreamHandle> {
  const token = await getToken()
  const es = new EventSource(`${API_BASE}/api/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // 关键：要求不压缩。若服务器 gzip 压缩 SSE，字节流里没有字面换行，
      // react-native-sse 无法识别行结束符导致解析不出 token。
      'Accept-Encoding': 'identity',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify({ message }),
    // 0 = 禁用轮询/重连，走 XHR 流式读取（LOADING 状态下增量解析），保证 token 实时到达
    pollingInterval: 0,
  })

  const msgListener: EventSourceListener = (event) => {
    if (event.type !== 'message' || event.data == null) return
    const data = String(event.data)
    if (data.includes('[DONE]')) {
      es.close()
      handlers.onDone?.()
      return
    }
    handlers.onToken(data)
  }

  const errorListener: EventSourceListener = (event) => {
    if (event.type !== 'error') return
    es.close()
    // error 可能是 ErrorEvent / TimeoutEvent / ExceptionEvent
    if (!('xhrStatus' in event)) {
      handlers.onError?.(new ApiError('连接中断，请重试', 0))
      return
    }
    const status = event.xhrStatus
    let message = '网络连接失败'
    if (status === 401) {
      fireUnauthorized()
      message = '登录已过期，请重新登录'
    } else if (status > 0) {
      message = `请求失败 (${status})`
    }
    handlers.onError?.(new ApiError(message, status))
  }

  es.addEventListener('message', msgListener)
  es.addEventListener('error', errorListener)

  return { close: () => es.close() }
}

// ==================== 技能管理 ====================

export interface Skill {
  name: string
  shortDescription: string
  detailedDescription: string
  systemPrompt: string
  builtin: boolean
  mounted: boolean
  createdBy: string
  toolNames: string[]
}

export interface SkillUploadPayload {
  name: string
  shortDescription: string
  detailedDescription: string
  systemPrompt: string
  toolNames: string[]
}

/** 技能列表（含当前用户挂载状态） */
export async function listSkills(): Promise<Skill[]> {
  const data = await api<{ skills: Skill[] }>('/api/skills')
  return data.skills || []
}

/** 内置工具名列表 */
export async function listTools(): Promise<string[]> {
  const data = await api<{ tools: string[] }>('/api/skills/tools')
  return data.tools || []
}

/** 在线表单上传技能（application/json） */
export async function uploadSkill(payload: SkillUploadPayload): Promise<{ message: string; name: string }> {
  return api('/api/skills/upload', { method: 'POST', body: payload })
}

/** 从 .json 文件上传技能（multipart，字段名 file）。RN FormData 文件对象写法：{uri,name,type} */
export async function uploadSkillFile(file: {
  uri: string
  name: string
  type?: string
}): Promise<{ message: string; name: string }> {
  const fd = new FormData()
  // RN 的 FormData.append 类型只认 string|Blob，但运行时支持 {uri,name,type}，需断言
  fd.append('file', { uri: file.uri, name: file.name, type: file.type || 'application/json' } as any)
  return api('/api/skills/upload', { method: 'POST', body: fd })
}

export async function mountSkill(skillName: string): Promise<void> {
  await api('/api/skills/mount', { method: 'POST', body: { skillName } })
}

export async function unmountSkill(skillName: string): Promise<void> {
  await api('/api/skills/unmount', { method: 'POST', body: { skillName } })
}

export async function deleteSkill(name: string): Promise<void> {
  await api(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' })
}

// ==================== 知识库（RAG 文档） ====================

export interface KnowledgeDoc {
  id: number
  docName: string
  docType: string
  chunkCount: number
  createdAt: string
}

export interface UploadFileSource {
  uri: string
  name: string
  type?: string
}

/**
 * 上传知识文档（.txt/.md）。用 XHR 而非 fetch：需要 upload.onprogress 反馈真实网络进度。
 * 进度到 100% 后到收到响应之间是服务端"切块+向量化"时间（首次可能十几秒），
 * 调用方据此切换"正在处理"阶段。
 * 注意 xhr.timeout 必须设置得足够大：Android OkHttp 默认 read timeout 10s，
 * 响应在向量化完成后才返回，不设超时会在处理阶段被误杀。
 */
export function uploadDocument(
  file: UploadFileSource,
  onProgress?: (percent: number) => void,
): Promise<{ id: number; docName: string; chunks: number }> {
  return new Promise((resolve, reject) => {
    void (async () => {
      const token = await getToken() // token 获取是 async 的，先取再建连接
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${API_BASE}/api/knowledge/upload`)
      if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token)
      xhr.timeout = 120000 // 覆盖 Android OkHttp 10s 默认 read timeout

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress?.(Math.round((e.loaded / e.total) * 100))
        }
      }

      xhr.onload = () => {
        if (xhr.status === 401) {
          fireUnauthorized()
          reject(new ApiError('登录已过期，请重新登录', 401))
          return
        }
        let data: any = {}
        try {
          data = JSON.parse(xhr.responseText)
        } catch {
          // 非 JSON 响应按错误处理
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data)
        } else {
          reject(new ApiError(data.message || `上传失败 (${xhr.status})`, xhr.status))
        }
      }
      xhr.onerror = () => reject(new ApiError('网络连接失败', 0))
      // Android OkHttp 读超时也走 onerror；这里再兜底一个 timeout 事件
      xhr.ontimeout = () => reject(new ApiError('上传超时，请重试', 0))

      const fd = new FormData()
      fd.append('file', {
        uri: file.uri,
        name: file.name,
        type: file.type || 'text/plain',
      } as any)
      xhr.send(fd)
    })()
  })
}

/** 当前用户的知识库文档列表 */
export async function listDocuments(): Promise<KnowledgeDoc[]> {
  const data = await api<{ documents: KnowledgeDoc[] }>('/api/knowledge/documents')
  return data.documents || []
}

/** 删除知识库文档 */
export async function deleteDocument(id: number): Promise<void> {
  await api(`/api/knowledge/documents/${id}`, { method: 'DELETE' })
}
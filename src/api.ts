import AsyncStorage from 'expo-sqlite/kv-store'
import EventSource from 'react-native-sse'
import { Directory, File, Paths } from 'expo-file-system'
import { API_BASE } from './config'
import { uuidv4 } from './utils/uuid'

const TOKEN_KEY = 'agent_token'
const USER_KEY = 'agent_user'

export interface AuthUser {
  username: string
  nickname: string
  /** 管理员（白名单驱动，仅控制后台入口显隐；接口仍由服务端 AdminInterceptor 兜底 403） */
  admin?: boolean
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

/** 刷新当前登录信息（昵称、管理员标志） */
export async function getMe(): Promise<{ token?: string; username: string; nickname: string; admin?: boolean }> {
  return api('/api/auth/me')
}

// ==================== 全链路 trace（P2-10） ====================

export interface ToolTrace {
  round: number
  id?: string
  name: string
  arguments?: string
  result?: string
  success: boolean
  error?: string | null
  durationMs: number
}

export interface RagSegment {
  docId?: string
  source: string
  type: string
  text: string
  score: number
  /** 命中通道：vector 语义 / keyword 关键词 / both 双路 */
  channel?: 'vector' | 'keyword' | 'both' | string
  /** Rerank 精排 raw logit（未启用精排时为空） */
  rerankScore?: number | null
}

export interface RagTrace {
  query: string
  segments: RagSegment[]
}

export interface UsageTrace {
  model?: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  rounds: number
  fallback: boolean
  cancelled: boolean
  durationMs: number
  /** 费用只以后端计算为准 */
  costYuan?: number
}

/** 历史 trace 懒加载返回（GET /api/chat/traces/{traceId}） */
export interface TraceDetail {
  traceId: string
  usage: UsageTrace
  tools: ToolTrace[]
  recalls: RagTrace[]
}

export async function getTrace(traceId: string): Promise<TraceDetail> {
  return api(`/api/chat/traces/${encodeURIComponent(traceId)}`)
}

// ==================== 高危工具人工确认（P1-6） ====================

export interface ApprovalRequestData {
  approvalId: string
  tool: string
  /** low / medium / high */
  riskLevel: string
  title: string
  argsPreview: string
  traceId?: string
  conversationId?: number
}

/** 提交高危工具审批决策（remember=true 时 backend 写会话级授权） */
export async function decideApproval(
  approvalId: string,
  approved: boolean,
  remember = false,
): Promise<{ approvalId: string; state: string; tool: string; conversationId: number; remember: boolean }> {
  return api(`/api/chat/approvals/${encodeURIComponent(approvalId)}/decision`, {
    method: 'POST',
    body: { approved, remember },
  })
}

// ==================== 多模态图片（P1-8） ====================

/** 发送图片入参：data 为不含 data: 前缀的原始 base64 */
export interface ChatImageInput {
  mimeType: string
  data: string
}

/** 历史消息图片附件（元数据；字节经 /api/chat/attachments/{id} 鉴权拉取） */
export interface ChatAttachment {
  id: number
  mimeType: string
}

/** 下载图片附件到本地缓存并返回 file:// URI（RN 无法用 Blob/objectURL 渲染鉴权资源） */
export async function downloadAttachment(id: number): Promise<string> {
  const token = await getToken()
  const dir = new Directory(Paths.cache, 'chat-images')
  if (!dir.exists) dir.create({ intermediates: true })
  const dest = new File(dir, `${id}.bin`)
  if (dest.exists) return dest.uri
  const file = await File.downloadFileAsync(`${API_BASE}/api/chat/attachments/${id}`, dest, {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
    idempotent: true,
  })
  return file.uri
}

export interface StreamHandle {
  close: () => void
}

export interface StreamChatHandlers {
  onToken: (token: string) => void
  onDone?: () => void
  onError?: (err: ApiError) => void
  onTool?: (tool: ToolTrace) => void
  onRag?: (rag: RagTrace) => void
  onUsage?: (usage: UsageTrace) => void
  onReset?: () => void
  onApproval?: (approval: ApprovalRequestData) => void
  onTraceId?: (traceId: string) => void
}

/**
 * 流式对话（SSE）：POST /api/chat/stream 逐 token 推送。
 * 使用 react-native-sse（XHR 增量解析，token 实时到达）。
 *
 * 服务端事件：
 *  - 默认事件：token 片段
 *  - event: tool / rag / usage：trace 事件
 *  - event: trace-reset：备用模型重放，清空本轮 trace
 *  - event: approval-request：高危工具审批请求
 *  - event: error：SSE 已提交后的终态业务错误（HTTP 仍 200）
 *  - event: memory / data: [DONE]：内部处理/结束标记
 *
 * 注意：该库只能读取事件流、读不到响应头，故 traceId 由客户端生成并随 X-Trace-Id 上送。
 */
export async function streamChat(
  message: string,
  conversationId: number,
  handlers: StreamChatHandlers,
  images?: ChatImageInput[],
): Promise<StreamHandle> {
  const token = await getToken()
  const traceId = uuidv4()

  const es = new EventSource<string>(`${API_BASE}/api/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // 关键：要求不压缩。若服务器 gzip 压缩 SSE，字节流里没有字面换行，
      // react-native-sse 无法识别行结束符导致解析不出 token。
      'Accept-Encoding': 'identity',
      'X-Trace-Id': traceId,
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify({
      message,
      conversationId,
      ...(images && images.length > 0 ? { images } : {}),
    }),
    // 0 = 禁用轮询/重连，走 XHR 流式读取（LOADING 状态下增量解析）
    pollingInterval: 0,
  })

  /** 注册指定命名事件（库只派发预先 addEventListener 过的类型） */
  const on = (type: string, fn: (data: string) => void) => {
    es.addEventListener(
      type as any,
      ((event: any) => {
        if (event?.data == null) return
        fn(String(event.data))
      }) as any,
    )
  }

  on('message', (data) => {
    if (data.includes('[DONE]')) {
      es.close()
      handlers.onDone?.()
      return
    }
    handlers.onToken(data)
  })
  on('tool', (d) => {
    try { handlers.onTool?.(JSON.parse(d)) } catch { /* 忽略坏事件 */ }
  })
  on('rag', (d) => {
    try { handlers.onRag?.(JSON.parse(d)) } catch { /* 忽略坏事件 */ }
  })
  on('usage', (d) => {
    try { handlers.onUsage?.(JSON.parse(d)) } catch { /* 忽略坏事件 */ }
  })
  on('trace-reset', () => handlers.onReset?.())
  on('approval-request', (d) => {
    try { handlers.onApproval?.(JSON.parse(d)) } catch { /* 忽略坏事件 */ }
  })

  const errorListener = (event: any) => {
    if (event?.type !== 'error') return
    es.close()
    // 服务端命名 error 事件（HTTP 200，带 data）→ 透传业务文案
    if (typeof event.data === 'string' && event.data) {
      let msg = '服务处理出错，请稍后重试'
      try {
        const parsed = JSON.parse(event.data) as { code?: string; message?: string }
        if (parsed.message) msg = parsed.message
      } catch { /* 坏 JSON 用默认文案 */ }
      handlers.onError?.(new ApiError(msg, 200))
      return
    }
    // XHR 层错误（含 xhrStatus）
    if (!('xhrStatus' in event)) {
      handlers.onError?.(new ApiError('连接中断，请重试', 0))
      return
    }
    const status: number = event.xhrStatus
    let message = '网络连接失败'
    if (status === 401) {
      fireUnauthorized()
      message = '登录已过期，请重新登录'
    } else if (status === 429) {
      message = '操作过于频繁或今日用量已达上限，请稍后再试'
    } else if (status > 0) {
      message = `请求失败 (${status})`
    }
    handlers.onError?.(new ApiError(message, status))
  }
  es.addEventListener('error', errorListener)

  handlers.onTraceId?.(traceId)
  return { close: () => es.close() }
}

// ==================== 多会话（conversation） ====================

export interface Conversation {
  id: number
  title: string
}

/** 会话列表（含 id=0 默认/历史会话条目，若存在遗留消息） */
export async function listConversations(): Promise<Conversation[]> {
  const data = await api<{ conversations: Conversation[] }>('/api/conversations')
  return data.conversations || []
}

/** 新建会话 */
export async function createConversation(title?: string): Promise<Conversation> {
  return api('/api/conversations', { method: 'POST', body: { title } })
}

/** 重命名会话 */
export async function renameConversation(id: number, title: string): Promise<Conversation> {
  return api(`/api/conversations/${id}`, { method: 'PATCH', body: { title } })
}

/** 删除会话（级联删除其全部消息与摘要） */
export async function deleteConversation(id: number): Promise<void> {
  await api(`/api/conversations/${id}`, { method: 'DELETE' })
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
 * 上传知识文档（txt/md/pdf/office/html）。用 XHR 而非 fetch：需要 upload.onprogress 反馈真实网络进度。
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
      xhr.timeout = 180000 // 覆盖 Android OkHttp 10s 默认 read timeout；大文件向量化更慢

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
        type: file.type || 'application/octet-stream',
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

// ==================== 用量统计（P2-10） ====================

export interface UsageTotals {
  turns: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costYuan: number
}

export interface ModelUsageRow {
  model: string
  turns: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costYuan: number
}

export interface ConversationUsageRow {
  conversationId: number
  title: string | null
  turns: number
  totalTokens: number
  costYuan: number
}

export interface UsageSummary {
  range: { from: string; to: string }
  totals: UsageTotals
  byModel: ModelUsageRow[]
  byConversation: ConversationUsageRow[]
}

/** GET /api/usage/summary?from=yyyy-MM-dd&to=yyyy-MM-dd（默认近 30 天） */
export async function getUsageSummary(from?: string, to?: string): Promise<UsageSummary> {
  const params = new URLSearchParams()
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  const qs = params.toString()
  return api(`/api/usage/summary${qs ? '?' + qs : ''}`)
}

// ==================== 回答反馈（P2-11.1） ====================

/** 某条助手消息上的反馈状态（history 接口附带） */
export interface FeedbackInfo {
  rating: number // 1=赞，-1=踩
  reasonCode?: string | null
  comment?: string | null
}

export interface FeedbackReason {
  code: string
  label: string
}

/** 点踩原因码字典 */
export async function getFeedbackReasons(): Promise<FeedbackReason[]> {
  const data = await api<{ reasons: FeedbackReason[] }>('/api/feedback/reasons')
  return data.reasons || []
}

/** 提交反馈：1=赞，-1=踩，0=取消；重复点当前评价同样按取消处理 */
export async function submitFeedback(
  traceId: string,
  rating: number,
  reasonCode?: string,
  comment?: string,
): Promise<{ traceId: string; rating: number }> {
  return api('/api/feedback', {
    method: 'POST',
    body: { traceId, rating, reasonCode, comment },
  })
}

export interface AdminFeedbackRow {
  id: number
  traceId: string
  userId: string
  conversationId: number
  conversationTitle: string
  rating: number
  reasonCode?: string | null
  reasonLabel?: string | null
  comment?: string | null
  question?: string | null
  answer?: string | null
  createdAt: string
  updatedAt: string
}

export interface AdminFeedbackPage {
  content: AdminFeedbackRow[]
  page: number
  size: number
  total: number
  totalPages: number
}

export interface FeedbackReasonStat {
  reasonCode: string | null
  reasonLabel: string | null
  count: number
}

export interface FeedbackStats {
  total: number
  up: number
  down: number
  byReason: FeedbackReasonStat[]
}

export interface FeedbackListParams {
  rating?: number
  reason?: string
  keyword?: string
  from?: string
  to?: string
  page?: number
  size?: number
}

/** 管理员分页检索反馈（GET /api/admin/feedback） */
export async function getAdminFeedback(params: FeedbackListParams = {}): Promise<AdminFeedbackPage> {
  const qs = new URLSearchParams()
  if (params.rating !== undefined) qs.set('rating', String(params.rating))
  if (params.reason) qs.set('reason', params.reason)
  if (params.keyword) qs.set('keyword', params.keyword)
  if (params.from) qs.set('from', params.from)
  if (params.to) qs.set('to', params.to)
  qs.set('page', String(params.page ?? 0))
  qs.set('size', String(params.size ?? 20))
  return api(`/api/admin/feedback?${qs.toString()}`)
}

/** 管理员反馈统计（GET /api/admin/feedback/stats） */
export async function getFeedbackStats(from?: string, to?: string): Promise<FeedbackStats> {
  const qs = new URLSearchParams()
  if (from) qs.set('from', from)
  if (to) qs.set('to', to)
  const s = qs.toString()
  return api(`/api/admin/feedback/stats${s ? '?' + s : ''}`)
}

// ==================== 定时任务（P2-9） ====================

export interface ScheduledTaskLastRun {
  status: string
  finishedAt: string
  durationMs: number
  errorMessage: string
  assistantMessageId: number
}

export interface ScheduledTask {
  id: number
  name: string
  prompt: string
  /** Spring 6 段 cron（秒 分 时 日 月 周） */
  cronExpr: string
  enabled: boolean
  /** 任务级预授权工具（勾选=该任务自动放行这些工具，无需用户确认） */
  toolsWhitelist: string[]
  /** 任务专属会话（懒创建；结果在其中查看） */
  conversationId: number | null
  nextRunAt: string | null
  lastRunAt: string | null
  createdAt: string
  updatedAt: string
  lastRun: ScheduledTaskLastRun | null
}

export interface ScheduledTaskRun {
  id: number
  /** running / success / failed / skipped_budget */
  status: string
  traceId?: string | null
  durationMs?: number | null
  errorMessage?: string | null
  startedAt?: string | null
  finishedAt?: string | null
  assistantMessageId?: number | null
}

/** 创建/更新入参（PATCH 语义：仅传要改的字段） */
export interface TaskPayload {
  name?: string
  prompt?: string
  cronExpr?: string
  toolsWhitelist?: string[]
  enabled?: boolean
}

export async function listTasks(): Promise<ScheduledTask[]> {
  const data = await api<{ tasks: ScheduledTask[] }>('/api/tasks')
  return data.tasks || []
}

export async function createTask(payload: TaskPayload): Promise<ScheduledTask> {
  return api('/api/tasks', { method: 'POST', body: payload })
}

export async function updateTask(id: number, payload: TaskPayload): Promise<ScheduledTask> {
  return api(`/api/tasks/${id}`, { method: 'PATCH', body: payload })
}

export async function deleteTask(id: number): Promise<void> {
  await api(`/api/tasks/${id}`, { method: 'DELETE' })
}

/** 立即执行（不动 next_run_at；同任务 1 分钟 1 次、计入每日上限） */
export async function runTaskNow(id: number): Promise<{ message: string }> {
  return api(`/api/tasks/${id}/run-now`, { method: 'POST' })
}

export async function listTaskRuns(id: number, page = 0, size = 20): Promise<ScheduledTaskRun[]> {
  const data = await api<{ runs: ScheduledTaskRun[] }>(`/api/tasks/${id}/runs?page=${page}&size=${size}`)
  return data.runs || []
}

// ==================== 站内通知（P2-9 M2） ====================

export interface AppNotification {
  id: number
  /** 事件类型（v1 恒为 task_result，预留扩展） */
  type: string
  title: string
  body?: string | null
  /** 点击跳转目标会话（任务专属会话） */
  targetConversationId?: number | null
  read: boolean
  createdAt: string
}

/** 游标拉取（afterId 之后的新事件，升序；离线后可补齐） */
export async function listNotifications(afterId: number, limit = 20): Promise<AppNotification[]> {
  const data = await api<{ notifications: AppNotification[] }>(
    `/api/notifications?after_id=${afterId}&limit=${limit}`,
  )
  return data.notifications || []
}

export async function markNotificationRead(id: number): Promise<void> {
  await api(`/api/notifications/${id}/read`, { method: 'POST' })
}

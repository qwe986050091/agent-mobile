import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type ListRenderItem,
} from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { api, streamChat, type Skill, type StreamHandle } from '../api'
import { useAuth } from '../auth'
import assistantAvatar from '../../assets/assistant-avatar.jpg'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

/** 根据当前时间生成问候语 */
function greetingOf(): string {
  const h = new Date().getHours()
  if (h < 5) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

export default function ChatScreen() {
  const { user, logout } = useAuth()
  const { width } = useWindowDimensions()

  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [errorTip, setErrorTip] = useState('')
  const [mountedSkills, setMountedSkills] = useState<Skill[]>([])
  const streamRef = useRef<StreamHandle | null>(null)
  const listRef = useRef<FlatList<Message>>(null)

  useEffect(() => {
    loadHistory()
    return () => streamRef.current?.close()
  }, [])

  // tab 切回聊天页时刷新已挂载技能（技能页挂载/卸载后需要同步）
  useFocusEffect(
    useCallback(() => {
      let alive = true
      api<{ skills: Skill[] }>('/api/skills')
        .then((data) => {
          if (alive) setMountedSkills((data.skills || []).filter((s) => s.mounted))
        })
        .catch(() => {
          // 技能加载失败不阻塞对话
        })
      return () => {
        alive = false
      }
    }, []),
  )

  async function loadHistory() {
    try {
      const data = await api<{ messages: Message[] }>('/api/chat/history')
      setMessages(data.messages || [])
    } catch {
      // 历史加载失败不阻塞，可继续对话
    } finally {
      setHistoryLoading(false)
    }
  }

  function appendAssistant(token: string) {
    setMessages((m) => {
      const copy = [...m]
      const last = copy[copy.length - 1]
      if (last && last.role === 'assistant') {
        copy[copy.length - 1] = { ...last, content: last.content + token }
      }
      return copy
    })
  }

  function send() {
    const text = input.trim()
    if (!text || loading) return

    setMessages((m) => [...m, { role: 'user', content: text }, { role: 'assistant', content: '' }])
    setInput('')
    setLoading(true)
    setErrorTip('')

    void streamChat(text, {
      onToken: appendAssistant,
      onDone: () => setLoading(false),
      onError: (err) => {
        if (err.status === 401) {
          logout()
          setMessages([])
        } else {
          setErrorTip(err.message)
          setMessages((m) => {
            const copy = [...m]
            const last = copy[copy.length - 1]
            if (last && last.role === 'assistant' && !last.content) {
              copy[copy.length - 1] = { ...last, content: `请求失败：${err.message}` }
            }
            return copy
          })
        }
        setLoading(false)
      },
    })
      .then((handle) => {
        streamRef.current = handle
      })
      .catch(() => setLoading(false))
  }

  function stop() {
    streamRef.current?.close()
    setLoading(false)
  }

  const displayName = user?.nickname || user?.username || '朋友'
  const isEmpty = !historyLoading && messages.length === 0

  const renderItem: ListRenderItem<Message> = ({ item }) => {
    if (item.role === 'user') {
      return (
        <View style={[styles.row, styles.rowUser]}>
          <View style={[styles.bubble, styles.bubbleUser]}>
            <Text style={styles.textUser}>{item.content}</Text>
          </View>
        </View>
      )
    }
    return (
      <View style={[styles.row, styles.rowAssistant]}>
        <Image source={assistantAvatar} style={styles.avatar} />
        <View style={[styles.bubble, styles.bubbleAssistant]}>
          <Text style={styles.textAssistant}>{item.content}</Text>
        </View>
      </View>
    )
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>
          <Text style={styles.headerDot}>● </Text>Agent AI
        </Text>
        <Pressable onPress={logout} hitSlop={10}>
          <Text style={styles.logout}>退出</Text>
        </Pressable>
      </View>

      {isEmpty ? (
        <View style={styles.welcome}>
          <View style={styles.heroWrap}>
            <View style={styles.heroHalo} />
            <Image source={assistantAvatar} style={styles.hero} />
          </View>
          <Text style={styles.greeting}>
            {greetingOf()}，{displayName}
          </Text>
          <Text style={styles.welcomeSub}>
            温柔而高效地和你对话，写东西、查资料都可以交给我
            {mountedSkills.length === 0 ? ' · 可在「技能管理」中挂载工具技能' : ''}
          </Text>
      </View>
      ) : (
        <FlatList
          ref={listRef}
          style={styles.list}
          data={messages}
          keyExtractor={(_, i) => String(i)}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          ListEmptyComponent={
            historyLoading ? <Text style={styles.tip}>加载历史消息...</Text> : null
          }
        />
      )}

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={90}
      >
        {errorTip ? <Text style={styles.errorTip}>{errorTip}</Text> : null}
        {mountedSkills.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.skillsBar}
            contentContainerStyle={styles.skillsContent}
          >
            <Text style={styles.skillsLabel}>已挂载技能</Text>
            {mountedSkills.map((s) => (
              <Pressable
                key={s.name}
                style={styles.skillChip}
                onPress={() => Alert.alert(s.name, s.shortDescription || '无描述')}
              >
                <Text style={styles.skillChipText}>{s.name}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
        <View style={[styles.composer, { maxWidth: 720 }]}>
          <TextInput
            style={styles.input}
            multiline
            value={input}
            onChangeText={setInput}
            placeholder="有问题，随便问"
            placeholderTextColor="#aab3c5"
            returnKeyType="send"
            blurOnSubmit={false}
            onSubmitEditing={() => {
              if (!input.includes('\n')) send()
            }}
          />
          <Pressable
            style={[
              styles.sendBtn,
              input.trim() && !loading ? styles.sendBtnActive : null,
            ]}
            disabled={!input.trim() || loading}
            onPress={loading ? stop : send}
          >
            <Text style={styles.sendText}>{loading ? '∥' : '↑'}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const ACCENT = '#4d86ff'

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f6f9ff' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e4ebf7',
  },
  headerTitle: { fontSize: 16, fontWeight: '700', color: '#1d2738' },
  headerDot: { color: ACCENT, fontSize: 13 },
  logout: {
    position: 'absolute',
    right: 16,
    fontSize: 14,
    color: '#8590a6',
  },
  welcome: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  heroWrap: { position: 'relative', alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  heroHalo: {
    position: 'absolute',
    width: 132,
    height: 132,
    borderRadius: 66,
    backgroundColor: 'rgba(77,134,255,0.14)',
  },
  hero: {
    width: 104,
    height: 104,
    borderRadius: 52,
    borderWidth: 4,
    borderColor: '#fff',
    shadowColor: '#4d86ff',
    shadowOpacity: 0.3,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  greeting: { fontSize: 26, fontWeight: '700', color: '#1d2738', textAlign: 'center' },
  welcomeSub: { fontSize: 14, color: '#5f6c84', marginTop: 10, textAlign: 'center', lineHeight: 21 },
  list: { flex: 1 },
  listContent: { padding: 16, paddingBottom: 8, maxWidth: 720, alignSelf: 'center', width: '100%' },
  row: { flexDirection: 'row', marginBottom: 24 },
  rowUser: { justifyContent: 'flex-end' },
  rowAssistant: { alignItems: 'flex-start' },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: '#fff',
    marginRight: 12,
    marginTop: 2,
    shadowColor: '#4d86ff',
    shadowOpacity: 0.22,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  bubble: { maxWidth: '78%', paddingHorizontal: 14, paddingVertical: 11, shadowColor: '#172b5c' },
  bubbleUser: {
    backgroundColor: ACCENT,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 6,
    shadowOpacity: 0.24,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  bubbleAssistant: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#edf2fb',
    borderTopLeftRadius: 6,
    borderTopRightRadius: 18,
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 18,
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 1,
  },
  textUser: { color: '#fff', fontSize: 15, lineHeight: 22 },
  textAssistant: { color: '#2c384c', fontSize: 15, lineHeight: 22 },
  tip: { textAlign: 'center', color: '#8590a6', marginTop: 40 },
  errorTip: { textAlign: 'center', color: '#e5484d', fontSize: 13, marginBottom: 8 },
  skillsBar: { flexGrow: 0, maxWidth: 720, alignSelf: 'center', width: '100%' },
  skillsContent: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 8, gap: 8 },
  skillsLabel: { color: '#8590a6', fontSize: 12 },
  skillChip: {
    backgroundColor: '#eef2fb',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  skillChipText: { color: '#4d86ff', fontSize: 13, fontWeight: '600' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    alignSelf: 'center',
    width: '100%',
    maxWidth: 720,
    paddingHorizontal: 12,
    paddingBottom: 10,
    gap: 8,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e4ebf7',
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    paddingRight: 52,
    fontSize: 15,
    color: '#2c384c',
    shadowColor: '#172b5c',
    shadowOpacity: 0.05,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 1,
  },
  sendBtn: {
    position: 'absolute',
    right: 16,
    bottom: 12,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#e6eaf2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnActive: { backgroundColor: ACCENT },
  sendText: { color: '#fff', fontSize: 16, fontWeight: '700', marginTop: -2 },
})
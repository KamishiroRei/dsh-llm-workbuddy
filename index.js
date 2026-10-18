/**
 * WorkBuddy (Tencent) model route for DeepSeek Harness.
 *
 * WorkBuddy speaks the OpenAI Chat Completions protocol under
 * `https://www.workbuddy.cn/v2` (the desktop client and its bundled CLI post
 * there). This adapter projects the harness message/stream vocabulary onto
 * that wire format, including streaming tool calls, so a session can route a
 * turn to WorkBuddy's models exactly like any other provider route.
 *
 * Authentication is a WorkBuddy bearer token. It is resolved per request, in
 * this order:
 *
 *   1. `config.apiKey`
 *   2. `WORKBUDDY_API_KEY` / `CODEBUDDY_AUTH_TOKEN` / `CODEBUDDY_API_KEY`
 *   3. a token file: `~/.dsh/workbuddy/token` (first non-empty line)
 *
 * Reading it per request means rotating the file takes effect on the next
 * call without restarting the harness.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-llm-workbuddy'
export const inject = ['llm']

const BASE_URL = (process.env.WORKBUDDY_BASE_URL ?? 'https://www.workbuddy.cn/v2').replace(/\/+$/, '')

/** Token files consulted when neither config nor environment supplies a key. */
const TOKEN_FILES = [
  join(homedir(), '.dsh', 'workbuddy', 'token'),
  join(homedir(), '.workbuddy', 'auth-token'),
]

/**
 * Models this route advertises, best-first.
 *
 * Only `deepseek-v3-2-volc` is verified to return streamed `tool_calls` on the
 * WorkBuddy gateway; the harness agent needs that. `deepseek-v4.1-flash`
 * streams text but answers that it cannot call tools, so it is a chat-only
 * entry. Everything after the DeepSeek pair is advertised by WorkBuddy's own
 * CLI and left unverified here.
 */
const DEFAULT_MODEL = 'deepseek-v3-2-volc'

const BUILTIN_MODELS = [
  { id: 'deepseek-v3-2-volc', name: 'DeepSeek V3.2 (Volc)', contextWindow: 131072, description: '默认模型，支持工具调用' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1000000, description: '纯对话，不支持工具调用' },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200000, description: '未验证' },
  { id: 'glm-5v-turbo', name: 'GLM-5V Turbo', contextWindow: 131072, input: ['text', 'image'], description: '未验证' },
  { id: 'glm-5.0-turbo', name: 'GLM-5.0 Turbo', contextWindow: 131072, description: '未验证' },
  { id: 'glm-5.0', name: 'GLM-5.0', contextWindow: 131072, description: '未验证' },
  { id: 'glm-4.7', name: 'GLM-4.7', contextWindow: 131072, description: '未验证' },
  { id: 'kimi-k2.5', name: 'Kimi K2.5', contextWindow: 262144, description: '未验证' },
  { id: 'minimax-m2.7', name: 'MiniMax M2.7', contextWindow: 200000, description: '未验证' },
]

const DEFAULT_CONTEXT_WINDOW = 262144
const DEFAULT_MAX_TOKENS = 32768

/** Model this route recommends when a surface needs a default; see BUILTIN_MODELS. */
export const defaultModel = DEFAULT_MODEL

function readTokenFile() {
  for (const path of TOKEN_FILES) {
    try {
      const text = readFileSync(path, 'utf8').trim()
      const line = text.split(/\r?\n/).map(part => part.trim()).find(part => part !== '')
      if (line !== undefined && line !== '') return line
    } catch {
      /* absent token file is the normal case */
    }
  }
  return ''
}

/** Resolve the bearer token for one request; an empty string means "not configured". */
function resolveToken(config) {
  const fromConfig = typeof config?.apiKey === 'string' ? config.apiKey.trim() : ''
  if (fromConfig !== '') return fromConfig
  for (const key of ['WORKBUDDY_API_KEY', 'CODEBUDDY_AUTH_TOKEN', 'CODEBUDDY_API_KEY']) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return readTokenFile()
}

function headers(token) {
  return {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: /^Bearer\s/i.test(token) ? token : `Bearer ${token}`,
    'X-Product': 'SaaS',
    'X-Domain': 'www.workbuddy.cn',
    'User-Agent': 'WorkBuddy/5.8.3 CodeBuddy/2.161.0',
  }
}

/** Flatten harness content to one text string, naming images instead of inlining them. */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'reasoning' && typeof block.text === 'string') continue
    else if (block.type === 'image') parts.push('[image attachment]')
    else if (block.type === 'file') parts.push('[file attachment]')
  }
  return parts.join('\n')
}

/** Tool calls of one assistant message, as OpenAI tool_calls entries. */
function toolCallsOf(content) {
  if (!Array.isArray(content)) return []
  const calls = []
  for (const block of content) {
    if (block?.type !== 'tool-call') continue
    calls.push({
      id: String(block.id),
      type: 'function',
      function: { name: String(block.name), arguments: typeof block.arguments === 'string' ? block.arguments : '{}' },
    })
  }
  return calls
}

/** Project one harness request onto OpenAI chat messages. */
function toChatMessages(options) {
  const messages = []
  if (typeof options?.system === 'string' && options.system !== '') {
    messages.push({ role: 'system', content: options.system })
  }
  const history = Array.isArray(options?.messages) ? options.messages : []
  for (const message of history) {
    const role = message?.role
    if (role === 'system') {
      const text = textOf(message.content)
      if (text !== '') messages.push({ role: 'system', content: text })
      continue
    }
    if (role === 'developer') {
      const text = textOf(message.content)
      if (text !== '') messages.push({ role: 'system', content: text })
      continue
    }
    if (role === 'assistant') {
      const text = textOf(message.content)
      const toolCalls = toolCallsOf(message.content)
      if (toolCalls.length > 0) {
        messages.push({ role: 'assistant', content: text === '' ? null : text, tool_calls: toolCalls })
      } else if (text !== '') {
        messages.push({ role: 'assistant', content: text })
      }
      continue
    }
    if (role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: String(message.toolCallId ?? ''),
        content: textOf(message.content),
      })
      continue
    }
    if (role === 'user') {
      const text = textOf(message.content)
      if (text !== '') messages.push({ role: 'user', content: text })
    }
  }
  return messages
}

/** Tool schemas in OpenAI function shape. */
function toTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const converted = []
  for (const tool of tools) {
    if (typeof tool?.name !== 'string' || tool.name === '') continue
    converted.push({
      type: 'function',
      function: {
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: tool.parameters ?? { type: 'object', properties: {} },
      },
    })
  }
  return converted.length === 0 ? undefined : converted
}

/** One SSE line reduced to a parsed payload, when it carries one. */
function ssePayload(line) {
  if (!line.startsWith('data:')) return undefined
  const body = line.slice(5).trim()
  if (body === '' || body === '[DONE]') return undefined
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function splitNumeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Map an OpenAI finish_reason onto the harness vocabulary (tool calls win). */
function finishReasonOf(reason, sawToolCall) {
  if (sawToolCall) return { kind: 'tool-calls' }
  if (reason === 'length') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

function usageOf(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const input = splitNumeric(usage.prompt_tokens)
  const output = splitNumeric(usage.completion_tokens)
  const cached = splitNumeric(usage.prompt_tokens_details?.cached_tokens)
  if (input === undefined && output === undefined) return undefined
  return {
    inputTokens: input === undefined ? 0 : Math.max(0, input - (cached ?? 0)),
    outputTokens: output === undefined ? 0 : output,
    ...cached === undefined ? {} : { cacheReadTokens: cached },
  }
}

function createAdapter(getToken) {
  /** Catalog entry for one model id, with capacity and description defaults applied. */
  function entryOf(model) {
    const known = BUILTIN_MODELS.find(item => item.id === model)
    return {
      provider: 'workbuddy',
      id: model,
      name: known?.name ?? model,
      ...known?.description === undefined ? {} : { description: known.description },
      contextWindow: known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
      inputModalities: known?.input ?? ['text'],
    }
  }

  return {
    providerInfo: provider => ({ id: provider, name: 'WorkBuddy' }),

    providerRetryPolicy: () => undefined,

    /** Best-first catalog: the tool-capable DeepSeek route leads. */
    listModels: () => Promise.resolve(BUILTIN_MODELS.map(model => entryOf(model.id))),

    resolveModel: (provider, model) => Promise.resolve({ ...entryOf(model), provider }),

    prepareCall: (provider, model) => Promise.resolve({
      model: { ...entryOf(model), provider },
      stream: options => stream(options),
    }),

    stream,
  }

  async function* stream(options) {
    const token = getToken()
    if (token === '') {
      throw new Error(
        'workbuddy: no token. Set the apiKey in the plugin config, WORKBUDDY_API_KEY in the environment, '
        + `or write one to ${TOKEN_FILES[0]}.`,
      )
    }

    const body = {
      model: options.model,
      messages: toChatMessages(options),
      stream: true,
    }
    const tools = toTools(options.tools)
    if (tools !== undefined) body.tools = tools
    if (typeof options.temperature === 'number') body.temperature = options.temperature
    if (typeof options.maxTokens === 'number') body.max_tokens = options.maxTokens
    if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop

    let response
    try {
      response = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify(body),
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      throw new Error(`workbuddy: request failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      const hint = response.status === 401 || response.status === 403
        ? ' (WorkBuddy rejected the token: sign in to the desktop client and refresh the token)'
        : ''
      throw new Error(`workbuddy: HTTP ${response.status}${hint}${detail === '' ? '' : `: ${detail.slice(0, 300)}`}`)
    }

    let index = 0
    let textIndex = -1
    let reasoningIndex = -1
    let text = ''
    let reasoning = ''
    let sawToolCall = false
    let finishReason = 'stop'
    /** OpenAI tool-call ordinal -> accumulated block state. */
    const toolStates = new Map()

    const decoder = new TextDecoder()
    let buffer = ''
    for await (const piece of response.body) {
      buffer += decoder.decode(piece, { stream: true })
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline).replace(/\r$/, '').trim()
        buffer = buffer.slice(newline + 1)
        if (line === '') continue

        const chunk = ssePayload(line)
        if (chunk === undefined) continue

        const choice = chunk.choices?.[0]
        const delta = choice?.delta ?? {}

        const reasoningDelta = typeof delta.reasoning_content === 'string'
          ? delta.reasoning_content
          : typeof delta.reasoning === 'string' ? delta.reasoning : ''
        if (reasoningDelta !== '') {
          if (reasoningIndex < 0) {
            reasoningIndex = index++
            yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
          }
          reasoning += reasoningDelta
          yield { type: 'reasoning-delta', index: reasoningIndex, text: reasoningDelta }
        }

        if (typeof delta.content === 'string' && delta.content !== '') {
          if (textIndex < 0) {
            textIndex = index++
            yield { type: 'block-start', index: textIndex, blockType: 'text' }
          }
          text += delta.content
          yield { type: 'text-delta', index: textIndex, text: delta.content }
        }

        for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          const ordinal = typeof call.index === 'number' ? call.index : 0
          let state = toolStates.get(ordinal)
          if (state === undefined) {
            state = { blockIndex: index++, id: '', name: '', arguments: '' }
            toolStates.set(ordinal, state)
            sawToolCall = true
            yield { type: 'block-start', index: state.blockIndex, blockType: 'tool-call' }
          }
          const id = typeof call.id === 'string' && call.id !== '' ? call.id : state.id
          const callName = typeof call.function?.name === 'string' ? call.function.name : ''
          if (id !== state.id) state.id = id
          if (callName !== '' && state.name === '') state.name = callName
          const argumentsDelta = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
          state.arguments += argumentsDelta
          yield {
            type: 'tool-call-delta',
            index: state.blockIndex,
            id: state.id,
            ...state.name === '' ? {} : { name: state.name },
            argumentsDelta,
          }
        }

        if (typeof choice?.finish_reason === 'string' && choice.finish_reason !== '') {
          finishReason = choice.finish_reason
        }

        const usage = usageOf(chunk.usage)
        if (usage !== undefined) yield { type: 'usage', usage }
      }
    }

    if (textIndex >= 0) yield { type: 'block-end', index: textIndex, block: { type: 'text', text } }
    if (reasoningIndex >= 0) yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoning } }
    for (const state of toolStates.values()) {
      yield {
        type: 'block-end',
        index: state.blockIndex,
        block: { type: 'tool-call', id: state.id, name: state.name, arguments: state.arguments },
      }
    }
    yield { type: 'finish', reason: finishReasonOf(finishReason, sawToolCall) }
  }
}

export function apply(ctx, config) {
  const getToken = () => resolveToken(config)
  ctx.llm.registerAdapter(['workbuddy'], createAdapter(getToken))
}

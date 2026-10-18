/** Small opt-in real-provider check; it never prints account credentials or unrelated model context. */
import assert from 'node:assert/strict'
import { apply } from '../index.js'

let adapter
apply({ llm: { registerAdapter: (_providers, value) => { adapter = value } } }, {})
const chunks = []
try {
  for await (const chunk of adapter.stream({ provider: 'workbuddy', model: 'deepseek-v3-2-volc', messages: [{ id: 'live', role: 'user', content: [{ type: 'text', text: 'Call acceptance_echo with value DSH_WORKBUDDY_OK. Use the tool, without any other action.' }] }], tools: [{ name: 'acceptance_echo', description: 'Echo the supplied value.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }], signal: AbortSignal.timeout(45000), maxTokens: 256 })) chunks.push(chunk)
} catch (error) {
  if (error.message.startsWith('workbuddy: no token')) { console.log('SKIP: supply WORKBUDDY_API_KEY or the documented token file'); process.exit(0) }
  throw error
}
const tool = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')?.block
assert.ok(tool, 'Real gateway did not return a tool call')
assert.equal(tool.name, 'acceptance_echo')
assert.equal(JSON.parse(tool.arguments).value, 'DSH_WORKBUDDY_OK')
console.log('PASS: real WorkBuddy gateway returned acceptance_echo with DSH_WORKBUDDY_OK')
